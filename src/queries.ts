// ESM — Cypher query builders. Returns { cypher, params } — no execution.

import type { CypherQuery, NodeLabel, RelationshipType } from "./types.ts";
import { ENTITY_LABELS } from "./types.ts";

// ─── Schema Setup ─────────────────────────────────────────────

export function schemaSetupQueries(dimensions: number = 1536): CypherQuery[] {
  return [
    // Vector indexes
    {
      cypher: `CREATE VECTOR INDEX entity_embeddings IF NOT EXISTS
FOR (n:Entity) ON (n.embedding)
OPTIONS { indexConfig: { \`vector.dimensions\`: ${dimensions}, \`vector.similarity_function\`: 'cosine' } }`,
      params: {},
    },
    {
      cypher: `CREATE VECTOR INDEX signal_embeddings IF NOT EXISTS
FOR (n:Signal) ON (n.embedding)
OPTIONS { indexConfig: { \`vector.dimensions\`: ${dimensions}, \`vector.similarity_function\`: 'cosine' } }`,
      params: {},
    },
    {
      cypher: `CREATE VECTOR INDEX session_embeddings IF NOT EXISTS
FOR (n:Session) ON (n.embedding)
OPTIONS { indexConfig: { \`vector.dimensions\`: ${dimensions}, \`vector.similarity_function\`: 'cosine' } }`,
      params: {},
    },
    {
      cypher: `CREATE VECTOR INDEX discrepancy_embeddings IF NOT EXISTS
FOR (n:Discrepancy) ON (n.embedding)
OPTIONS { indexConfig: { \`vector.dimensions\`: ${dimensions}, \`vector.similarity_function\`: 'cosine' } }`,
      params: {},
    },
    // Uniqueness constraints
    {
      cypher: `CREATE CONSTRAINT entity_id_unique IF NOT EXISTS FOR (n:Entity) REQUIRE n.id IS UNIQUE`,
      params: {},
    },
    {
      cypher: `CREATE CONSTRAINT signal_id_unique IF NOT EXISTS FOR (n:Signal) REQUIRE n.id IS UNIQUE`,
      params: {},
    },
    {
      cypher: `CREATE CONSTRAINT session_id_unique IF NOT EXISTS FOR (n:Session) REQUIRE n.id IS UNIQUE`,
      params: {},
    },
    {
      cypher: `CREATE CONSTRAINT discrepancy_id_unique IF NOT EXISTS FOR (n:Discrepancy) REQUIRE n.id IS UNIQUE`,
      params: {},
    },
    {
      cypher: `CREATE CONSTRAINT stock_id_unique IF NOT EXISTS FOR (n:Stock) REQUIRE n.id IS UNIQUE`,
      params: {},
    },
  ];
}

// ─── Entity Creation ──────────────────────────────────────────

const LABEL_MAP: Record<string, string> = {
  Agent: "Entity:Agent",
  Need: "Entity:Artifact:Need",
  Resource: "Entity:Artifact:Resource",
  Constraint: "Entity:Artifact:Constraint",
  Output: "Entity:Artifact:Output",
  Role: "Entity:Role",
};

export function createEntityQuery(
  entityType: string,
  props: Record<string, unknown>
): CypherQuery {
  const labels = LABEL_MAP[entityType];
  if (!labels) throw new Error(`Unknown entity type: ${entityType}`);

  const now = new Date().toISOString();
  const allProps = {
    ...props,
    id: props.id || crypto.randomUUID(),
    created_at: now,
    updated_at: now,
  };

  return {
    cypher: `CREATE (n:${labels} $props) RETURN n`,
    params: { props: allProps },
  };
}

// ─── Signal Creation ──────────────────────────────────────────

export function createSignalQuery(
  props: Record<string, unknown>,
  observedByAgentId?: string,
  signalsEntityId?: string,
  producedInSessionId?: string
): CypherQuery {
  const now = new Date().toISOString();
  const signalProps = {
    ...props,
    id: props.id || crypto.randomUUID(),
    status: props.status || "unprocessed",
    created_at: now,
  };

  const matchClauses: string[] = [];
  const createEdges: string[] = [];

  if (observedByAgentId) {
    matchClauses.push(`MATCH (observer:Agent {id: $observedByAgentId})`);
    createEdges.push(`CREATE (s)-[:OBSERVED_BY]->(observer)`);
  }
  if (signalsEntityId) {
    matchClauses.push(`MATCH (target {id: $signalsEntityId})`);
    createEdges.push(`CREATE (s)-[:SIGNALS]->(target)`);
  }
  if (producedInSessionId) {
    matchClauses.push(`MATCH (session:Session {id: $producedInSessionId})`);
    createEdges.push(`CREATE (s)-[:PRODUCED_IN]->(session)`);
  }

  const cypher = [
    ...matchClauses,
    `CREATE (s:Signal $signalProps)`,
    ...createEdges,
    `RETURN s`,
  ].join("\n");

  return {
    cypher,
    params: {
      signalProps,
      ...(observedByAgentId && { observedByAgentId }),
      ...(signalsEntityId && { signalsEntityId }),
      ...(producedInSessionId && { producedInSessionId }),
    },
  };
}

// ─── Session Creation ─────────────────────────────────────────

export function createSessionQuery(
  props: Record<string, unknown>,
  participantIds?: string[],
  scopedToId?: string,
  triggeredBySignalIds?: string[]
): CypherQuery {
  const now = new Date().toISOString();
  const sessionProps = {
    ...props,
    id: props.id || crypto.randomUUID(),
    status: props.status || "active",
    created_at: now,
    updated_at: now,
  };

  const parts: string[] = [`CREATE (s:Session $sessionProps)`];
  const params: Record<string, unknown> = { sessionProps };

  if (participantIds?.length) {
    parts.push(
      `WITH s`,
      `UNWIND $participantIds AS pid`,
      `MATCH (a:Agent {id: pid})`,
      `CREATE (a)-[:PARTICIPATES_IN]->(s)`
    );
    params.participantIds = participantIds;
  }

  if (scopedToId) {
    parts.push(`WITH s`, `MATCH (scope {id: $scopedToId})`, `CREATE (s)-[:SCOPED_TO]->(scope)`);
    params.scopedToId = scopedToId;
  }

  if (triggeredBySignalIds?.length) {
    parts.push(
      `WITH s`,
      `UNWIND $triggeredBySignalIds AS sid`,
      `MATCH (sig:Signal {id: sid})`,
      `CREATE (s)-[:TRIGGERED_BY]->(sig)`
    );
    params.triggeredBySignalIds = triggeredBySignalIds;
  }

  parts.push(`RETURN s`);

  return { cypher: parts.join("\n"), params };
}

// ─── Search ───────────────────────────────────────────────────

export function searchQuery(
  embedding: number[],
  indexName: string,
  limit: number,
  threshold: number
): CypherQuery {
  return {
    cypher: `CALL db.index.vector.queryNodes($indexName, $limit, $embedding)
YIELD node, score
WHERE score > $threshold
RETURN node, score, labels(node) AS types
ORDER BY score DESC`,
    params: { indexName, limit, embedding, threshold },
  };
}

// ─── Get Node ─────────────────────────────────────────────────

export function getNodeQuery(nodeId: string): CypherQuery {
  return {
    cypher: `MATCH (n {id: $nodeId})
OPTIONAL MATCH (n)-[r]-(connected)
RETURN n, labels(n) AS types,
  collect(DISTINCT {
    relationship: type(r),
    direction: CASE WHEN startNode(r) = n THEN 'outgoing' ELSE 'incoming' END,
    node: connected,
    node_labels: labels(connected),
    props: properties(r)
  }) AS relationships`,
    params: { nodeId },
  };
}

// ─── Traverse ─────────────────────────────────────────────────

export function traverseQuery(
  nodeId: string,
  relTypes?: string[],
  maxDepth: number = 3,
  direction: "both" | "outgoing" | "incoming" = "both"
): CypherQuery {
  const relFilter = relTypes?.length
    ? `:${relTypes.join("|")}`
    : "";
  const depth = Math.min(maxDepth, 10);

  const leftArrow = direction === "incoming" ? "<" : "";
  const rightArrow = direction === "outgoing" ? ">" : "";

  return {
    cypher: `MATCH path = (start {id: $nodeId})${leftArrow}-[${relFilter}*1..${depth}]-${rightArrow}(connected)
RETURN path
LIMIT 100`,
    params: { nodeId },
  };
}

// ─── Create Relationship ──────────────────────────────────────

export function createRelationshipQuery(
  fromId: string,
  toId: string,
  relType: RelationshipType,
  props?: Record<string, unknown>
): CypherQuery {
  const propsClause = props && Object.keys(props).length > 0 ? " $relProps" : "";

  return {
    cypher: `MATCH (from {id: $fromId})
MATCH (to {id: $toId})
CREATE (from)-[r:${relType}${propsClause}]->(to)
RETURN from, r, to`,
    params: {
      fromId,
      toId,
      ...(propsClause && { relProps: props }),
    },
  };
}

// ─── Diagnostics ──────────────────────────────────────────────

export function diagnosticQueries(): Record<string, CypherQuery> {
  return {
    unattached_needs: {
      cypher: `MATCH (n:Need)
WHERE NOT ()-[:CONTAINS]->(n)
RETURN n.id AS id, n.name AS name, 'Need has no parent role' AS finding`,
      params: {},
    },

    missing_purpose: {
      cypher: `MATCH (e:Entity)
WHERE NOT (e)-[:PURPOSE]->()
  AND NOT e:Stock AND NOT e:Signal AND NOT e:Session
RETURN e.id AS id, e.name AS name, labels(e) AS types, 'Entity has no purpose edge' AS finding`,
      params: {},
    },

    overloaded_agents: {
      cypher: `MATCH (a:Agent)
OPTIONAL MATCH (a)-[r]-()
WHERE r.cost IS NOT NULL
WITH a, sum(r.cost) AS total_cost
WHERE a.capacity IS NOT NULL AND total_cost > a.capacity
RETURN a.id AS id, a.name AS name, a.capacity AS capacity, total_cost, total_cost - a.capacity AS overload`,
      params: {},
    },

    phantom_sessions: {
      cypher: `MATCH (s:Session {status: 'completed'})
OPTIONAL MATCH (produced)-[:PRODUCED_IN]->(s)
WITH s, count(DISTINCT produced) AS modifications
WHERE modifications = 0
RETURN s.id AS id, s.name AS name, 'Completed session with no modifications' AS finding`,
      params: {},
    },

    entities_without_purpose: {
      cypher: `MATCH (e:Entity)
WHERE NOT (e)-[:PURPOSE]->() AND NOT (e)<-[:PURPOSE]-()
  AND NOT e:Stock AND NOT e:Signal AND NOT e:Session
RETURN e.id AS id, e.name AS name, labels(e) AS types, 'No purpose edges (giving or receiving)' AS finding`,
      params: {},
    },

    unprocessed_signals: {
      cypher: `MATCH (s:Signal {status: 'unprocessed'})
OPTIONAL MATCH (s)-[:OBSERVED_BY]->(observer:Agent)
OPTIONAL MATCH (s)-[:SIGNALS]->(target)
RETURN s.id AS id, s.concrete_data AS data, observer.name AS observer, target.name AS target
ORDER BY s.created_at`,
      params: {},
    },

    ego_drift_check: {
      cypher: `
// 1. Self-terminating purpose — agent's purpose edge loops back to itself
OPTIONAL MATCH (a:Agent)-[:FILLS]->(r:Role)-[p:PURPOSE]->(a)
WITH collect(DISTINCT CASE WHEN a IS NOT NULL THEN {
  type: 'self_terminating_purpose',
  agent_id: a.id, agent_name: a.name,
  role_id: r.id, role_name: r.name,
  finding: 'Purpose edge loops back to owning agent'
} END) AS self_loops

// 2. Asymmetric flow — agents receiving more purpose than giving
OPTIONAL MATCH (agent:Agent)
OPTIONAL MATCH (agent)-[:FILLS]->()-[out:PURPOSE]->()
OPTIONAL MATCH ()-[inc:PURPOSE]->(agent)
WITH self_loops, agent,
  count(DISTINCT out) AS outgoing,
  count(DISTINCT inc) AS incoming
WHERE incoming > 0 AND outgoing = 0
WITH self_loops, collect(DISTINCT {
  type: 'asymmetric_flow',
  agent_id: agent.id, agent_name: agent.name,
  incoming: incoming, outgoing: outgoing,
  finding: 'Agent receives purpose but serves none — net consumer'
}) AS asymmetric

// 3. Purpose edges to entities with no needs
OPTIONAL MATCH (from)-[p:PURPOSE]->(to)
WHERE NOT EXISTS { MATCH (to)<-[:CONTAINS|SCOPED_TO|FILLS]-(need:Need) }
  AND NOT EXISTS { MATCH (need:Need)-[]->(to) }
  AND NOT to:Need
WITH self_loops, asymmetric, collect(DISTINCT CASE WHEN from IS NOT NULL THEN {
  type: 'purpose_without_needs',
  from_id: from.id, from_name: from.name,
  to_id: to.id, to_name: to.name,
  finding: 'Purpose edge targets entity with no articulated needs'
} END) AS needless

// 4. Roles with no outgoing purpose
OPTIONAL MATCH (r:Role)
WHERE NOT (r)-[:PURPOSE]->()
WITH self_loops, asymmetric, needless, collect(DISTINCT CASE WHEN r IS NOT NULL THEN {
  type: 'orphaned_role',
  role_id: r.id, role_name: r.name,
  finding: 'Role has no outgoing purpose edge — does not declare who it serves'
} END) AS orphaned

WITH [item IN self_loops + asymmetric + needless + orphaned WHERE item IS NOT NULL] AS findings
UNWIND findings AS f
RETURN f.type AS check_type, f.finding AS finding,
  f.agent_id AS agent_id, f.agent_name AS agent_name,
  f.role_id AS role_id, f.role_name AS role_name,
  f.from_id AS from_id, f.from_name AS from_name,
  f.to_id AS to_id, f.to_name AS to_name,
  f.incoming AS incoming, f.outgoing AS outgoing`,
      params: {},
    },

    constraint_role_analysis: {
      cypher: `MATCH (a:Agent)-[:FILLS]->(r:Role)
MATCH (c:Constraint)-[]-(a)
WITH c, a, collect(DISTINCT {id: r.id, name: r.name}) AS roles
WHERE size(roles) > 1
RETURN c.id AS constraint_id, c.name AS constraint_name,
  c.constraint_type AS constraint_type,
  a.id AS agent_id, a.name AS agent_name,
  roles,
  size(roles) AS role_count,
  'Constraint flows through multiple roles — evaluate per-role impact (serves or undermines?)' AS finding
ORDER BY role_count DESC`,
      params: {},
    },
  };
}

// ─── Delete Node ─────────────────────────────────────────────

export function deleteNodeQuery(nodeId: string): CypherQuery {
  return {
    cypher: `MATCH (n {id: $nodeId})
DETACH DELETE n
RETURN count(*) AS deleted`,
    params: { nodeId },
  };
}

// ─── Capture (unified intake) ────────────────────────────────

export function captureQuery(
  nodeType: string,
  props: Record<string, unknown>,
  isUnclassified: boolean
): CypherQuery {
  const now = new Date().toISOString();

  // For entity types, use LABEL_MAP. For non-entity, use directly.
  if (ENTITY_LABELS.includes(nodeType as typeof ENTITY_LABELS[number])) {
    const labels = LABEL_MAP[nodeType];
    if (!labels) throw new Error(`Unknown entity type: ${nodeType}`);
    const allProps = {
      ...props,
      id: props.id || crypto.randomUUID(),
      created_at: now,
      updated_at: now,
    };
    return {
      cypher: `CREATE (n:${labels} $props) RETURN n`,
      params: { props: allProps },
    };
  }

  // Signal (default for unclassified or explicit Signal)
  if (nodeType === "Signal" || isUnclassified) {
    const signalProps = {
      ...props,
      id: props.id || crypto.randomUUID(),
      status: isUnclassified ? "needs_classification" : (props.status || "unprocessed"),
      created_at: now,
    };
    return {
      cypher: `CREATE (n:Signal $props) RETURN n`,
      params: { props: signalProps },
    };
  }

  // Session
  if (nodeType === "Session") {
    const sessionProps = {
      ...props,
      id: props.id || crypto.randomUUID(),
      status: props.status || "active",
      created_at: now,
      updated_at: now,
    };
    return {
      cypher: `CREATE (n:Session $props) RETURN n`,
      params: { props: sessionProps },
    };
  }

  // Discrepancy
  if (nodeType === "Discrepancy") {
    const discProps = {
      ...props,
      id: props.id || crypto.randomUUID(),
      lifecycle_state: props.lifecycle_state || "surfaced",
      created_at: now,
    };
    return {
      cypher: `CREATE (n:Discrepancy $props) RETURN n`,
      params: { props: discProps },
    };
  }

  // Stock
  if (nodeType === "Stock") {
    const stockProps = {
      ...props,
      id: props.id || crypto.randomUUID(),
      created_at: now,
    };
    return {
      cypher: `CREATE (n:Stock $props) RETURN n`,
      params: { props: stockProps },
    };
  }

  throw new Error(`Unknown node type: ${nodeType}`);
}

// ─── List (browsing) ─────────────────────────────────────────

export function listQuery(filters: {
  days?: number;
  type?: string;
  status?: string;
  limit?: number;
}): CypherQuery {
  const { days, type, status, limit = 20 } = filters;
  const where: string[] = [];
  const params: Record<string, unknown> = { limit: Math.floor(limit) };

  // Match all nodes with a created_at
  let matchClause = "MATCH (n)";
  if (type) {
    // Validate label contains only alphanumeric chars to prevent injection
    if (!/^[A-Za-z_]\w*$/.test(type)) throw new Error(`Invalid node type: ${type}`);
    matchClause = `MATCH (n:${type})`;
  }

  if (days) {
    where.push("n.created_at >= $since");
    const since = new Date();
    since.setDate(since.getDate() - days);
    params.since = since.toISOString();
  }

  if (status) {
    where.push("n.status = $status");
    params.status = status;
  }

  // Always filter to nodes that have created_at (skip internal nodes)
  where.push("n.created_at IS NOT NULL");

  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

  return {
    cypher: `${matchClause}
${whereClause}
RETURN n, labels(n) AS types
ORDER BY n.created_at DESC
LIMIT toInteger($limit)`,
    params,
  };
}

// ─── Stats (summary) ─────────────────────────────────────────

export function statsQueries(): Record<string, CypherQuery> {
  return {
    node_counts: {
      cypher: `MATCH (n)
WHERE n.created_at IS NOT NULL
WITH labels(n) AS lbls, count(*) AS cnt
UNWIND lbls AS label
WITH label, sum(cnt) AS total
WHERE label <> 'Entity' AND label <> 'Artifact'
RETURN label, total
ORDER BY total DESC`,
      params: {},
    },

    edge_counts: {
      cypher: `MATCH ()-[r]->()
RETURN type(r) AS relationship_type, count(*) AS total
ORDER BY total DESC`,
      params: {},
    },

    recent_7_days: {
      cypher: `MATCH (n)
WHERE n.created_at >= $since AND n.created_at IS NOT NULL
WITH labels(n) AS lbls, count(*) AS cnt
UNWIND lbls AS label
WITH label, sum(cnt) AS total
WHERE label <> 'Entity' AND label <> 'Artifact'
RETURN label, total
ORDER BY total DESC`,
      params: { since: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString() },
    },

    unprocessed_signals: {
      cypher: `MATCH (s:Signal)
WHERE s.status IN ['unprocessed', 'needs_classification']
RETURN count(*) AS total`,
      params: {},
    },

    open_needs: {
      cypher: `MATCH (n:Need)
WHERE n.lifecycle_state = 'open' OR n.lifecycle_state IS NULL
RETURN count(*) AS total`,
      params: {},
    },
  };
}

// ─── Context Query Builders ──────────────────────────────────

export function activeSessionsForEntitiesQuery(entityIds: string[]): CypherQuery {
  return {
    cypher: `MATCH (s:Session {status: 'active'})
WHERE EXISTS {
  MATCH (s)-[:SCOPED_TO]->(e)
  WHERE e.id IN $entityIds
} OR EXISTS {
  MATCH (a)-[:PARTICIPATES_IN]->(s)
  WHERE a.id IN $entityIds
}
OPTIONAL MATCH (s)-[:SCOPED_TO]->(scope)
OPTIONAL MATCH (participant)-[:PARTICIPATES_IN]->(s)
RETURN s { .id, .name, .status, .session_type, .scope_description, .created_at } AS session,
  scope.name AS scope_name, collect(DISTINCT participant.name) AS participants`,
    params: { entityIds },
  };
}

export function openNeedsForEntitiesQuery(entityIds: string[]): CypherQuery {
  return {
    cypher: `MATCH (n:Need)
WHERE (n.lifecycle_state = 'open' OR n.lifecycle_state IS NULL)
AND EXISTS {
  MATCH (n)-[]-(e)
  WHERE e.id IN $entityIds
}
RETURN n { .id, .name, .content, .lifecycle_state, .origin, .created_at } AS need`,
    params: { entityIds },
  };
}

export function unprocessedSignalsForEntitiesQuery(entityIds: string[]): CypherQuery {
  return {
    cypher: `MATCH (s:Signal)
WHERE s.status IN ['unprocessed', 'needs_classification']
AND EXISTS {
  MATCH (s)-[:SIGNALS]->(e)
  WHERE e.id IN $entityIds
}
OPTIONAL MATCH (s)-[:OBSERVED_BY]->(observer)
RETURN s { .id, concrete_data: left(s.concrete_data, 200), interpretation: left(s.interpretation, 200), .confidence, .status, .created_at } AS signal,
  observer.name AS observer_name`,
    params: { entityIds },
  };
}

export function attentionItemsQuery(entityIds: string[]): CypherQuery {
  return {
    cypher: `OPTIONAL MATCH (stock:Stock)-[:HAS_STOCK]-(e)
WHERE e.id IN $entityIds AND stock.trend = 'depleting'
WITH collect(DISTINCT CASE WHEN stock IS NOT NULL THEN {type: 'depleting_stock', name: stock.name, id: stock.id, level: stock.level, max: stock.max} END) AS raw_stocks
WITH [s IN raw_stocks WHERE s IS NOT NULL] AS stocks
OPTIONAL MATCH (sig:Signal)
WHERE sig.status IN ['unprocessed', 'needs_classification']
  AND sig.created_at < $staleThreshold
WITH stocks, collect(DISTINCT CASE WHEN sig IS NOT NULL THEN {type: 'stale_signal', id: sig.id, data: left(sig.concrete_data, 200), created_at: sig.created_at} END) AS raw_stale
WITH stocks, [s IN raw_stale WHERE s IS NOT NULL] AS stale
RETURN stocks + stale AS attention_items`,
    params: {
      entityIds,
      staleThreshold: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
    },
  };
}

export function structuralNeighborsQuery(entityIds: string[]): CypherQuery {
  return {
    cypher: `MATCH (start)
WHERE start.id IN $entityIds
MATCH path = (start)-[*1..2]-(connected)
WHERE connected.id <> start.id
WITH DISTINCT connected, labels(connected) AS types,
  [r IN relationships(path) | type(r)] AS via_relationships
RETURN connected { .id, .name, content: left(connected.content, 200), .status, .created_at } AS connected,
  types, via_relationships
LIMIT 30`,
    params: { entityIds },
  };
}
