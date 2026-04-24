// ESM — MCP Server with all tool registrations

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "npm:zod@3";
import { runQuery, runInTransaction } from "./db.ts";
import { getEmbedding, getEmbeddings, extractMetadata, shouldSkipExtraction, getLlmConfig } from "./llm.ts";
import { classifyContent } from "./classify.ts";
import { buildContext } from "./context.ts";
import {
  schemaSetupQueries,
  createEntityQuery,
  createSignalQuery,
  createSessionQuery,
  searchQuery,
  getNodeQuery,
  traverseQuery,
  createRelationshipQuery,
  diagnosticQueries,
  captureQuery,
  updateNodeQuery,
  deleteNodeQuery,
  listQuery,
  statsQueries,
  batchCreateRelationshipsQuery,
  processingSummaryQuery,
} from "./queries.ts";
import {
  ENTITY_LABELS,
  RELATIONSHIP_TYPES,
  VECTOR_INDEXES,
} from "./types.ts";
import type { NodeLabel, CypherQuery } from "./types.ts";

/** Log full error to stderr and return a sanitized message for MCP clients. */
function safeErrorMessage(err: unknown): string {
  const msg = (err as Error).message || "Unknown error";
  console.error("ESM error:", msg);
  // TODO: restore sanitization after debugging
  return `DEBUG: ${msg}`;
  if (/fetch|openai|openrouter|embedding.*failed|API/i.test(msg)) {
    return "LLM API request failed";
  }
  if (/Missing.*KEY|Missing.*URI|Missing.*credentials/i.test(msg)) {
    return "Server configuration error — check environment variables";
  }
  // Operational errors (invalid input, not found, etc.) are safe to pass through
  return msg;
}

/** Recursively strip `embedding` keys from any object/array to keep MCP responses lean. */
function stripEmbeddings(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(stripEmbeddings);
  if (obj !== null && typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (k === "embedding") continue;
      out[k] = stripEmbeddings(v);
    }
    return out;
  }
  return obj;
}

/** Parse JSON string or pass-through object for optional properties fields. */
const propertiesSchema = (description: string) =>
  z.preprocess(
    (val) => (typeof val === "string" ? JSON.parse(val) : val),
    z.record(z.unknown()).optional()
  ).describe(description);

/** Parse JSON string or pass-through object for required properties fields. */
const requiredPropertiesSchema = (description: string) =>
  z.preprocess(
    (val) => (typeof val === "string" ? JSON.parse(val) : val),
    z.record(z.unknown())
  ).describe(description);

/** Reduce a node to compact fields for summary views. */
function compactNode(node: Record<string, unknown>): Record<string, unknown> {
  const compact: Record<string, unknown> = {};
  for (const key of ["id", "name", "labels", "status", "created_at"]) {
    if (node[key] !== undefined) compact[key] = node[key];
  }
  if (typeof node.content === "string") {
    compact.content = node.content.length > 200
      ? node.content.slice(0, 200) + "..."
      : node.content;
  }
  if (typeof node.observation === "string") {
    compact.observation = node.observation.length > 200
      ? node.observation.slice(0, 200) + "..."
      : node.observation;
  }
  return compact;
}

/** Reduce a relationship to compact fields. */
function compactRelationship(rel: Record<string, unknown>): Record<string, unknown> {
  return { type: rel.type };
}

/** Compact a full path object (from traverse). */
function compactPath(path: Record<string, unknown>): Record<string, unknown> {
  const segments = path.segments as Array<Record<string, unknown>> | undefined;
  return {
    start: compactNode(path.start as Record<string, unknown>),
    end: compactNode(path.end as Record<string, unknown>),
    segments: segments?.map((seg) => ({
      start: compactNode(seg.start as Record<string, unknown>),
      relationship: compactRelationship(seg.relationship as Record<string, unknown>),
      end: compactNode(seg.end as Record<string, unknown>),
    })),
  };
}

export function createServer(): McpServer {
  const server = new McpServer({
    name: "esm",
    version: "0.1.0",
  });

  // ─── 1. setup_schema ─────────────────────────────────────

  server.registerTool(
    "setup_schema",
    {
      title: "Setup Schema",
      description:
        "Create vector indexes and uniqueness constraints in Neo4j. Idempotent — safe to run multiple times.",
      inputSchema: {},
    },
    async () => {
      try {
        const { embeddingDimensions } = getLlmConfig();
        const queries = schemaSetupQueries(embeddingDimensions);
        const results: string[] = [];
        for (const query of queries) {
          try {
            await runQuery(query);
            const match = query.cypher.match(/(?:INDEX|CONSTRAINT)\s+(\w+)/i);
            results.push(`Created: ${match?.[1] || "item"}`);
          } catch (err: unknown) {
            const msg = (err as Error).message;
            if (msg.includes("already exists")) {
              const match = query.cypher.match(/(?:INDEX|CONSTRAINT)\s+(\w+)/i);
              results.push(`Exists: ${match?.[1] || "item"}`);
            } else {
              throw err;
            }
          }
        }
        return {
          content: [
            { type: "text" as const, text: `Schema setup complete:\n${results.join("\n")}` },
          ],
        };
      } catch (err: unknown) {
        return {
          content: [{ type: "text" as const, text: `Error: ${safeErrorMessage(err)}` }],
          isError: true,
        };
      }
    }
  );

  // ─── 2. create_entity ────────────────────────────────────

  server.registerTool(
    "create_entity",
    {
      title: "Create Entity",
      description:
        "Create any entity node (Agent, Need, Resource, Constraint, Output, Role). Auto-generates embedding and extracts metadata via LLM. Explicit properties override LLM-extracted values.",
      inputSchema: {
        entity_type: z
          .enum(ENTITY_LABELS)
          .describe("The type of entity to create"),
        name: z.string().describe("Display name for the entity"),
        content: z
          .string()
          .optional()
          .describe("Description/context — used for embedding generation"),
        properties: propertiesSchema(
            "Additional properties. Explicit values override LLM-extracted metadata."
          ),
      },
    },
    async ({ entity_type, name, content, properties }) => {
      try {
        const textForEmbedding = content || name;
        const skip = shouldSkipExtraction(entity_type as NodeLabel, properties as Record<string, unknown> | undefined);

        const [embedding, extracted] = await Promise.all([
          getEmbedding(textForEmbedding),
          skip ? Promise.resolve({}) : extractMetadata(textForEmbedding, entity_type as NodeLabel),
        ]);

        // Merge: explicit props override LLM-extracted
        const mergedProps = {
          ...extracted,
          name,
          ...(content && { content }),
          embedding,
          ...(properties || {}),
        };

        const query = createEntityQuery(entity_type, mergedProps);
        const results = await runQuery(query);
        const node = stripEmbeddings(results[0]);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(node, null, 2),
            },
          ],
        };
      } catch (err: unknown) {
        return {
          content: [{ type: "text" as const, text: `Error: ${safeErrorMessage(err)}` }],
          isError: true,
        };
      }
    }
  );

  // ─── 3. create_signal ────────────────────────────────────

  server.registerTool(
    "create_signal",
    {
      title: "Create Signal",
      description:
        "Capture an observation with optional context. Auto-creates OBSERVED_BY and optional SIGNALS + PRODUCED_IN edges in one transaction. Observer-authored fields (observation, context, how_observed, confidence, perceived_impact) are sacred — never overwritten by the system.",
      inputSchema: {
        observation: z
          .string()
          .describe("What happened, from the observer's vantage point — factual, verifiable"),
        context: z
          .string()
          .optional()
          .describe("Observer-authored situational context, circumstances, or hypotheses"),
        observed_by_agent_id: z
          .string()
          .optional()
          .describe("ID of the agent who captured this signal"),
        signals_entity_id: z
          .string()
          .optional()
          .describe("ID of the entity or product this signal is about"),
        produced_in_session_id: z
          .string()
          .optional()
          .describe("ID of the session where this was captured"),
        properties: propertiesSchema("Additional properties (how_observed, confidence, perceived_impact, disposition, disposition_note, etc.)"),
      },
    },
    async ({
      observation,
      context,
      observed_by_agent_id,
      signals_entity_id,
      produced_in_session_id,
      properties,
    }) => {
      try {
        const combinedText = context
          ? `${observation}\n\nContext: ${context}`
          : observation;

        const skip = shouldSkipExtraction("Signal" as NodeLabel, properties as Record<string, unknown> | undefined);
        const [embedding, extracted] = await Promise.all([
          getEmbedding(combinedText),
          skip ? Promise.resolve({}) : extractMetadata(combinedText, "Signal"),
        ]);

        const mergedProps = {
          ...extracted,
          observation,
          ...(context && { context }),
          content: combinedText,
          embedding,
          ...(properties || {}),
        };

        const query = createSignalQuery(
          mergedProps,
          observed_by_agent_id,
          signals_entity_id,
          produced_in_session_id
        );
        const results = await runQuery(query);

        return {
          content: [
            { type: "text" as const, text: JSON.stringify(stripEmbeddings(results[0]), null, 2) },
          ],
        };
      } catch (err: unknown) {
        return {
          content: [{ type: "text" as const, text: `Error: ${safeErrorMessage(err)}` }],
          isError: true,
        };
      }
    }
  );

  // ─── 4. create_session ───────────────────────────────────

  server.registerTool(
    "create_session",
    {
      title: "Create Session",
      description:
        "Start a session with participants, scope, trigger. Creates PARTICIPATES_IN + SCOPED_TO + TRIGGERED_BY edges.",
      inputSchema: {
        name: z.string().describe("Session name"),
        content: z
          .string()
          .optional()
          .describe("Session description / summary"),
        participant_ids: z
          .array(z.string())
          .optional()
          .describe("Agent IDs of participants"),
        scoped_to_id: z
          .string()
          .optional()
          .describe("Entity ID this session is calibrating"),
        triggered_by_signal_ids: z
          .array(z.string())
          .optional()
          .describe("Signal IDs that triggered this session"),
        properties: propertiesSchema(
            "Additional properties (session_type, trigger_type, scope_description, etc.)"
          ),
      },
    },
    async ({
      name,
      content,
      participant_ids,
      scoped_to_id,
      triggered_by_signal_ids,
      properties,
    }) => {
      try {
        const textForEmbedding = content || name;
        const skip = shouldSkipExtraction("Session" as NodeLabel, properties as Record<string, unknown> | undefined);
        const [embedding, extracted] = await Promise.all([
          getEmbedding(textForEmbedding),
          skip ? Promise.resolve({}) : extractMetadata(textForEmbedding, "Session"),
        ]);

        const mergedProps = {
          ...extracted,
          name,
          ...(content && { content }),
          embedding,
          ...(properties || {}),
        };

        const query = createSessionQuery(
          mergedProps,
          participant_ids,
          scoped_to_id,
          triggered_by_signal_ids
        );
        const results = await runQuery(query);

        return {
          content: [
            { type: "text" as const, text: JSON.stringify(stripEmbeddings(results[0]), null, 2) },
          ],
        };
      } catch (err: unknown) {
        return {
          content: [{ type: "text" as const, text: `Error: ${safeErrorMessage(err)}` }],
          isError: true,
        };
      }
    }
  );

  // ─── 5. search ───────────────────────────────────────────

  server.registerTool(
    "search",
    {
      title: "Semantic Search",
      description:
        "Semantic search across vector indexes. Search all indexes or a specific one. Returns results ranked by cosine similarity.",
      inputSchema: {
        query: z.string().describe("Natural language search query"),
        index: z
          .enum(["all", "entity", "signal", "session", "discrepancy"])
          .optional()
          .default("all")
          .describe("Which vector index to search (default: all)"),
        limit: z.number().optional().default(10).describe("Max results per index"),
        threshold: z.number().optional().default(0.5).describe("Minimum similarity score (0-1)"),
      },
    },
    async ({ query: searchText, index, limit, threshold }) => {
      try {
        const embedding = await getEmbedding(searchText);

        const indexMap: Record<string, string> = {
          entity: VECTOR_INDEXES.Entity,
          signal: VECTOR_INDEXES.Signal,
          session: VECTOR_INDEXES.Session,
          discrepancy: VECTOR_INDEXES.Discrepancy,
        };

        const indexesToSearch =
          index === "all"
            ? Object.values(indexMap)
            : [indexMap[index!]];

        const allResults: unknown[] = [];

        for (const idxName of indexesToSearch) {
          const q = searchQuery(embedding, idxName, limit, threshold);
          const results = await runQuery(q);
          allResults.push(...results);
        }

        // Sort by score descending and limit
        allResults.sort((a: unknown, b: unknown) => {
          const aScore = (a as Record<string, number>).score || 0;
          const bScore = (b as Record<string, number>).score || 0;
          return bScore - aScore;
        });

        const trimmed = allResults.slice(0, limit);

        const cleaned = stripEmbeddings(trimmed) as unknown[];

        return {
          content: [
            {
              type: "text" as const,
              text:
                cleaned.length > 0
                  ? JSON.stringify(cleaned, null, 2)
                  : "No results found.",
            },
          ],
        };
      } catch (err: unknown) {
        return {
          content: [{ type: "text" as const, text: `Error: ${safeErrorMessage(err)}` }],
          isError: true,
        };
      }
    }
  );

  // ─── 6. get_node ─────────────────────────────────────────

  server.registerTool(
    "get_node",
    {
      title: "Get Node",
      description:
        "Get a node by ID with all its relationships. Returns the node properties and connected nodes.",
      inputSchema: {
        id: z.string().describe("Node ID (UUID)"),
      },
    },
    async ({ id }) => {
      try {
        const query = getNodeQuery(id);
        const results = await runQuery(query);

        if (results.length === 0) {
          return {
            content: [{ type: "text" as const, text: `No node found with id: ${id}` }],
          };
        }

        return {
          content: [{ type: "text" as const, text: JSON.stringify(stripEmbeddings(results[0]), null, 2) }],
        };
      } catch (err: unknown) {
        return {
          content: [{ type: "text" as const, text: `Error: ${safeErrorMessage(err)}` }],
          isError: true,
        };
      }
    }
  );

  // ─── 7. traverse ─────────────────────────────────────────

  server.registerTool(
    "traverse",
    {
      title: "Graph Traversal",
      description:
        "Multi-hop graph traversal from a node. Optionally filter by relationship type(s), control depth, and direction.",
      inputSchema: {
        id: z.string().describe("Starting node ID"),
        relationship_types: z
          .array(z.enum(RELATIONSHIP_TYPES))
          .optional()
          .describe("Filter to specific relationship types"),
        max_depth: z
          .number()
          .optional()
          .default(3)
          .describe("Maximum traversal depth (1-10, default 3)"),
        direction: z
          .enum(["both", "outgoing", "incoming"])
          .optional()
          .default("both")
          .describe("Edge direction: both (default), outgoing, or incoming"),
        compact: z
          .boolean()
          .optional()
          .default(false)
          .describe("Return compact summaries (id, name, labels, status, truncated content) instead of full nodes"),
      },
    },
    async ({ id, relationship_types, max_depth, direction, compact }) => {
      try {
        const query = traverseQuery(id, relationship_types, max_depth, direction);
        const results = await runQuery(query);

        if (results.length === 0) {
          return {
            content: [
              { type: "text" as const, text: `No paths found from node: ${id}` },
            ],
          };
        }

        const cleaned = stripEmbeddings(results) as unknown[];
        const output = compact
          ? cleaned.map((item) => {
              const row = item as Record<string, unknown>;
              const path = row.path as Record<string, unknown> | undefined;
              return path ? compactPath(path) : row;
            })
          : cleaned;

        return {
          content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
        };
      } catch (err: unknown) {
        return {
          content: [{ type: "text" as const, text: `Error: ${safeErrorMessage(err)}` }],
          isError: true,
        };
      }
    }
  );

  // ─── 8. create_relationship ──────────────────────────────

  server.registerTool(
    "create_relationship",
    {
      title: "Create Relationship",
      description:
        "Create any of the 23 relationship types between two nodes with optional edge properties.",
      inputSchema: {
        from_id: z.string().describe("Source node ID"),
        to_id: z.string().describe("Target node ID"),
        relationship_type: z
          .enum(RELATIONSHIP_TYPES)
          .describe("Relationship type to create"),
        properties: propertiesSchema(
            "Edge properties (e.g. purpose_type, trust, cost for PURPOSE edges)"
          ),
      },
    },
    async ({ from_id, to_id, relationship_type, properties }) => {
      try {
        const query = createRelationshipQuery(
          from_id,
          to_id,
          relationship_type,
          properties
        );
        const results = await runQuery(query);
        const record = results[0] as Record<string, unknown>;
        const from = record.from as Record<string, unknown> | undefined;
        const to = record.to as Record<string, unknown> | undefined;
        const rel = record.r as Record<string, unknown> | undefined;

        const summary = {
          relationship_type,
          from: { id: from_id, name: from?.name, label: from?.label },
          to: { id: to_id, name: to?.name, label: to?.label },
          properties: rel ? Object.fromEntries(
            Object.entries(rel).filter(([k]) => !["id", "type"].includes(k))
          ) : {},
        };

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(summary, null, 2),
            },
          ],
        };
      } catch (err: unknown) {
        return {
          content: [{ type: "text" as const, text: `Error: ${safeErrorMessage(err)}` }],
          isError: true,
        };
      }
    }
  );

  // ─── 9. run_diagnostic ───────────────────────────────────

  server.registerTool(
    "run_diagnostic",
    {
      title: "Run Diagnostic",
      description:
        "Structural diagnostics: unattached needs, missing purpose, overloaded agents, phantom sessions, entities without purpose, unprocessed signals, ego drift check.",
      inputSchema: {
        checks: z
          .array(
            z.enum([
              "unattached_needs",
              "missing_purpose",
              "overloaded_agents",
              "phantom_sessions",
              "entities_without_purpose",
              "unprocessed_signals",
              "ego_drift_check",
              "constraint_role_analysis",
              "needs_without_resources",
              "incomplete_purpose_edges",
              "hollow_middle",
              "roles_without_needs",
              "relationships_without_purpose",
              "depleting_stocks_without_signals",
              "content_children_coherence",
              "all",
            ])
          )
          .optional()
          .default(["all"])
          .describe("Which diagnostics to run (default: all)"),
      },
    },
    async ({ checks }) => {
      try {
        const allDiagnostics = diagnosticQueries();
        const runAll = checks.includes("all");
        const findings: Record<string, unknown[]> = {};

        for (const [name, query] of Object.entries(allDiagnostics)) {
          if (runAll || checks.includes(name as never)) {
            const results = await runQuery(query);
            if (results.length > 0) {
              findings[name] = results;
            }
          }
        }

        const summary =
          Object.keys(findings).length === 0
            ? "No structural issues found."
            : JSON.stringify(stripEmbeddings(findings), null, 2);

        return {
          content: [{ type: "text" as const, text: summary }],
        };
      } catch (err: unknown) {
        return {
          content: [{ type: "text" as const, text: `Error: ${safeErrorMessage(err)}` }],
          isError: true,
        };
      }
    }
  );

  // ─── 10. delete_node ───────────────────────────────────

  server.registerTool(
    "delete_node",
    {
      title: "Delete Node",
      description:
        "Delete a node and all its relationships by ID. Use with caution — this is irreversible.",
      inputSchema: {
        id: z.string().describe("Node ID (UUID) to delete"),
      },
    },
    async ({ id }) => {
      try {
        // First fetch the node so we can confirm what was deleted
        const getQ = getNodeQuery(id);
        const existing = await runQuery(getQ);

        if (existing.length === 0) {
          return {
            content: [{ type: "text" as const, text: `No node found with id: ${id}` }],
          };
        }

        const node = stripEmbeddings(existing[0]) as Record<string, unknown>;
        const query = deleteNodeQuery(id);
        await runQuery(query);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                deleted: true,
                node: { id, name: (node.n as Record<string, unknown>)?.name, types: node.types },
              }, null, 2),
            },
          ],
        };
      } catch (err: unknown) {
        return {
          content: [{ type: "text" as const, text: `Error: ${safeErrorMessage(err)}` }],
          isError: true,
        };
      }
    }
  );

  // ─── 11. update_node ─────────────────────────────────────

  server.registerTool(
    "update_node",
    {
      title: "Update Node",
      description:
        "Update properties on an existing node by ID. Merges with existing properties (does not remove unmentioned fields). Re-generates embedding if content or name changes.",
      inputSchema: {
        id: z.string().describe("Node ID (UUID) to update"),
        properties: requiredPropertiesSchema(
            "Properties to set or update. Merged with existing — only specified fields change."
          ),
      },
    },
    async ({ id, properties }) => {
      try {
        // Verify node exists first
        const getQ = getNodeQuery(id);
        const existing = await runQuery(getQ);

        if (existing.length === 0) {
          return {
            content: [{ type: "text" as const, text: `No node found with id: ${id}` }],
            isError: true,
          };
        }

        const existingNode = (existing[0] as Record<string, unknown>).n as Record<string, unknown>;

        // Re-generate embedding if content or name changed
        const contentChanged = "content" in properties && properties.content !== existingNode.content;
        const nameChanged = "name" in properties && properties.name !== existingNode.name;

        const propsToSet = { ...properties };

        if (contentChanged || nameChanged) {
          const textForEmbedding =
            (propsToSet.content as string) ||
            (existingNode.content as string) ||
            (propsToSet.name as string) ||
            (existingNode.name as string) ||
            "";
          if (textForEmbedding) {
            propsToSet.embedding = await getEmbedding(textForEmbedding);
          }
        }

        // Prevent overwriting id or created_at
        delete propsToSet.id;
        delete propsToSet.created_at;

        const query = updateNodeQuery(id, propsToSet);
        const results = await runQuery(query);

        return {
          content: [
            { type: "text" as const, text: JSON.stringify(stripEmbeddings(results[0]), null, 2) },
          ],
        };
      } catch (err: unknown) {
        return {
          content: [{ type: "text" as const, text: `Error: ${safeErrorMessage(err)}` }],
          isError: true,
        };
      }
    }
  );

  // ─── 12. capture ────────────────────────────────────────

  server.registerTool(
    "capture",
    {
      title: "Capture",
      description:
        "Unified intake: send any content and it gets classified, embedded, and stored as the appropriate node type. Optionally provide hints to skip classification.",
      inputSchema: {
        content: z.string().describe("The content to capture — any text"),
        hints: z
          .object({
            node_type: z.string().optional().describe("Known node type to skip classification"),
            name: z.string().optional().describe("Display name for the node"),
          })
          .optional()
          .describe("Optional hints to guide classification"),
      },
    },
    async ({ content, hints }) => {
      try {
        // Phase 1: Classify
        const classification = await classifyContent(content, hints);
        const nodeType = classification.node_type === "unclassified"
          ? "Signal"
          : classification.node_type;
        const isUnclassified = classification.node_type === "unclassified";
        const name = hints?.name || classification.suggested_name;

        // Phase 2: Embed + optionally extract metadata in parallel
        const classHints = classification.hints as Record<string, unknown> || {};
        const skip = shouldSkipExtraction(nodeType as NodeLabel, classHints);
        const [embedding, extracted] = await Promise.all([
          getEmbedding(content),
          skip ? Promise.resolve({}) : extractMetadata(content, nodeType as NodeLabel),
        ]);

        // Phase 3: Build props and create node
        const mergedProps = {
          ...extracted,
          ...classification.hints,
          name,
          content,
          embedding,
        };

        const query = captureQuery(nodeType, mergedProps, isUnclassified);
        const results = await runQuery(query);
        const node = stripEmbeddings(results[0]);

        const response = {
          node,
          classification: {
            node_type: classification.node_type,
            confidence: classification.confidence,
            ...(isUnclassified && { note: "Stored as Signal with status 'needs_classification'" }),
          },
        };

        return {
          content: [
            { type: "text" as const, text: JSON.stringify(response, null, 2) },
          ],
        };
      } catch (err: unknown) {
        return {
          content: [{ type: "text" as const, text: `Error: ${safeErrorMessage(err)}` }],
          isError: true,
        };
      }
    }
  );

  // ─── 12. list ──────────────────────────────────────────

  server.registerTool(
    "list",
    {
      title: "List Nodes",
      description:
        "Browse captured nodes with optional filters by type, recency, and status.",
      inputSchema: {
        days: z.number().optional().describe("Only nodes from the last N days"),
        type: z.string().optional().describe("Filter by node label (e.g. Signal, Agent, Need)"),
        status: z.string().optional().describe("Filter by status field"),
        limit: z.number().optional().default(20).describe("Max results (default 20)"),
        compact: z
          .boolean()
          .optional()
          .default(false)
          .describe("Return compact summaries (id, name, labels, status, created_at, truncated content)"),
      },
    },
    async ({ days, type, status, limit, compact }) => {
      try {
        const query = listQuery({ days, type, status, limit, compact });
        const results = await runQuery(query);
        const cleaned = stripEmbeddings(results) as unknown[];

        const output = compact
          ? cleaned.map((row) => {
              const r = row as Record<string, unknown>;
              return { ...compactNode(r.n as Record<string, unknown>), types: r.types };
            })
          : cleaned;

        return {
          content: [
            {
              type: "text" as const,
              text: output.length > 0
                ? JSON.stringify(output, null, 2)
                : "No nodes found.",
            },
          ],
        };
      } catch (err: unknown) {
        return {
          content: [{ type: "text" as const, text: `Error: ${safeErrorMessage(err)}` }],
          isError: true,
        };
      }
    }
  );

  // ─── 13. stats ─────────────────────────────────────────

  server.registerTool(
    "stats",
    {
      title: "Graph Stats",
      description:
        "Summary statistics: node counts by type, edge counts, 7-day activity, and attention items (unprocessed signals, open needs).",
      inputSchema: {},
    },
    async () => {
      try {
        const queries = statsQueries();
        const results: Record<string, unknown> = {};

        for (const [name, query] of Object.entries(queries)) {
          results[name] = await runQuery(query);
        }

        // Reshape into structured summary
        const nodeCountsRaw = results.node_counts as Array<{ label: string; total: number }>;
        const edgeCountsRaw = results.edge_counts as Array<{ relationship_type: string; total: number }>;
        const recent7dRaw = results.recent_7_days as Array<{ label: string; total: number }>;
        const unprocessedRaw = results.unprocessed_signals as Array<{ total: number }>;
        const openNeedsRaw = results.open_needs as Array<{ total: number }>;

        const summary = {
          nodes: Object.fromEntries(
            (nodeCountsRaw || []).map((r) => [r.label, r.total])
          ),
          edges: Object.fromEntries(
            (edgeCountsRaw || []).map((r) => [r.relationship_type, r.total])
          ),
          recent_7_days: Object.fromEntries(
            (recent7dRaw || []).map((r) => [r.label, r.total])
          ),
          attention: {
            unprocessed_signals: unprocessedRaw?.[0]?.total || 0,
            open_needs: openNeedsRaw?.[0]?.total || 0,
          },
        };

        return {
          content: [
            { type: "text" as const, text: JSON.stringify(summary, null, 2) },
          ],
        };
      } catch (err: unknown) {
        return {
          content: [{ type: "text" as const, text: `Error: ${safeErrorMessage(err)}` }],
          isError: true,
        };
      }
    }
  );

  // ─── 14. get_context ───────────────────────────────────

  server.registerTool(
    "get_context",
    {
      title: "Get Context",
      description:
        "Reconstruct context around a topic or entity. Returns active threads, structural neighbors, attention items, and discoveries.",
      inputSchema: {
        query: z.string().describe("Natural language query to find relevant context"),
        entity_id: z
          .string()
          .optional()
          .describe("Anchor directly to a known entity ID instead of searching"),
        include_discoveries: z
          .boolean()
          .optional()
          .default(true)
          .describe("Include discovery suggestions (default true)"),
      },
    },
    async ({ query: queryText, entity_id, include_discoveries }) => {
      try {
        const context = await buildContext(queryText, entity_id, include_discoveries);
        const cleaned = stripEmbeddings(context);

        return {
          content: [
            { type: "text" as const, text: JSON.stringify(cleaned, null, 2) },
          ],
        };
      } catch (err: unknown) {
        return {
          content: [{ type: "text" as const, text: `Error: ${safeErrorMessage(err)}` }],
          isError: true,
        };
      }
    }
  );

  // ─── 15. batch_update_nodes ────────────────────────────────

  server.registerTool(
    "batch_update_nodes",
    {
      title: "Batch Update Nodes",
      description:
        "Update properties on multiple nodes in a single transaction. Re-generates embeddings for nodes where content or name changes. Max 50 nodes per call.",
      inputSchema: {
        updates: z.array(
          z.object({
            id: z.string().describe("Node ID (UUID) to update"),
            properties: requiredPropertiesSchema(
              "Properties to set or update. Merged with existing."
            ),
          })
        ).max(50).describe("Array of node updates (max 50)"),
      },
    },
    async ({ updates }) => {
      try {
        if (updates.length === 0) {
          return { content: [{ type: "text" as const, text: "No updates provided." }] };
        }

        // Fetch all existing nodes
        const existingResults = await Promise.all(
          updates.map((u) => runQuery(getNodeQuery(u.id)))
        );

        const missing = updates.filter((_, i) => existingResults[i].length === 0);
        if (missing.length > 0) {
          return {
            content: [{ type: "text" as const, text: `Nodes not found: ${missing.map((m) => m.id).join(", ")}` }],
            isError: true,
          };
        }

        // Determine which need re-embedding, batch into single API call
        const textsToEmbed: { index: number; text: string }[] = [];
        for (let i = 0; i < updates.length; i++) {
          const props = updates[i].properties as Record<string, unknown>;
          const existing = (existingResults[i][0] as Record<string, unknown>).n as Record<string, unknown>;
          const contentChanged = "content" in props && props.content !== existing.content;
          const nameChanged = "name" in props && props.name !== existing.name;

          if (contentChanged || nameChanged) {
            const text = (props.content as string) || (existing.content as string) ||
                         (props.name as string) || (existing.name as string) || "";
            if (text) textsToEmbed.push({ index: i, text });
          }
        }

        const batchResults = textsToEmbed.length > 0
          ? await getEmbeddings(textsToEmbed.map((t) => t.text))
          : [];

        const embeddings: (number[] | null)[] = new Array(updates.length).fill(null);
        for (let j = 0; j < textsToEmbed.length; j++) {
          embeddings[textsToEmbed[j].index] = batchResults[j];
        }

        // Build update queries
        const queries: CypherQuery[] = updates.map((u, i) => {
          const propsToSet = { ...u.properties as Record<string, unknown> };
          if (embeddings[i]) propsToSet.embedding = embeddings[i];
          delete propsToSet.id;
          delete propsToSet.created_at;
          return updateNodeQuery(u.id, propsToSet);
        });

        // Execute in single transaction
        const results = await runInTransaction(queries);

        const summaries = results.map((rows) => {
          if (rows.length === 0) return { id: "unknown", name: "unknown" };
          const row = rows[0] as Record<string, unknown>;
          const n = row.n as Record<string, unknown>;
          return { id: n?.id, name: n?.name, status: n?.status };
        });

        return {
          content: [{ type: "text" as const, text: JSON.stringify({ updated: summaries.length, nodes: summaries }, null, 2) }],
        };
      } catch (err: unknown) {
        return {
          content: [{ type: "text" as const, text: `Error: ${safeErrorMessage(err)}` }],
          isError: true,
        };
      }
    }
  );

  // ─── 16. batch_create_relationships ───────────────────────

  server.registerTool(
    "batch_create_relationships",
    {
      title: "Batch Create Relationships",
      description:
        "Create multiple relationships in a single transaction. Max 50 per call.",
      inputSchema: {
        relationships: z.array(
          z.object({
            from_id: z.string().describe("Source node ID"),
            to_id: z.string().describe("Target node ID"),
            relationship_type: z.enum(RELATIONSHIP_TYPES).describe("Relationship type"),
            properties: propertiesSchema("Optional edge properties"),
          })
        ).max(50).describe("Array of relationships to create (max 50)"),
      },
    },
    async ({ relationships }) => {
      try {
        if (relationships.length === 0) {
          return { content: [{ type: "text" as const, text: "No relationships provided." }] };
        }

        const queries = batchCreateRelationshipsQuery(
          relationships.map((r) => ({
            from_id: r.from_id,
            to_id: r.to_id,
            relationship_type: r.relationship_type,
            properties: r.properties as Record<string, unknown> | undefined,
          }))
        );

        const results = await runInTransaction(queries);
        const created = results.filter((r) => r.length > 0).length;

        return {
          content: [{ type: "text" as const, text: JSON.stringify({ created, total_requested: relationships.length }, null, 2) }],
        };
      } catch (err: unknown) {
        return {
          content: [{ type: "text" as const, text: `Error: ${safeErrorMessage(err)}` }],
          isError: true,
        };
      }
    }
  );

  // ─── 17. processing_summary ──────────────────────────────

  server.registerTool(
    "processing_summary",
    {
      title: "Processing Summary",
      description:
        "Summarize signal processing status: counts by status (resolved, dismissed, under_review, unprocessed) and disposition (additive, redundant, contradictory, unrelated). Optionally scoped to a session.",
      inputSchema: {
        session_id: z
          .string()
          .optional()
          .describe("Session ID to scope summary to (via PRODUCED_IN edge). Omit for all signals."),
      },
    },
    async ({ session_id }) => {
      try {
        const query = processingSummaryQuery(session_id);
        const results = await runQuery(query);

        if (results.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No signals found." }],
          };
        }

        const row = results[0] as Record<string, number>;
        const summary = {
          total_signals: row.total,
          by_status: {
            resolved_into_update: row.resolved,
            dismissed: row.dismissed,
            under_review: row.under_review,
            unprocessed: row.unprocessed,
          },
          by_disposition: {
            additive: row.additive,
            redundant: row.redundant,
            contradictory: row.contradictory,
            unrelated: row.unrelated,
            no_disposition: row.no_disposition,
          },
          ...(session_id && { session_id }),
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }],
        };
      } catch (err: unknown) {
        return {
          content: [{ type: "text" as const, text: `Error: ${safeErrorMessage(err)}` }],
          isError: true,
        };
      }
    }
  );

  return server;
}
