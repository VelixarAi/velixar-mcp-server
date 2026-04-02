// ── Graph Sanitizer ──
// H4.6: Single sanitization module for all KG responses.
// O(n) single-pass. All KG tool responses pass through here.
// H4.5: Abstract relationship type mapping (internal → user-facing).
// H4.7: Field allowlists — new fields invisible by default.

export type SanitizeMode = 'user' | 'debug';

// H4.5: Relationship type mapping — preserves semantics where possible
const RELATIONSHIP_MAP: Record<string, string> = {
  relates_to: 'relates_to',
  depends_on: 'depends_on',
  contradicts: 'contradicts',
  supports: 'supports',
  derived_from: 'derived_from',
  supersedes: 'supersedes',
  alias: 'alias',
  also_known_as: 'alias',
  synonym: 'alias',
  part_of: 'part_of',
  contains: 'contains',
  causes: 'causes',
  blocks: 'blocks',
  implements: 'implements',
  references: 'references',
  // Internal types → generic
  derived_from_snowflake_table: 'derived_from',
  derived_from_postgres: 'derived_from',
  extracted_from_memory: 'derived_from',
  co_occurrence: 'relates_to',
  embedding_similarity: 'relates_to',
};

// H4.7: Field allowlists
const USER_NODE_FIELDS = new Set(['id', 'label', 'entity_type', 'relevance', 'relationship_count']);
const USER_EDGE_FIELDS = new Set(['source', 'target', 'relationship', 'relevance']);
const DEBUG_NODE_FIELDS = new Set([...USER_NODE_FIELDS, 'properties', 'extraction_model', 'confidence', 'created_at']);
const DEBUG_EDGE_FIELDS = new Set([...USER_EDGE_FIELDS, 'confidence', 'created_at', 'raw_type']);

// Security-sensitive fields — never exposed in any mode
const BLOCKED_FIELDS = new Set(['hmac_key', 'workspace_id', 'internal_id', 'embedding', 'vector']);

export interface SanitizedNode {
  id: string;
  label: string;
  entity_type: string;
  relevance?: number;
  relationship_count?: number;
  [key: string]: unknown;
}

export interface SanitizedEdge {
  source: string;
  target: string;
  relationship: string;
  relevance?: number;
  [key: string]: unknown;
}

export function sanitizeNode(raw: Record<string, unknown>, mode: SanitizeMode = 'user'): SanitizedNode {
  const allowlist = mode === 'debug' ? DEBUG_NODE_FIELDS : USER_NODE_FIELDS;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(raw)) {
    if (BLOCKED_FIELDS.has(key)) continue;
    if (allowlist.has(key)) result[key] = raw[key];
  }
  return {
    id: String(result.id || ''),
    label: String(result.label || raw.name || raw.id || ''),
    entity_type: String(result.entity_type || raw.type || 'unknown'),
    relevance: typeof result.relevance === 'number' ? result.relevance : undefined,
    ...result,
  };
}

export function sanitizeEdge(raw: Record<string, unknown>, mode: SanitizeMode = 'user'): SanitizedEdge {
  const allowlist = mode === 'debug' ? DEBUG_EDGE_FIELDS : USER_EDGE_FIELDS;
  const rawType = String(raw.relationship || raw.relation_type || raw.label || 'relates_to');
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(raw)) {
    if (BLOCKED_FIELDS.has(key)) continue;
    if (allowlist.has(key)) result[key] = raw[key];
  }
  return {
    source: String(result.source || raw.from || ''),
    target: String(result.target || raw.to || ''),
    relationship: RELATIONSHIP_MAP[rawType] || 'relates_to',
    relevance: typeof result.relevance === 'number' ? result.relevance : undefined,
    ...(mode === 'debug' ? { raw_type: rawType } : {}),
  };
}

/** O(n) single-pass sanitization for graph responses */
export function sanitizeGraph(
  nodes: Record<string, unknown>[],
  edges: Record<string, unknown>[],
  mode: SanitizeMode = 'user',
): { nodes: SanitizedNode[]; edges: SanitizedEdge[] } {
  return {
    nodes: nodes.map(n => sanitizeNode(n, mode)),
    edges: edges.map(e => sanitizeEdge(e, mode)),
  };
}
