// ESM — Export agent intent stacks as structured markdown (bootstrap prompt generator)
//
// Usage:
//   deno run --allow-net --allow-env --allow-read --allow-write --allow-sys \
//     scripts/export-agents.ts [options]
//
// Options:
//   --root <id>        Root entity ID to traverse (default: Signal Processing Engine)
//   --include <id>     Additional entity IDs to append (repeatable)
//   --out <path>       Output file path (default: stdout)
//   --order <ids>      Comma-separated entity IDs defining output order
//
// Example (Signal Processing Skill):
//   deno run --allow-net --allow-env --allow-read --allow-write --allow-sys \
//     scripts/export-agents.ts \
//     --root ce5ce7be-e947-45da-ab9b-58e95ea39b6f \
//     --include 10ee23bc \
//     --out ../sia-plugins/AGENTS.md

import { runQuery, closeDriver } from "../src/db.ts";
import { loadEnv } from "../src/env.ts";

await loadEnv();

// --- Parse CLI args ---

interface CliArgs {
  root: string;
  includes: string[];
  out: string | null;
  order: string[];
}

function parseArgs(args: string[]): CliArgs {
  const result: CliArgs = {
    root: "ce5ce7be-e947-45da-ab9b-58e95ea39b6f", // Signal Processing Engine
    includes: [],
    out: null,
    order: [],
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--root":
        result.root = args[++i];
        break;
      case "--include":
        result.includes.push(args[++i]);
        break;
      case "--out":
        result.out = args[++i];
        break;
      case "--order":
        result.order = args[++i].split(",").map((s) => s.trim());
        break;
    }
  }

  return result;
}

const cli = parseArgs(Deno.args);

// --- Fetch root entity ---

console.error(`Fetching root entity ${cli.root}...`);

const rootRows = await runQuery<{
  n: Record<string, unknown>;
  labels: string[];
}>({
  cypher: `MATCH (n {id: $id}) RETURN n, labels(n) AS labels`,
  params: { id: cli.root },
});

if (rootRows.length === 0) {
  console.error(`Root entity not found: ${cli.root}`);
  Deno.exit(1);
}

const rootEntity = rootRows[0].n;
const rootLabels = rootRows[0].labels;

// --- Fetch contained agents ---

console.error("Traversing CONTAINS edges...");

const childRows = await runQuery<{
  n: Record<string, unknown>;
  labels: string[];
  order: number | null;
}>({
  cypher: `
    MATCH (root {id: $rootId})-[r:CONTAINS]->(child)
    RETURN child AS n, labels(child) AS labels, r.order AS order
    ORDER BY r.order ASC, child.name ASC
  `,
  params: { rootId: cli.root },
});

console.error(`  Found ${childRows.length} contained entities`);

// --- Fetch additional included entities ---

const additionalEntities: Array<{
  n: Record<string, unknown>;
  labels: string[];
}> = [];

for (const includeId of cli.includes) {
  // Accept partial IDs (prefix match)
  const rows = await runQuery<{
    n: Record<string, unknown>;
    labels: string[];
  }>({
    cypher: `MATCH (n) WHERE n.id STARTS WITH $prefix RETURN n, labels(n) AS labels LIMIT 1`,
    params: { prefix: includeId },
  });

  if (rows.length > 0) {
    additionalEntities.push(rows[0]);
    console.error(`  Included: ${rows[0].n.name}`);
  } else {
    console.error(`  Warning: entity not found for prefix ${includeId}`);
  }
}

// --- Order entities ---

// Default pipeline order for Signal Processing Engine agents
const DEFAULT_PIPELINE_ORDER = [
  "Capture",
  "Classify",
  "Link",
  "Deduplicate",
  "Prioritize",
  "Evaluate",
  "Infer",
  "Materialize",
  "Escalate",
  "Resolve",
  "Propagate",
  "Clarify",
];

function orderEntities(
  entities: Array<{ n: Record<string, unknown>; labels: string[] }>,
  orderIds: string[]
): Array<{ n: Record<string, unknown>; labels: string[] }> {
  if (orderIds.length > 0) {
    // Order by explicit ID list
    const idMap = new Map(entities.map((e) => [e.n.id as string, e]));
    const ordered: typeof entities = [];
    for (const id of orderIds) {
      const match = entities.find(
        (e) =>
          (e.n.id as string) === id ||
          (e.n.id as string).startsWith(id)
      );
      if (match) {
        ordered.push(match);
        idMap.delete(match.n.id as string);
      }
    }
    // Append any remaining
    for (const remaining of idMap.values()) {
      ordered.push(remaining);
    }
    return ordered;
  }

  // Default: pipeline name order
  const nameOrder = new Map(
    DEFAULT_PIPELINE_ORDER.map((name, i) => [name, i])
  );
  return [...entities].sort((a, b) => {
    const aIdx = nameOrder.get(a.n.name as string) ?? 999;
    const bIdx = nameOrder.get(b.n.name as string) ?? 999;
    if (aIdx !== bIdx) return aIdx - bIdx;
    return (a.n.name as string).localeCompare(b.n.name as string);
  });
}

const orderedChildren = orderEntities(childRows, cli.order);

// --- Separate main pipeline from cross-cutting ---

const CROSS_CUTTING = new Set(["Clarify", "Prioritize", "Deduplicate"]);

const mainPipeline = orderedChildren.filter(
  (e) => !CROSS_CUTTING.has(e.n.name as string)
);
const crossCutting = orderedChildren.filter((e) =>
  CROSS_CUTTING.has(e.n.name as string)
);

// --- Format markdown ---

function entityLabelsTag(labels: string[]): string {
  const meaningful = labels.filter(
    (l) => l !== "Entity" && l !== "Artifact"
  );
  return meaningful.length > 0 ? ` [${meaningful.join(", ")}]` : "";
}

function formatEntity(
  entity: Record<string, unknown>,
  labels: string[],
  headingLevel: number
): string {
  const heading = "#".repeat(headingLevel);
  const name = entity.name as string;
  const tag = entityLabelsTag(labels);
  const content = (entity.content as string) || "";
  const id = entity.id as string;

  const lines: string[] = [];
  lines.push(`${heading} ${name}${tag}`);
  lines.push("");
  lines.push(`<!-- entity: ${id} -->`);
  lines.push("");
  lines.push(content);
  lines.push("");

  return lines.join("\n");
}

// Build the full document
const sections: string[] = [];

// Header
sections.push("# Signal Processing Engine — Agent Intent Stacks");
sections.push("");
sections.push(
  `> Auto-generated from ESM graph on ${new Date().toISOString().split("T")[0]}. Source of truth: the graph entities. Regenerate after architectural changes.`
);
sections.push("");

// Root entity
sections.push("## Engine Overview");
sections.push("");
sections.push(
  `<!-- entity: ${rootEntity.id} | labels: ${rootLabels.join(", ")} -->`
);
sections.push("");
sections.push(rootEntity.content as string);
sections.push("");

// Main pipeline agents
sections.push("## Main Pipeline");
sections.push("");
sections.push(
  "Processing sequence: Capture → Classify → Link → Evaluate → Infer → Materialize → Escalate → Resolve → Propagate"
);
sections.push("");

for (const child of mainPipeline) {
  sections.push(formatEntity(child.n, child.labels, 3));
}

// Cross-cutting agents
sections.push("## Cross-Cutting Agents");
sections.push("");
sections.push(
  "These agents serve the entire pipeline and can be invoked by any main-pipeline agent."
);
sections.push("");

for (const child of crossCutting) {
  sections.push(formatEntity(child.n, child.labels, 3));
}

// Additional included entities
if (additionalEntities.length > 0) {
  sections.push("## Supporting Context");
  sections.push("");

  for (const entity of additionalEntities) {
    sections.push(formatEntity(entity.n, entity.labels, 3));
  }
}

const output = sections.join("\n");

// --- Write output ---

if (cli.out) {
  await Deno.writeTextFile(cli.out, output);
  console.error(`Written to ${cli.out}`);
} else {
  console.log(output);
}

await closeDriver();
console.error("Done.");
