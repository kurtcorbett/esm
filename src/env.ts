// ESM — Environment variable loading
import { resolve } from "node:path";

export async function loadEnv(): Promise<void> {
  if (Deno.env.get("ESM_ENV_LOADED")) return; // Already loaded

  // Resolve repo root from script location (works regardless of cwd)
  const repoRoot = resolve(import.meta.dirname!, "..");

  // Config directory first (reliable for MCP), then repo-local fallback
  const candidates = [
    `${Deno.env.get("HOME")}/.config/env/esm.env`,
    `${repoRoot}/.env`,
  ];

  for (const envPath of candidates) {
    try {
      const envContent = await Deno.readTextFile(envPath);
      for (const line of envContent.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        // Handle "export KEY=VALUE" or "KEY=VALUE", with optional quotes
        const match = trimmed.match(/^(?:export\s+)?(\w+)=(.*)$/);
        if (match) {
          let value = match[2];
          if ((value.startsWith('"') && value.endsWith('"')) ||
              (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
          }
          Deno.env.set(match[1], value);
        }
      }
      Deno.env.set("ESM_ENV_LOADED", "1");
      return; // Stop after first successful load
    } catch {
      // Try next candidate
    }
  }
}
