// ESM — Content classification for unified capture intake

import type { ClassificationResult, NodeLabel } from "./types.ts";
import { ALL_NODE_LABELS } from "./types.ts";
import { getLlmConfig } from "./llm.ts";

const CLASSIFICATION_PROMPT = `You classify incoming content into graph node types.

Node types and when to use each:

- Agent: A person, team, organization, or AI system that acts with intent.
- Need: Something an agent requires — a gap, want, or requirement. Has a lifecycle.
- Resource: A capability or asset — skill, knowledge, tool, budget, capacity.
- Constraint: A governing force — priority, belief, approach, or structural rule.
- Output: A discrete unit produced by an Agent that flows through a purpose edge to a beneficiary. Impact is determined by need-match at receipt, not by the unit itself.
- Role: A named function or position within the system.
- Signal: An observation or data point — something noticed. Use this when the content describes a concrete event, metric, or behavior with optional interpretation. DEFAULT TO THIS when uncertain.
- Session: A bounded interaction — a meeting, review, or working session.
- Discrepancy: A gap between intent and output — something that doesn't match expectations.
- Stock: A measurable accumulation — trust, knowledge, capacity levels.

Return JSON:
{
  "node_type": one of the types above,
  "confidence": "high" | "medium" | "low",
  "suggested_name": a concise name for this node (3-8 words),
  "hints": {} any additional metadata you can extract
}

If genuinely uncertain, use "Signal" as the default — it's the lowest-commitment type and can be reclassified later.`;

export async function classifyContent(
  content: string,
  hints?: { node_type?: string; name?: string }
): Promise<ClassificationResult> {
  // If caller already knows the type, skip LLM
  if (hints?.node_type) {
    const nodeType = hints.node_type as NodeLabel;
    if (ALL_NODE_LABELS.includes(nodeType)) {
      return {
        node_type: nodeType,
        confidence: "high",
        suggested_name: hints.name || content.slice(0, 60),
        hints: {},
      };
    }
  }

  try {
    const config = getLlmConfig();
    if (!config.apiKey) throw new Error("Missing LLM_API_KEY");

    const res = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.completionModel,
        messages: [
          { role: "system", content: CLASSIFICATION_PROMPT },
          { role: "user", content },
        ],
        response_format: { type: "json_object" },
        temperature: 0,
      }),
    });

    if (!res.ok) {
      console.error(`Classification failed (${res.status})`);
      return fallback(content, hints);
    }

    const data = await res.json();
    const raw = data.choices?.[0]?.message?.content;
    if (!raw) return fallback(content, hints);

    const parsed = JSON.parse(raw);

    // Validate the returned node_type
    const nodeType = typeof parsed.node_type === "string" && ALL_NODE_LABELS.includes(parsed.node_type)
      ? parsed.node_type
      : "Signal";
    const confidence = ["high", "medium", "low"].includes(parsed.confidence)
      ? parsed.confidence
      : "low";
    const suggestedName = typeof parsed.suggested_name === "string"
      ? parsed.suggested_name.slice(0, 200)
      : content.slice(0, 60);

    // Only accept string/boolean/number hint values
    const safeHints: Record<string, unknown> = {};
    if (parsed.hints && typeof parsed.hints === "object" && !Array.isArray(parsed.hints)) {
      for (const [k, v] of Object.entries(parsed.hints)) {
        if (typeof v === "string" || typeof v === "boolean" || typeof v === "number") {
          safeHints[k] = v;
        }
      }
    }

    return {
      node_type: nodeType,
      confidence,
      suggested_name: hints?.name || suggestedName,
      hints: safeHints,
    };
  } catch (err) {
    console.error("Classification error:", err);
    return fallback(content, hints);
  }
}

function fallback(
  content: string,
  hints?: { name?: string }
): ClassificationResult {
  return {
    node_type: "unclassified",
    confidence: "low",
    suggested_name: hints?.name || content.slice(0, 60),
    hints: {},
  };
}
