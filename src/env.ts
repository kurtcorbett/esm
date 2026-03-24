// ESM — Environment variable loading

export async function loadEnv(): Promise<void> {
  if (Deno.env.get("ESM_ENV_LOADED")) return; // Already loaded

  // Try project-local .env first, then ~/.config/env/esm.env
  const candidates = [
    `${Deno.cwd()}/.env`,
    `${Deno.env.get("HOME")}/.config/env/esm.env`,
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
