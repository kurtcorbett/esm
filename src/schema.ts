// ESM — Schema setup script. Run via: deno task setup

import { getDriver, closeDriver, runQuery } from "./db.ts";
import { schemaSetupQueries } from "./queries.ts";
import { loadEnv } from "./env.ts";
import { getLlmConfig } from "./llm.ts";

async function setup() {
  await loadEnv();
  console.log("Connecting to Neo4j...");

  // Verify connection
  const driver = getDriver();
  const info = await driver.getServerInfo();
  console.log(`Connected: ${info.address} (${info.protocolVersion})`);

  // Run schema setup queries with configured embedding dimensions
  const { embeddingDimensions } = getLlmConfig();
  console.log(`Embedding dimensions: ${embeddingDimensions}`);
  const queries = schemaSetupQueries(embeddingDimensions);
  for (const query of queries) {
    try {
      await runQuery(query);
      // Extract index/constraint name from the cypher for logging
      const match = query.cypher.match(/(?:INDEX|CONSTRAINT)\s+(\w+)/i);
      const name = match?.[1] || "query";
      console.log(`  Created: ${name}`);
    } catch (err: unknown) {
      const msg = (err as Error).message;
      if (msg.includes("already exists")) {
        const match = query.cypher.match(/(?:INDEX|CONSTRAINT)\s+(\w+)/i);
        console.log(`  Exists: ${match?.[1] || "item"}`);
      } else {
        throw err;
      }
    }
  }

  console.log("Schema setup complete.");
  await closeDriver();
}

setup().catch((err) => {
  console.error("Schema setup failed:", err);
  Deno.exit(1);
});
