// ESM — Entry point: McpServer + StdioServerTransport

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.ts";
import { loadEnv } from "./env.ts";

async function main() {
  await loadEnv();

  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("ESM server failed to start:", err);
  Deno.exit(1);
});
