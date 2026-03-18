// Unit tests for Phase 1 query builders
// Run: deno test src/queries_test.ts

import { assertEquals, assertStringIncludes, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  captureQuery,
  deleteNodeQuery,
  listQuery,
  statsQueries,
  schemaSetupQueries,
  activeSessionsForEntitiesQuery,
  openNeedsForEntitiesQuery,
  unprocessedSignalsForEntitiesQuery,
  attentionItemsQuery,
  structuralNeighborsQuery,
} from "./queries.ts";

// ─── schemaSetupQueries ──────────────────────────────────────

Deno.test("schemaSetupQueries — default dimensions is 1536", () => {
  const queries = schemaSetupQueries();
  for (const q of queries) {
    if (q.cypher.includes("VECTOR INDEX")) {
      assertStringIncludes(q.cypher, "1536");
    }
  }
});

Deno.test("schemaSetupQueries — custom dimensions propagates to all vector indexes", () => {
  const queries = schemaSetupQueries(768);
  const vectorQueries = queries.filter((q) => q.cypher.includes("VECTOR INDEX"));
  assertEquals(vectorQueries.length, 4);
  for (const q of vectorQueries) {
    assertStringIncludes(q.cypher, "768");
    assertEquals(q.cypher.includes("1536"), false, "Should not contain default 1536");
  }
});

// ─── captureQuery ────────────────────────────────────────────

Deno.test("captureQuery — entity type routes through LABEL_MAP", () => {
  const q = captureQuery("Agent", { name: "Test Agent" }, false);
  assertStringIncludes(q.cypher, "Entity:Agent");
  assertStringIncludes(q.cypher, "CREATE");
  const props = q.params.props as Record<string, unknown>;
  assertEquals(props.name, "Test Agent");
  assertEquals(typeof props.id, "string");
  assertEquals(typeof props.created_at, "string");
});

Deno.test("captureQuery — Need gets Entity:Artifact:Need label", () => {
  const q = captureQuery("Need", { name: "Test Need", content: "something" }, false);
  assertStringIncludes(q.cypher, "Entity:Artifact:Need");
});

Deno.test("captureQuery — Signal type creates Signal node", () => {
  const q = captureQuery("Signal", { concrete_data: "test" }, false);
  assertStringIncludes(q.cypher, "CREATE (n:Signal");
  const props = q.params.props as Record<string, unknown>;
  assertEquals(props.status, "unprocessed");
});

Deno.test("captureQuery — unclassified sets needs_classification status", () => {
  const q = captureQuery("Signal", { concrete_data: "test" }, true);
  const props = q.params.props as Record<string, unknown>;
  assertEquals(props.status, "needs_classification");
});

Deno.test("captureQuery — Session gets default active status", () => {
  const q = captureQuery("Session", { name: "Test Session" }, false);
  assertStringIncludes(q.cypher, "CREATE (n:Session");
  const props = q.params.props as Record<string, unknown>;
  assertEquals(props.status, "active");
});

Deno.test("captureQuery — Discrepancy gets default surfaced state", () => {
  const q = captureQuery("Discrepancy", { content: "gap found" }, false);
  assertStringIncludes(q.cypher, "CREATE (n:Discrepancy");
  const props = q.params.props as Record<string, unknown>;
  assertEquals(props.lifecycle_state, "surfaced");
});

Deno.test("captureQuery — Stock creates Stock node", () => {
  const q = captureQuery("Stock", { name: "Trust", level: 5 }, false);
  assertStringIncludes(q.cypher, "CREATE (n:Stock");
  const props = q.params.props as Record<string, unknown>;
  assertEquals(props.level, 5);
});

Deno.test("captureQuery — unknown type throws", () => {
  assertThrows(
    () => captureQuery("Bogus", {}, false),
    Error,
    "Unknown node type"
  );
});

Deno.test("captureQuery — all node types get id and created_at", () => {
  for (const type of ["Agent", "Signal", "Session", "Discrepancy", "Stock"]) {
    const q = captureQuery(type, { name: "test" }, false);
    const props = q.params.props as Record<string, unknown>;
    assertEquals(typeof props.id, "string", `${type} missing id`);
    assertEquals(typeof props.created_at, "string", `${type} missing created_at`);
  }
});

Deno.test("captureQuery — explicit props not overwritten", () => {
  const q = captureQuery("Signal", { concrete_data: "x", status: "under_review" }, false);
  const props = q.params.props as Record<string, unknown>;
  assertEquals(props.status, "under_review");
});

// ─── deleteNodeQuery ─────────────────────────────────────────

Deno.test("deleteNodeQuery — uses DETACH DELETE", () => {
  const q = deleteNodeQuery("test-id");
  assertStringIncludes(q.cypher, "DETACH DELETE");
  assertEquals(q.params.nodeId, "test-id");
});

// ─── listQuery ───────────────────────────────────────────────

Deno.test("listQuery — no filters returns basic match", () => {
  const q = listQuery({});
  assertStringIncludes(q.cypher, "MATCH (n)");
  assertStringIncludes(q.cypher, "ORDER BY n.created_at DESC");
  assertStringIncludes(q.cypher, "toInteger($limit)");
  assertEquals(q.params.limit, 20);
});

Deno.test("listQuery — type filter uses label in MATCH", () => {
  const q = listQuery({ type: "Signal" });
  assertStringIncludes(q.cypher, "MATCH (n:Signal)");
});

Deno.test("listQuery — days filter adds since param", () => {
  const q = listQuery({ days: 7 });
  assertStringIncludes(q.cypher, "n.created_at >= $since");
  assertEquals(typeof q.params.since, "string");
});

Deno.test("listQuery — status filter adds WHERE clause", () => {
  const q = listQuery({ status: "unprocessed" });
  assertStringIncludes(q.cypher, "n.status = $status");
  assertEquals(q.params.status, "unprocessed");
});

Deno.test("listQuery — limit is floored to integer", () => {
  const q = listQuery({ limit: 5.7 });
  assertEquals(q.params.limit, 5);
});

Deno.test("listQuery — all filters combined", () => {
  const q = listQuery({ days: 3, type: "Agent", status: "active", limit: 10 });
  assertStringIncludes(q.cypher, "MATCH (n:Agent)");
  assertStringIncludes(q.cypher, "n.created_at >= $since");
  assertStringIncludes(q.cypher, "n.status = $status");
  assertEquals(q.params.limit, 10);
});

// ─── statsQueries ────────────────────────────────────────────

Deno.test("statsQueries — returns all 5 expected queries", () => {
  const q = statsQueries();
  const keys = Object.keys(q);
  assertEquals(keys.length, 5);
  assertEquals(keys.includes("node_counts"), true);
  assertEquals(keys.includes("edge_counts"), true);
  assertEquals(keys.includes("recent_7_days"), true);
  assertEquals(keys.includes("unprocessed_signals"), true);
  assertEquals(keys.includes("open_needs"), true);
});

Deno.test("statsQueries — node_counts excludes Entity and Artifact labels", () => {
  const q = statsQueries();
  assertStringIncludes(q.node_counts.cypher, "label <> 'Entity'");
  assertStringIncludes(q.node_counts.cypher, "label <> 'Artifact'");
});

Deno.test("statsQueries — recent_7_days has since param", () => {
  const q = statsQueries();
  assertEquals(typeof q.recent_7_days.params.since, "string");
});

Deno.test("statsQueries — unprocessed includes needs_classification", () => {
  const q = statsQueries();
  assertStringIncludes(q.unprocessed_signals.cypher, "needs_classification");
});

// ─── Context query builders ──────────────────────────────────

const testIds = ["id-1", "id-2"];

Deno.test("activeSessionsForEntitiesQuery — filters active sessions", () => {
  const q = activeSessionsForEntitiesQuery(testIds);
  assertStringIncludes(q.cypher, "status: 'active'");
  assertStringIncludes(q.cypher, "$entityIds");
  assertEquals(q.params.entityIds, testIds);
});

Deno.test("openNeedsForEntitiesQuery — filters open lifecycle state", () => {
  const q = openNeedsForEntitiesQuery(testIds);
  assertStringIncludes(q.cypher, "lifecycle_state = 'open'");
  assertEquals(q.params.entityIds, testIds);
});

Deno.test("unprocessedSignalsForEntitiesQuery — includes both unprocessed statuses", () => {
  const q = unprocessedSignalsForEntitiesQuery(testIds);
  assertStringIncludes(q.cypher, "unprocessed");
  assertStringIncludes(q.cypher, "needs_classification");
});

Deno.test("unprocessedSignalsForEntitiesQuery — truncates text fields", () => {
  const q = unprocessedSignalsForEntitiesQuery(testIds);
  assertStringIncludes(q.cypher, "left(s.concrete_data, 200)");
  assertStringIncludes(q.cypher, "left(s.interpretation, 200)");
});

Deno.test("attentionItemsQuery — checks depleting stocks and stale signals", () => {
  const q = attentionItemsQuery(testIds);
  assertStringIncludes(q.cypher, "trend = 'depleting'");
  assertStringIncludes(q.cypher, "$staleThreshold");
  assertEquals(typeof q.params.staleThreshold, "string");
});

Deno.test("structuralNeighborsQuery — 2-hop traversal with projected fields", () => {
  const q = structuralNeighborsQuery(testIds);
  assertStringIncludes(q.cypher, "*1..2");
  assertStringIncludes(q.cypher, "LIMIT 30");
  // Verify projection excludes embedding
  assertStringIncludes(q.cypher, ".id, .name,");
  assertEquals(q.cypher.includes(".embedding"), false);
});
