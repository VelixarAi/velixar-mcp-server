// ── Velixar MCP Server — Core Types ──
// Governs all tool inputs, outputs, and internal contracts.
// See ~/MCP-SERVER-STRATEGY.md for design rationale.

// ── Response Envelope ──

export type ResponseStatus = 'ok' | 'partial' | 'stale' | 'error';

export interface ResponseMeta {
  workspace_id: string;
  confidence: number;
  staleness: 'fresh' | 'recent' | 'stale';
  contradictions_present: boolean;
  data_absent: boolean;
  absence_reason?: AbsenceReason;
  partial_context: boolean;
  request_ms: number;
  cached?: boolean;
}

export interface VelixarResponse<T> {
  status: ResponseStatus;
  data: T;
  meta: ResponseMeta;
}

export interface VelixarError {
  status: 'error';
  error: {
    code: string;
    message: string;
    retryable: boolean;
    details?: Record<string, unknown>;
  };
}

// ── Memory ──

export type MemoryType = 'episodic' | 'semantic';
export type SourceType = 'user' | 'distill' | 'inferred' | 'imported';
export type AuthorType = 'user' | 'agent' | 'pipeline' | 'distill';

export interface Author {
  type: AuthorType;
  agent_id?: string;
  session_id?: string;
}

export interface Provenance {
  created_at: string;
  updated_at: string;
  derived_from?: string[];
  last_touched: string;
}

export interface MemoryItem {
  id: string;
  workspace_id: string;
  content: string;
  summary?: string;
  tags: string[];
  memory_type: MemoryType;
  source_type: SourceType;
  author: Author;
  relevance?: number;
  confidence?: number;
  provenance: Provenance;
  contradiction_flags?: string[];
}

// ── Graph ──

export interface GraphEntity {
  id: string;
  entity_type: string;
  label: string;
  properties?: Record<string, unknown>;
  relevance?: number;
  confidence?: number;
}

export interface GraphRelation {
  source: string;
  target: string;
  relationship: string;
  direction: 'outbound' | 'inbound' | 'bidirectional';
  relevance?: number;
  confidence?: number;
}

export interface GraphTraversalResult {
  root: GraphEntity;
  relations: GraphRelation[];
  connected_entities: GraphEntity[];
  depth_reached: number;
}

// ── Identity ──

export interface IdentityProfile {
  preferences: Record<string, string | string[]>;
  expertise: string[];
  communication_style?: string;
  recurring_goals: string[];
  stable_constraints: string[];
  shifts: IdentityShift[];
  contradictions: IdentityContradiction[];
  snapshot_count: number;
}

export interface IdentityShift {
  field: string;
  from: string;
  to: string;
  timestamp?: string;
}

export interface IdentityContradiction {
  existing: string;
  new: string;
  severity?: string;
}

// ── Contradictions ──

export interface ContradictionResult {
  id: string;
  statement_a: string;
  statement_b: string;
  memory_id_a?: string;
  memory_id_b?: string;
  severity: 'low' | 'medium' | 'high';
  confidence: number;
  explanation?: string;
  workspace_id: string;
  detected_at: string;
}

// ── Timeline ──

export interface TimelineEntry {
  id: string;
  content: string;
  summary?: string;
  timestamp: string;
  memory_type: MemoryType;
  chain_position: number;
  tags: string[];
}

// ── Patterns ──

export interface PatternResult {
  name: string;
  problem_signature: string;
  prior_solution: string;
  confidence: number;
  supporting_memories: string[];
  occurrence_count: number;
}

// ── Justification Pipeline ──

export type EvidenceClass = 'direct' | 'aggregated' | 'relational' | 'temporal' | 'contradictory' | 'weak';

export type ClaimType =
  | 'retrieved_fact'
  | 'synthesized_summary'
  | 'pattern_inference'
  | 'relational_inference'
  | 'temporal_inference'
  | 'hypothesis';

export type ConfidenceLevel = 'high' | 'medium' | 'low' | 'unstable' | 'conflicting';

export type PresentationMode =
  | 'assertive'
  | 'confident_summary'
  | 'tentative_synthesis'
  | 'cautious'
  | 'exploratory'
  | 'do_not_assert';

export interface EvidenceItem {
  id: string;
  source_type: string;
  evidence_class: EvidenceClass;
  relevance: number;
  freshness: 'recent' | 'aging' | 'stale';
  workspace_id: string;
}

export interface ConfidenceProfile {
  level: ConfidenceLevel;
  score: number;
  evidence_strength: number;
  evidence_consistency: number;
  evidence_freshness: number;
  derivation_distance: number;
  contradiction_pressure: number;
  pattern_stability?: number;
  reason: string;
}

export interface JustificationResult {
  claim: string;
  claim_type: ClaimType;
  workspace_scope: 'workspace_local' | 'user_global' | 'session_local';
  support: {
    evidence_count: number;
    evidence_types: EvidenceClass[];
    items: EvidenceItem[];
  };
  confidence: ConfidenceProfile;
  uncertainty_flags: string[];
  contradiction_flags: string[];
  derived_from: string[];
  presentation_mode: PresentationMode;
}

// ── Distillation ──

export interface DistillationCandidate {
  content: string;
  rationale: string;
  tags: string[];
  confidence: number;
  memory_type: MemoryType;
  source_type: SourceType;
  duplicate_detected: boolean;
  contradiction_detected: boolean;
  stored_id?: string;
}

export interface DistillationResult {
  candidates: DistillationCandidate[];
  stored_count: number;
  skipped_count: number;
  contradictions_found: string[];
}

// ── System ──

export interface HealthResult {
  connected: boolean;
  workspace_id: string;
  backend_reachable: boolean;
  latency_ms: number;
  version: string;
}

export interface DebugResult {
  workspace_id: string;
  workspace_source: 'env' | 'git' | 'config' | 'none';
  memory_count?: number;
  cache_state: Record<string, { cached: boolean; age_ms?: number }>;
  last_api_timings: Record<string, number>;
  retry_count: number;
  fallback_count: number;
}

export interface CapabilitiesResult {
  tools: string[];
  resources: string[];
  prompts: string[];
  features: {
    workspace_isolation: boolean;
    identity: boolean;
    graph: boolean;
    contradictions: boolean;
    timeline: boolean;
    patterns: boolean;
    distill: boolean;
    justification: boolean;
  };
  security_mode?: string;
}

// ── Absence Semantics ──

export type AbsenceReason =
  | 'no_data'           // No memories exist for this query/workspace
  | 'low_confidence'    // Data exists but confidence too low to surface
  | 'partial'           // Some data found, but incomplete coverage
  | 'conflict'          // Contradictory data prevents a clear answer
  | 'stale'             // Data exists but exceeds freshness threshold
  | 'backend_error';    // Backend unreachable, no cached fallback

// ── API Client Types ──

export interface ApiConfig {
  apiKey: string;
  apiBase: string;
  userId: string;
  workspaceId: string;
  workspaceSource: 'env' | 'git' | 'config' | 'none';
  timeoutMs: number;
  debug: boolean;
}

export interface ApiTiming {
  endpoint: string;
  duration_ms: number;
  timestamp: number;
  cached: boolean;
}
