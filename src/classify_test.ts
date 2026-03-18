// Unit tests for classify module (hint bypass only — LLM path requires API)
// Run: deno test src/classify_test.ts

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { classifyContent } from "./classify.ts";

Deno.test("classifyContent — hint with valid node_type skips LLM", async () => {
  const result = await classifyContent("test content", {
    node_type: "Agent",
    name: "My Agent",
  });
  assertEquals(result.node_type, "Agent");
  assertEquals(result.confidence, "high");
  assertEquals(result.suggested_name, "My Agent");
});

Deno.test("classifyContent — hint with name but no type still uses hint name", async () => {
  // This will try the LLM path — but we're testing that the name hint carries through
  // Since no API key is set in test, it should fallback to unclassified
  const originalKey = Deno.env.get("LLM_API_KEY");
  Deno.env.delete("LLM_API_KEY");

  try {
    const result = await classifyContent("some observation about trust levels", {
      name: "Trust Signal",
    });
    // Without API key, falls back to unclassified
    assertEquals(result.node_type, "unclassified");
    assertEquals(result.confidence, "low");
    assertEquals(result.suggested_name, "Trust Signal");
  } finally {
    if (originalKey) Deno.env.set("LLM_API_KEY", originalKey);
  }
});

Deno.test("classifyContent — all entity types accepted as hints", async () => {
  const types = ["Agent", "Need", "Resource", "Constraint", "Output", "Role"];
  for (const type of types) {
    const result = await classifyContent("test", { node_type: type });
    assertEquals(result.node_type, type, `${type} not accepted`);
    assertEquals(result.confidence, "high");
  }
});

Deno.test("classifyContent — all non-entity types accepted as hints", async () => {
  const types = ["Signal", "Session", "Discrepancy", "Stock"];
  for (const type of types) {
    const result = await classifyContent("test", { node_type: type });
    assertEquals(result.node_type, type, `${type} not accepted`);
  }
});

Deno.test("classifyContent — invalid hint type falls through to LLM/fallback", async () => {
  const originalKey = Deno.env.get("LLM_API_KEY");
  Deno.env.delete("LLM_API_KEY");

  try {
    const result = await classifyContent("test", { node_type: "Bogus" });
    // Invalid type not in ALL_NODE_LABELS → falls through to LLM → falls back
    assertEquals(result.node_type, "unclassified");
  } finally {
    if (originalKey) Deno.env.set("LLM_API_KEY", originalKey);
  }
});

Deno.test("classifyContent — no hints and no API key returns fallback", async () => {
  const originalKey = Deno.env.get("LLM_API_KEY");
  Deno.env.delete("LLM_API_KEY");

  try {
    const result = await classifyContent("some random content");
    assertEquals(result.node_type, "unclassified");
    assertEquals(result.confidence, "low");
    // suggested_name should be truncated content
    assertEquals(result.suggested_name, "some random content");
  } finally {
    if (originalKey) Deno.env.set("LLM_API_KEY", originalKey);
  }
});

Deno.test("classifyContent — long content gets truncated in fallback name", async () => {
  const originalKey = Deno.env.get("LLM_API_KEY");
  Deno.env.delete("LLM_API_KEY");

  try {
    const longContent = "a".repeat(100);
    const result = await classifyContent(longContent);
    assertEquals(result.suggested_name.length, 60);
  } finally {
    if (originalKey) Deno.env.set("LLM_API_KEY", originalKey);
  }
});
