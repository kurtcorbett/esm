// ESM — Context reconstruction from graph anchors

import { runQuery } from "./db.ts";
import { getEmbedding } from "./llm.ts";
import { searchQuery } from "./queries.ts";
import {
  activeSessionsForEntitiesQuery,
  openNeedsForEntitiesQuery,
  unprocessedSignalsForEntitiesQuery,
  attentionItemsQuery,
  structuralNeighborsQuery,
} from "./queries.ts";
import { VECTOR_INDEXES } from "./types.ts";

interface ContextPackage {
  anchors: Array<{ id: string; name?: string; types: string[]; score?: number }>;
  active_threads: {
    sessions: unknown[];
    open_needs: unknown[];
    unprocessed_signals: unknown[];
  };
  structural_context: unknown[];
  attention_items: unknown[];
  discoveries: unknown[];
}

export async function buildContext(
  query: string,
  entityId?: string,
  includeDiscoveries: boolean = true
): Promise<ContextPackage> {
  // Phase 1: Resolve anchors
  let anchorIds: string[];
  let anchors: ContextPackage["anchors"];

  if (entityId) {
    // Direct anchor — use provided entity
    anchorIds = [entityId];
    anchors = [{ id: entityId, types: [] }];
  } else {
    // Semantic search for top 3 matching entities
    const embedding = await getEmbedding(query);
    const q = searchQuery(embedding, VECTOR_INDEXES.Entity, 3, 0.5);
    const results = await runQuery<Record<string, unknown>>(q);

    anchors = results.map((r) => {
      const node = r.node as Record<string, unknown>;
      return {
        id: node.id as string,
        name: node.name as string | undefined,
        types: (r.types as string[]) || [],
        score: r.score as number,
      };
    });
    anchorIds = anchors.map((a) => a.id);
  }

  if (anchorIds.length === 0) {
    return {
      anchors: [],
      active_threads: { sessions: [], open_needs: [], unprocessed_signals: [] },
      structural_context: [],
      attention_items: [],
      discoveries: [],
    };
  }

  // Phase 2: Parallel query groups from anchors
  const [sessions, openNeeds, signals, attention, neighbors] = await Promise.all([
    runQuery(activeSessionsForEntitiesQuery(anchorIds)),
    runQuery(openNeedsForEntitiesQuery(anchorIds)),
    runQuery(unprocessedSignalsForEntitiesQuery(anchorIds)),
    runQuery(attentionItemsQuery(anchorIds)),
    runQuery(structuralNeighborsQuery(anchorIds)),
  ]);

  // Phase 3: Discoveries (lightweight for Phase 1)
  // Flag items from structural neighbors that are semantically distant from the query
  let discoveries: unknown[] = [];
  if (includeDiscoveries && neighbors.length > 0) {
    const embedding = await getEmbedding(query);
    // Search signals index for semantically related content
    const signalResults = await runQuery<Record<string, unknown>>(
      searchQuery(embedding, VECTOR_INDEXES.Signal, 5, 0.3)
    );

    // Find signals that are structurally close (connected to anchors) but had low search scores
    const neighborIds = new Set(
      neighbors.map((n) => {
        const node = n as Record<string, unknown>;
        const connected = node.connected as Record<string, unknown>;
        return connected?.id as string;
      }).filter(Boolean)
    );

    discoveries = signalResults
      .filter((r) => {
        const node = r.node as Record<string, unknown>;
        const score = r.score as number;
        // Structurally close but semantically distant = discovery
        return neighborIds.has(node.id as string) && score < 0.6;
      })
      .map((r) => {
        const node = r.node as Record<string, unknown>;
        return {
          id: node.id,
          type: "structural_proximity",
          name: node.name || node.observation || node.concrete_data,
          score: r.score,
          note: "Structurally connected to anchor but semantically distant from query",
        };
      });
  }

  // Extract attention items from the nested result
  const attentionItems = attention.length > 0
    ? ((attention[0] as Record<string, unknown>).attention_items as unknown[] || [])
    : [];

  return {
    anchors,
    active_threads: {
      sessions,
      open_needs: openNeeds,
      unprocessed_signals: signals,
    },
    structural_context: neighbors,
    attention_items: attentionItems,
    discoveries,
  };
}
