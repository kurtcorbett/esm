// ESM — TypeScript types

// ─── Node Labels ──────────────────────────────────────────────

export const ENTITY_LABELS = [
  "Agent",
  "Need",
  "Resource",
  "Constraint",
  "Output",
  "Role",
] as const;

export const NON_ENTITY_LABELS = [
  "Stock",
  "Signal",
  "Discrepancy",
  "Session",
] as const;

export const ALL_NODE_LABELS = [...ENTITY_LABELS, ...NON_ENTITY_LABELS] as const;

export type EntityLabel = (typeof ENTITY_LABELS)[number];
export type NonEntityLabel = (typeof NON_ENTITY_LABELS)[number];
export type NodeLabel = (typeof ALL_NODE_LABELS)[number];

// ─── Relationship Types ───────────────────────────────────────

export const RELATIONSHIP_TYPES = [
  "PURPOSE",
  "CONTAINS",
  "FILLS",
  "GOVERNS",
  "OWNS",
  "SERVES",
  "GENERATED_BY",
  "REQUIRES",
  "PRODUCES",
  "EVALUATED_AGAINST",
  "HAS_STOCK",
  "SIGNALS",
  "OBSERVED_BY",
  "FLAGGED_AT",
  "PRODUCED_IN",
  "PARTICIPATES_IN",
  "SCOPED_TO",
  "TRIGGERED_BY",
  "DEFINED_BY",
  "ESCALATED_TO",
  "RELATED_TO",
] as const;

export type RelationshipType = (typeof RELATIONSHIP_TYPES)[number];

// ─── Shared Base ──────────────────────────────────────────────

interface BaseNode {
  id: string;
  created_at: string;
  updated_at?: string;
}

interface EmbeddableNode {
  content?: string;
  embedding?: number[];
}

// ─── Entity Nodes ─────────────────────────────────────────────

export interface AgentNode extends BaseNode, EmbeddableNode {
  name: string;
  agent_type: "person" | "team" | "org" | "ai";
  capacity?: number;
  is_root?: boolean;
}

export interface NeedNode extends BaseNode, EmbeddableNode {
  name: string;
  content: string;
  lifecycle_state?: "open" | "under_review" | "resolved" | "deferred" | "accepted";
  origin?: string;
}

export interface ResourceNode extends BaseNode, EmbeddableNode {
  name: string;
  content: string;
  resource_type?: "skill" | "knowledge" | "tool" | "budget" | "capacity";
}

export interface ConstraintNode extends BaseNode, EmbeddableNode {
  name: string;
  content: string;
  constraint_type: "priority" | "belief" | "approach" | "structure";
  rigidity?: "fixed" | "firm" | "flexible";
  validation_state?: "assumption" | "conviction" | "learning";
  origin_source?: "intentional" | "emergent" | "inherited";
  origin_from?: string;
  origin_serving_purpose?: string;
}

export interface OutputNode extends BaseNode, EmbeddableNode {
  name: string;
  content: string;
  is_primitive?: boolean;
}

export interface RoleNode extends BaseNode, EmbeddableNode {
  name: string;
}

// ─── Non-Entity Nodes ─────────────────────────────────────────

export interface StockNode extends BaseNode {
  name: string;
  level?: number;
  max?: number;
  trend?: "accumulating" | "depleting" | "stable" | "never_established";
}

export interface SignalNode extends BaseNode, EmbeddableNode {
  observation: string;
  context?: string;
  system_interpretation?: string;
  content: string;
  how_observed?: "direct_observation" | "reported" | "inferred" | "environmental";
  confidence?: "high" | "medium" | "low";
  perceived_impact?: "high" | "medium" | "low";
  structural_impact?: number;
  status: "unprocessed" | "needs_classification" | "under_review" | "resolved_into_update" | "dismissed";
  disposition?: "redundant" | "additive" | "contradictory" | "unrelated";
  disposition_note?: string;
}

export interface DiscrepancyNode extends BaseNode, EmbeddableNode {
  content: string;
  lifecycle_state: "surfaced" | "acknowledged" | "under_investigation" | "resolved" | "accepted";
  altitude?: "purpose" | "priority" | "belief" | "approach" | "structure";
}

export interface SessionNode extends BaseNode, EmbeddableNode {
  name: string;
  session_type?: "discovery" | "calibration" | "review" | "planning";
  trigger_type?: "cadence" | "signal";
  status?: "active" | "completed" | "paused";
  scope_description?: string;
}

// ─── Relationship Properties ──────────────────────────────────

export interface PurposeEdgeProps {
  purpose_type: "create" | "sustain" | "change" | "enable";
  value_description?: string;
  failure_condition?: string;
  trust?: number;
  cost?: number;
}

export interface ContainsEdgeProps {
  order?: number;
}

export interface EvaluatedAgainstEdgeProps {
  match_result?: "match" | "mismatch" | "damage";
  notes?: string;
}

export interface ParticipatesInEdgeProps {
  role_in_session?: string;
}

export interface EscalatedToEdgeProps {
  reason?: string;
  findings?: string;
}

export interface ServesEdgeProps {
  discovered_during?: string;
}

export interface GeneratedByEdgeProps {
  discovered_during?: string;
}

export interface RelatedToEdgeProps {
  relationship_description?: string;
}

// ─── Classification ─────────────────────────────────────────

export interface ClassificationResult {
  node_type: NodeLabel | "unclassified";
  confidence: "high" | "medium" | "low";
  suggested_name: string;
  hints: Record<string, unknown>;
}

// ─── Query Builder Types ──────────────────────────────────────

export interface CypherQuery {
  cypher: string;
  params: Record<string, unknown>;
}

// ─── LLM Extraction Result ───────────────────────────────────

export interface ExtractedMetadata {
  [key: string]: unknown;
}

// ─── Vector Index Names ──────────────────────────────────────

export const VECTOR_INDEXES = {
  Entity: "entity_embeddings",
  Signal: "signal_embeddings",
  Session: "session_embeddings",
  Discrepancy: "discrepancy_embeddings",
} as const;

export type VectorIndexName = (typeof VECTOR_INDEXES)[keyof typeof VECTOR_INDEXES];
