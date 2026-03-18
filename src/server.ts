// ESM — MCP Server with all tool registrations

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "npm:zod@3";
import { runQuery } from "./db.ts";
import { getEmbedding, extractMetadata, getLlmConfig } from "./llm.ts";
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
  deleteNodeQuery,
  listQuery,
  statsQueries,
} from "./queries.ts";
import {
  ENTITY_LABELS,
  RELATIONSHIP_TYPES,
  VECTOR_INDEXES,
} from "./types.ts";
import type { NodeLabel } from "./types.ts";

/** Log full error to stderr and return a sanitized message for MCP clients. */
function safeErrorMessage(err: unknown): string {
  const msg = (err as Error).message || "Unknown error";
  console.error("ESM error:", err);
  // Strip connection URIs, API responses, and file paths from client-facing messages
  if (/neo4j|bolt|connection|ECONNREFUSED|getaddrinfo/i.test(msg)) {
    return "Database connection error";
  }
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
        properties: z
          .record(z.unknown())
          .optional()
          .describe(
            "Additional properties. Explicit values override LLM-extracted metadata."
          ),
      },
    },
    async ({ entity_type, name, content, properties }) => {
      try {
        const textForEmbedding = content || name;

        // Run embedding + metadata extraction in parallel
        const [embedding, extracted] = await Promise.all([
          getEmbedding(textForEmbedding),
          extractMetadata(textForEmbedding, entity_type as NodeLabel),
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
        "Capture an observation with concrete_data + interpretation. Auto-creates OBSERVED_BY and optional SIGNALS + PRODUCED_IN edges in one transaction.",
      inputSchema: {
        concrete_data: z
          .string()
          .describe("Observable event, metric, or behavior — factual, verifiable"),
        interpretation: z
          .string()
          .optional()
          .describe("Hypothesis about what the data means"),
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
        properties: z
          .record(z.unknown())
          .optional()
          .describe("Additional properties (source_type, confidence, altitude, etc.)"),
      },
    },
    async ({
      concrete_data,
      interpretation,
      observed_by_agent_id,
      signals_entity_id,
      produced_in_session_id,
      properties,
    }) => {
      try {
        const combinedText = interpretation
          ? `${concrete_data}\n\nInterpretation: ${interpretation}`
          : concrete_data;

        const [embedding, extracted] = await Promise.all([
          getEmbedding(combinedText),
          extractMetadata(combinedText, "Signal"),
        ]);

        const mergedProps = {
          ...extracted,
          concrete_data,
          ...(interpretation && { interpretation }),
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
        properties: z
          .record(z.unknown())
          .optional()
          .describe(
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
        const [embedding, extracted] = await Promise.all([
          getEmbedding(textForEmbedding),
          extractMetadata(textForEmbedding, "Session"),
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
      },
    },
    async ({ id, relationship_types, max_depth, direction }) => {
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

        return {
          content: [{ type: "text" as const, text: JSON.stringify(stripEmbeddings(results), null, 2) }],
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
        "Create any of the 21 relationship types between two nodes with optional edge properties.",
      inputSchema: {
        from_id: z.string().describe("Source node ID"),
        to_id: z.string().describe("Target node ID"),
        relationship_type: z
          .enum(RELATIONSHIP_TYPES)
          .describe("Relationship type to create"),
        properties: z
          .record(z.unknown())
          .optional()
          .describe(
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
            : JSON.stringify(findings, null, 2);

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

  // ─── 11. capture ────────────────────────────────────────

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

        // Phase 2: Embed + extract metadata in parallel
        const [embedding, extracted] = await Promise.all([
          getEmbedding(content),
          extractMetadata(content, nodeType as NodeLabel),
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
      },
    },
    async ({ days, type, status, limit }) => {
      try {
        const query = listQuery({ days, type, status, limit });
        const results = await runQuery(query);
        const cleaned = stripEmbeddings(results) as unknown[];

        return {
          content: [
            {
              type: "text" as const,
              text: cleaned.length > 0
                ? JSON.stringify(cleaned, null, 2)
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

  return server;
}
