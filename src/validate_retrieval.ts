// ── Retrieval Response Validators ──
// Validators for new retrieval endpoints: multi_search, search_by_vector, coverage.
// Same pattern as validate.ts — no api.ts imports (avoid circular deps).

import type { ValidatedRawMemory } from './validate.js';

// ── Helpers (duplicated from validate.ts to avoid coupling) ──

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}

function arr(v: unknown): unknown[] | undefined {
  return Array.isArray(v) ? v : undefined;
}

function validateRawMemory(m: unknown, endpoint: string): ValidatedRawMemory | null {
  if (!m || typeof m !== 'object') return null;
  const o = m as Record<string, unknown>;
  const id = str(o.id);
  const content = str(o.content);
  if (!id || !content) return null;
  return {
    id, content,
    score: num(o.score), tier: num(o.tier), type: str(o.type) ?? null,
    tags: arr(o.tags)?.filter((t): t is string => typeof t === 'string'),
    salience: num(o.salience), created_at: str(o.created_at), updated_at: str(o.updated_at),
    previous_memory_id: str(o.previous_memory_id) ?? null,
  };
}

// ── Multi-Search Response ──

export interface ValidatedMultiSearchResult {
  results: Array<{
    query: string;
    memories: ValidatedRawMemory[];
    count: number;
    error?: string;
  }>;
  total_queries: number;
}

export function validateMultiSearchResponse(raw: unknown, endpoint: string): ValidatedMultiSearchResult {
  if (!raw || typeof raw !== 'object') throw new Error(`Schema mismatch on ${endpoint}: expected object`);
  const o = raw as Record<string, unknown>;
  if (o.error) throw new Error(String(o.error));

  const rawResults = arr(o.results) || [];
  const results = rawResults.map(r => {
    if (!r || typeof r !== 'object') return { query: '', memories: [] as ValidatedRawMemory[], count: 0 };
    const item = r as Record<string, unknown>;
    const rawMems = arr(item.memories) || [];
    const memories = rawMems.map(m => validateRawMemory(m, endpoint)).filter((m): m is ValidatedRawMemory => m !== null);
    return {
      query: str(item.query) || '',
      memories,
      count: memories.length,
      error: str(item.error),
    };
  });

  return { results, total_queries: results.length };
}

// ── Coverage Response ──

export interface ValidatedCoverageResult {
  topic: string;
  total_relevant: number;
  retrieved_count: number;
  coverage_ratio: number;
  gaps: Array<{
    id: string;
    preview: string;
    relevance: number;
  }>;
  uncovered_entities: string[];
  suggested_queries: string[];
}

export function validateCoverageResponse(raw: unknown, endpoint: string): ValidatedCoverageResult {
  if (!raw || typeof raw !== 'object') throw new Error(`Schema mismatch on ${endpoint}: expected object`);
  const o = raw as Record<string, unknown>;
  if (o.error) throw new Error(String(o.error));

  const rawGaps = arr(o.gaps) || [];
  const gaps = rawGaps.map(g => {
    if (!g || typeof g !== 'object') return null;
    const gap = g as Record<string, unknown>;
    const id = str(gap.id);
    if (!id) return null;
    return {
      id,
      preview: str(gap.preview) || str(gap.content)?.slice(0, 200) || '',
      relevance: num(gap.relevance) ?? 0,
    };
  }).filter((g): g is NonNullable<typeof g> => g !== null);

  return {
    topic: str(o.topic) || '',
    total_relevant: num(o.total_relevant) ?? 0,
    retrieved_count: num(o.retrieved_count) ?? 0,
    coverage_ratio: num(o.coverage_ratio) ?? 0,
    gaps,
    uncovered_entities: (arr(o.uncovered_entities) || []).filter((e): e is string => typeof e === 'string'),
    suggested_queries: (arr(o.suggested_queries) || []).filter((q): q is string => typeof q === 'string'),
  };
}

// ── Neighborhood Response ──

export interface ValidatedNeighborhoodResult {
  anchor_id: string;
  anchor_embedding: 'stored' | 'generated';
  neighbors: ValidatedRawMemory[];
  isolation_signal: boolean;
}

export function validateNeighborhoodResponse(raw: unknown, endpoint: string): ValidatedNeighborhoodResult {
  if (!raw || typeof raw !== 'object') throw new Error(`Schema mismatch on ${endpoint}: expected object`);
  const o = raw as Record<string, unknown>;
  if (o.error) throw new Error(String(o.error));

  const rawNeighbors = arr(o.neighbors) || arr(o.memories) || [];
  const neighbors = rawNeighbors.map(m => validateRawMemory(m, endpoint)).filter((m): m is ValidatedRawMemory => m !== null);

  return {
    anchor_id: str(o.anchor_id) || str(o.memory_id) || '',
    anchor_embedding: str(o.anchor_embedding) === 'generated' ? 'generated' : 'stored',
    neighbors,
    isolation_signal: neighbors.length === 0,
  };
}
