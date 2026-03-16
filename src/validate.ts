// ── Runtime Schema Validation ──
// Lightweight validators for backend API responses.
// No external deps — just shape checks that return typed data or throw.
// NOTE: Must not import from api.ts to avoid circular dependency.

function warnSchema(endpoint: string, reason: string, got: string): void {
  console.error(`[velixar] warn: schema_skip_memory ${JSON.stringify({ endpoint, reason, got })}`);
}

export class SchemaError extends Error {
  constructor(public endpoint: string, public field: string, public expected: string, public got: unknown) {
    super(`Schema mismatch on ${endpoint}: ${field} expected ${expected}, got ${typeof got} (${String(got).slice(0, 50)})`);
    this.name = 'SchemaError';
  }
}

// ── Helpers ──

function has(obj: unknown, key: string): obj is Record<string, unknown> {
  return obj !== null && typeof obj === 'object' && key in (obj as Record<string, unknown>);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}

function arr(v: unknown): unknown[] | undefined {
  return Array.isArray(v) ? v : undefined;
}

// ── Raw Backend Response Shapes ──

export interface ValidatedRawMemory {
  id: string;
  content: string;
  score?: number;
  tier?: number;
  type?: string | null;
  tags?: string[];
  salience?: number;
  created_at?: string;
  updated_at?: string;
  previous_memory_id?: string | null;
}

export interface ValidatedStoreResult {
  id: string;
}

export interface ValidatedSearchResult {
  memories: ValidatedRawMemory[];
  count?: number;
}

export interface ValidatedListResult {
  memories: ValidatedRawMemory[];
  count?: number;
  cursor?: string;
}

export interface ValidatedGraphResult {
  nodes: Array<{ id: string; label: string; entity_type?: string; properties?: Record<string, unknown>; relevance?: number }>;
  edges: Array<{ source: string; target: string; relationship?: string; direction?: string; relevance?: number }>;
  hops?: number;
}

export interface ValidatedIdentityResult {
  identity?: Record<string, unknown>;
  shifts?: Array<{ field: string; from: string; to: string; timestamp?: string }>;
  contradictions?: Array<{ existing: string; new: string; severity?: string }>;
  snapshot_count?: number;
}

export interface ValidatedOverviewResult {
  total_memories?: number;
  cortex_nodes?: number;
  temporal_chains?: number;
  system_mode?: string;
}

// ── Validators ──

function validateRawMemory(m: unknown, endpoint: string): ValidatedRawMemory | null {
  if (!m || typeof m !== 'object') return null;
  const o = m as Record<string, unknown>;
  const id = str(o.id);
  const content = str(o.content);
  if (!id || !content) {
    warnSchema(endpoint, 'missing id or content', JSON.stringify(o).slice(0, 100));
    return null;
  }
  return {
    id,
    content,
    score: num(o.score),
    tier: num(o.tier),
    type: str(o.type) ?? null,
    tags: arr(o.tags)?.filter((t): t is string => typeof t === 'string'),
    salience: num(o.salience),
    created_at: str(o.created_at),
    updated_at: str(o.updated_at),
    previous_memory_id: str(o.previous_memory_id) ?? null,
  };
}

export function validateStoreResponse(raw: unknown, endpoint: string): ValidatedStoreResult {
  if (!raw || typeof raw !== 'object') throw new SchemaError(endpoint, 'response', 'object', raw);
  const o = raw as Record<string, unknown>;
  if (o.error) throw new Error(String(o.error));
  const id = str(o.id);
  if (!id) throw new SchemaError(endpoint, 'id', 'string', o.id);
  return { id };
}

export function validateSearchResponse(raw: unknown, endpoint: string): ValidatedSearchResult {
  if (!raw || typeof raw !== 'object') throw new SchemaError(endpoint, 'response', 'object', raw);
  const o = raw as Record<string, unknown>;
  if (o.error) throw new Error(String(o.error));
  const rawMems = arr(o.memories) || [];
  const memories = rawMems.map(m => validateRawMemory(m, endpoint)).filter((m): m is ValidatedRawMemory => m !== null);
  return { memories, count: num(o.count) };
}

export function validateListResponse(raw: unknown, endpoint: string): ValidatedListResult {
  if (!raw || typeof raw !== 'object') throw new SchemaError(endpoint, 'response', 'object', raw);
  const o = raw as Record<string, unknown>;
  if (o.error) throw new Error(String(o.error));
  const rawMems = arr(o.memories) || [];
  const memories = rawMems.map(m => validateRawMemory(m, endpoint)).filter((m): m is ValidatedRawMemory => m !== null);
  return { memories, count: num(o.count), cursor: str(o.cursor) };
}

export function validateGraphResponse(raw: unknown, endpoint: string): ValidatedGraphResult {
  if (!raw || typeof raw !== 'object') throw new SchemaError(endpoint, 'response', 'object', raw);
  const o = raw as Record<string, unknown>;
  if (o.error) throw new Error(String(o.error));

  const rawNodes = arr(o.nodes) || [];
  const nodes = rawNodes.map(n => {
    if (!n || typeof n !== 'object') return null;
    const node = n as Record<string, unknown>;
    const id = str(node.id);
    const label = str(node.label) || str(node.name) || str(node.id) || '';
    if (!id) return null;
    return {
      id,
      label,
      entity_type: str(node.entity_type) || str(node.type),
      properties: (typeof node.properties === 'object' && node.properties !== null) ? node.properties as Record<string, unknown> : undefined,
      relevance: num(node.relevance),
    };
  }).filter((n): n is NonNullable<typeof n> => n !== null);

  const rawEdges = arr(o.edges) || [];
  const edges = rawEdges.map(e => {
    if (!e || typeof e !== 'object') return null;
    const edge = e as Record<string, unknown>;
    const source = str(edge.source) || str(edge.from);
    const target = str(edge.target) || str(edge.to);
    if (!source || !target) return null;
    return {
      source,
      target,
      relationship: str(edge.relationship) || str(edge.relation_type) || str(edge.label),
      direction: str(edge.direction),
      relevance: num(edge.relevance),
    };
  }).filter((e): e is NonNullable<typeof e> => e !== null);

  return { nodes, edges, hops: num(o.hops) };
}

export function validateIdentityResponse(raw: unknown, endpoint: string): ValidatedIdentityResult {
  if (!raw || typeof raw !== 'object') throw new SchemaError(endpoint, 'response', 'object', raw);
  const o = raw as Record<string, unknown>;
  if (o.error) throw new Error(String(o.error));

  const identity = (typeof o.identity === 'object' && o.identity !== null) ? o.identity as Record<string, unknown> : {};
  const rawShifts = arr(o.shifts) || [];
  const shifts = rawShifts.map(s => {
    if (!s || typeof s !== 'object') return null;
    const shift = s as Record<string, unknown>;
    return { field: str(shift.field) || '', from: str(shift.from) || '', to: str(shift.to) || '', timestamp: str(shift.timestamp) };
  }).filter((s): s is NonNullable<typeof s> => s !== null);

  const rawContradictions = arr(o.contradictions) || [];
  const contradictions = rawContradictions.map(c => {
    if (!c || typeof c !== 'object') return null;
    const con = c as Record<string, unknown>;
    return { existing: str(con.existing) || '', new: str(con.new) || '', severity: str(con.severity) };
  }).filter((c): c is NonNullable<typeof c> => c !== null);

  return { identity, shifts, contradictions, snapshot_count: num(o.snapshot_count) };
}

export function validateOverviewResponse(raw: unknown, endpoint: string): ValidatedOverviewResult {
  if (!raw || typeof raw !== 'object') throw new SchemaError(endpoint, 'response', 'object', raw);
  const o = raw as Record<string, unknown>;
  return {
    total_memories: num(o.total_memories),
    cortex_nodes: num(o.cortex_nodes),
    temporal_chains: num(o.temporal_chains),
    system_mode: str(o.system_mode),
  };
}

export function validateMutationResponse(raw: unknown, endpoint: string): { error?: string } {
  if (!raw || typeof raw !== 'object') throw new SchemaError(endpoint, 'response', 'object', raw);
  const o = raw as Record<string, unknown>;
  if (o.error) throw new Error(String(o.error));
  return {};
}
