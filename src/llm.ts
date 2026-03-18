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

// ─── Embeddings ───────────────────────────────────────────────

export async function getEmbedding(text: string): Promise<number[]> {
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
  return data.data[0].embedding;
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
