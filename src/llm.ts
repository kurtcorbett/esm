// ESM — Embedding generation and metadata extraction via any OpenAI-compatible API

import type { ExtractedMetadata, NodeLabel } from "./types.ts";

// ─── Configuration ───────────────────────────────────────────

export function getLlmConfig() {
  return {
    baseUrl: Deno.env.get("LLM_BASE_URL") || "https://api.openai.com/v1",
    apiKey: Deno.env.get("LLM_API_KEY"),
    embeddingModel: Deno.env.get("LLM_EMBEDDING_MODEL") || "text-embedding-3-small",
    embeddingDimensions: parseInt(Deno.env.get("LLM_EMBEDDING_DIMENSIONS") || "1536", 10),
    completionModel: Deno.env.get("LLM_COMPLETION_MODEL") || "gpt-4o-mini",
  };
}

function getApiKey(): string {
  const key = getLlmConfig().apiKey;
  if (!key) throw new Error("Missing LLM_API_KEY");
  return key;
}

// ─── Embedding Cache ────────────────────────────────────────

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const CACHE_MAX_SIZE = 200;

interface CacheEntry {
  embedding: number[];
  cachedAt: number;
}

const embeddingCache = new Map<string, CacheEntry>();

function getCachedEmbedding(text: string): number[] | null {
  const entry = embeddingCache.get(text);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > CACHE_TTL_MS) {
    embeddingCache.delete(text);
    return null;
  }
  return entry.embedding;
}

function setCachedEmbedding(text: string, embedding: number[]): void {
  if (embeddingCache.size >= CACHE_MAX_SIZE) {
    const oldestKey = embeddingCache.keys().next().value;
    if (oldestKey !== undefined) embeddingCache.delete(oldestKey);
  }
  embeddingCache.set(text, { embedding, cachedAt: Date.now() });
}

// ─── Embeddings ───────────────────────────────────────────────

export async function getEmbedding(text: string): Promise<number[]> {
  const cached = getCachedEmbedding(text);
  if (cached) return cached;

  const config = getLlmConfig();
  const res = await fetch(`${config.baseUrl}/embeddings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getApiKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.embeddingModel,
      input: text,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`Embedding request failed (${res.status}): ${body}`);
    throw new Error(`Embedding request failed (${res.status})`);
  }

  const data = await res.json();
  const embedding = data.data[0].embedding;
  setCachedEmbedding(text, embedding);
  return embedding;
}

export async function getEmbeddings(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (texts.length === 1) return [await getEmbedding(texts[0])];

  // Check cache, only send uncached to API
  const results: (number[] | null)[] = texts.map((t) => getCachedEmbedding(t));
  const uncachedIndices = results
    .map((r, i) => (r === null ? i : -1))
    .filter((i) => i >= 0);

  if (uncachedIndices.length === 0) return results as number[][];

  const uncachedTexts = uncachedIndices.map((i) => texts[i]);
  const config = getLlmConfig();

  try {
    const res = await fetch(`${config.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${getApiKey()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.embeddingModel,
        input: uncachedTexts,
      }),
    });

    if (!res.ok) {
      // Fallback: individual calls
      const fallback = await Promise.all(uncachedTexts.map((t) => getEmbedding(t)));
      for (let j = 0; j < uncachedIndices.length; j++) {
        results[uncachedIndices[j]] = fallback[j];
      }
      return results as number[][];
    }

    const data = await res.json();
    const sorted = data.data.sort(
      (a: { index: number }, b: { index: number }) => a.index - b.index
    );

    for (let j = 0; j < uncachedIndices.length; j++) {
      const embedding = sorted[j].embedding;
      results[uncachedIndices[j]] = embedding;
      setCachedEmbedding(uncachedTexts[j], embedding);
    }
    return results as number[][];
  } catch {
    // Fallback: individual calls
    const fallback = await Promise.all(uncachedTexts.map((t) => getEmbedding(t)));
    for (let j = 0; j < uncachedIndices.length; j++) {
      results[uncachedIndices[j]] = fallback[j];
    }
    return results as number[][];
  }
}

// ─── Metadata Extraction ─────────────────────────────────────

const EXTRACTION_PROMPTS: Partial<Record<NodeLabel, string>> = {
  Agent: `Extract metadata from this agent description. Return JSON:
{
  "agent_type": "person" | "team" | "org" | "ai",
  "is_root": true if this appears to be a root entity whose purpose doesn't cascade from above
}`,

  Need: `Extract metadata from this need description. Return JSON:
{
  "lifecycle_state": "open" | "under_review" | "resolved" | "deferred" | "accepted",
  "origin": brief provenance string if detectable
}`,

  Resource: `Extract metadata from this resource description. Return JSON:
{
  "resource_type": "skill" | "knowledge" | "tool" | "budget" | "capacity"
}`,

  Constraint: `Extract metadata from this constraint description. Return JSON:
{
  "constraint_type": "priority" | "belief" | "approach" | "structure",
  "rigidity": "fixed" | "firm" | "flexible",
  "validation_state": "assumption" | "conviction" | "learning" (for beliefs only, omit otherwise),
  "origin_source": "intentional" | "emergent" | "inherited" (if detectable)
}`,

  Output: `Extract metadata from this output description. Return JSON:
{
  "is_primitive": true if this appears to be a foundational insight that anchors a branch
}`,

  Signal: `Extract metadata from this signal. Return JSON:
{
  "source_type": "direct_observation" | "reported" | "inferred" | "environmental",
  "confidence": "high" | "medium" | "low",
  "altitude": "purpose" | "priority" | "belief" | "approach" | "structure"
}`,

  Session: `Extract metadata from this session description. Return JSON:
{
  "session_type": "discovery" | "calibration" | "review" | "planning",
  "trigger_type": "cadence" | "signal"
}`,

  Discrepancy: `Extract metadata from this discrepancy description. Return JSON:
{
  "altitude": "purpose" | "priority" | "belief" | "approach" | "structure"
}`,
};

// Fields that extractMetadata would produce per type. If caller provides these,
// skip the LLM call — the merge order (...extracted, ...properties) means
// explicit properties override extraction anyway.
const REQUIRED_EXTRACTION_FIELDS: Partial<Record<NodeLabel, string[]>> = {
  Agent: ["agent_type"],
  Need: ["lifecycle_state"],
  Resource: ["resource_type"],
  Constraint: ["constraint_type", "rigidity"],
  Output: ["is_primitive"],
  Signal: ["source_type", "confidence"],
  Session: ["session_type", "trigger_type"],
  Discrepancy: ["altitude"],
};

export function shouldSkipExtraction(
  nodeType: NodeLabel,
  properties?: Record<string, unknown>
): boolean {
  if (!properties) return false;
  const required = REQUIRED_EXTRACTION_FIELDS[nodeType];
  if (!required) return true; // No extraction prompt (Role, Stock)
  return required.every((field) => field in properties && properties[field] !== undefined);
}

export async function extractMetadata(
  text: string,
  nodeType: NodeLabel
): Promise<ExtractedMetadata> {
  const systemPrompt = EXTRACTION_PROMPTS[nodeType];
  if (!systemPrompt) return {};

  try {
    const config = getLlmConfig();
    const res = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${getApiKey()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.completionModel,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: text },
        ],
        response_format: { type: "json_object" },
        temperature: 0,
      }),
    });

    if (!res.ok) {
      console.error(`Metadata extraction failed (${res.status})`);
      return {};
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return {};

    const parsed = JSON.parse(content);

    // Validate: only accept string/boolean/number values, drop anything unexpected
    const safe: ExtractedMetadata = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string" || typeof v === "boolean" || typeof v === "number") {
        safe[k] = v;
      }
    }
    return safe;
  } catch (err) {
    console.error("Metadata extraction error:", err);
    return {};
  }
}
