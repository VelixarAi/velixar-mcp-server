// ── Temporal Merge ──
// Shared module for chain detection, supersession marking, temporal decay,
// and current/superseded grouping. Stateless — all functions are pure transforms.
// Consumers: multi_search, search_neighborhood, coverage_check, context upgrade, prepare_context.

import type { MemoryItem } from './types.js';

// ── Configuration ──

const DECAY_RATE = parseFloat(process.env.VELIXAR_TEMPORAL_DECAY_RATE || '0.02');
const SUPERSEDED_FACTOR = 0.3;
const BROKEN_CHAIN_FACTOR = 0.6;
const HEURISTIC_SUPERSESSION_DAYS = 7;
const CONTENT_SIMILARITY_THRESHOLD = 0.95;

// ── Types ──

export interface TemporalMemory extends MemoryItem {
  _superseded: boolean;
  _superseded_by?: string;
  _supersession_confidence: 'explicit' | 'inferred' | 'none';
  _chain_head: boolean;
  _chain_broken: boolean;
  _chain_fork: boolean;
  _hit_count?: number;
  _matched_queries?: number;
  _original_relevance?: number;
}

export interface TemporalGrouping {
  current: TemporalMemory[];
  superseded: TemporalMemory[];
  temporal_context: {
    newest_memory: string;
    oldest_memory: string;
    chain_count: number;
    fork_count: number;
    broken_chain_count: number;
    warning: string | null;
  };
}

// ── Chain Detection ──

interface ChainLink {
  id: string;
  previous_memory_id: string | null;
  created_at: string;
}

/**
 * Detect supersession relationships from chain links (previous_memory_id / derived_from).
 * Returns a map of superseded_id → superseding_id.
 */
export function detectChains(memories: MemoryItem[]): {
  supersededBy: Map<string, string>;
  chainHeads: Set<string>;
  forks: Set<string>;
  brokenChains: Set<string>;
} {
  const idSet = new Set(memories.map(m => m.id));
  const childrenOf = new Map<string, string[]>(); // parent_id → [child_ids]
  const hasParent = new Set<string>();

  for (const mem of memories) {
    const parentIds = mem.provenance.derived_from || [];
    for (const parentId of parentIds) {
      hasParent.add(mem.id);
      const children = childrenOf.get(parentId) || [];
      children.push(mem.id);
      childrenOf.set(parentId, children);
    }
  }

  const supersededBy = new Map<string, string>();
  const forks = new Set<string>();
  const brokenChains = new Set<string>();

  for (const [parentId, children] of childrenOf) {
    if (children.length > 1) {
      // Fork: parent has multiple children — flag as contradiction, not supersession
      forks.add(parentId);
    } else if (children.length === 1) {
      if (idSet.has(parentId)) {
        // Parent is in our result set — mark as superseded
        supersededBy.set(parentId, children[0]);
      }
    }
  }

  // Detect broken chains: memory references a parent not in our result set
  for (const mem of memories) {
    const parentIds = mem.provenance.derived_from || [];
    for (const parentId of parentIds) {
      if (!idSet.has(parentId)) {
        brokenChains.add(mem.id);
      }
    }
  }

  // Chain heads: memories that are not superseded and not forked
  const chainHeads = new Set<string>();
  for (const mem of memories) {
    if (!supersededBy.has(mem.id) && !forks.has(mem.id)) {
      chainHeads.add(mem.id);
    }
  }

  return { supersededBy, chainHeads, forks, brokenChains };
}

// ── Timestamp Heuristic Supersession ──

/**
 * For memories without chain links, detect possible supersession by timestamp gap.
 * Groups by content similarity — only memories about the same topic can supersede each other.
 * Returns low-confidence supersession pairs.
 */
export function detectHeuristicSupersession(
  memories: MemoryItem[],
  alreadySuperseded: Set<string>,
): Map<string, { supersededBy: string; confidence: 'inferred' }> {
  const result = new Map<string, { supersededBy: string; confidence: 'inferred' }>();
  const candidates = memories.filter(m => !alreadySuperseded.has(m.id));

  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i];
      const b = candidates[j];

      // Only consider if both have timestamps
      const tsA = new Date(a.provenance.created_at).getTime();
      const tsB = new Date(b.provenance.created_at).getTime();
      if (isNaN(tsA) || isNaN(tsB)) continue;

      const daysDiff = Math.abs(tsB - tsA) / (1000 * 60 * 60 * 24);
      if (daysDiff < HEURISTIC_SUPERSESSION_DAYS) continue;

      // Check content similarity via tag overlap (lightweight proxy for cosine)
      const tagsA = new Set(a.tags);
      const tagsB = new Set(b.tags);
      const overlap = [...tagsA].filter(t => tagsB.has(t)).length;
      const maxTags = Math.max(tagsA.size, tagsB.size, 1);
      if (overlap / maxTags < 0.5) continue;

      // Older one is possibly superseded
      const [older, newer] = tsA < tsB ? [a, b] : [b, a];
      if (!alreadySuperseded.has(older.id) && !result.has(older.id)) {
        result.set(older.id, { supersededBy: newer.id, confidence: 'inferred' });
      }
    }
  }

  return result;
}

// ── Temporal Decay ──

/**
 * Apply temporal decay to relevance scores.
 * Semantic (tier 2) and pinned (tier 0) memories are exempt — they represent durable knowledge.
 * Only episodic memories (tier 1) decay.
 */
export function applyTemporalDecay(mem: TemporalMemory): number {
  // Exempt semantic and pinned memories from decay
  if (mem.memory_type === 'semantic') return mem.relevance ?? 0;

  const createdAt = new Date(mem.provenance.created_at).getTime();
  if (isNaN(createdAt)) return mem.relevance ?? 0;

  const daysSince = (Date.now() - createdAt) / (1000 * 60 * 60 * 24);
  const freshness = Math.exp(-DECAY_RATE * daysSince);
  return (mem.relevance ?? 0) * (0.7 + 0.3 * freshness);
}

// ── Full Temporal Merge Pipeline ──

/**
 * Takes a flat list of memories, applies chain detection, supersession marking,
 * temporal decay, and returns grouped results.
 */
export function temporalMerge(memories: MemoryItem[]): TemporalGrouping {
  if (memories.length === 0) {
    return {
      current: [],
      superseded: [],
      temporal_context: {
        newest_memory: '', oldest_memory: '', chain_count: 0,
        fork_count: 0, broken_chain_count: 0, warning: null,
      },
    };
  }

  // Step 1: Chain detection
  const { supersededBy, chainHeads, forks, brokenChains } = detectChains(memories);

  // Step 2: Heuristic supersession for unchained memories
  const explicitlySuperseded = new Set(supersededBy.keys());
  const heuristic = detectHeuristicSupersession(memories, explicitlySuperseded);

  // Step 3: Build temporal memories with annotations
  const temporal: TemporalMemory[] = memories.map(mem => {
    const isExplicitlySuperseded = supersededBy.has(mem.id);
    const isHeuristicallySuperseded = heuristic.has(mem.id);
    const isSuperseded = isExplicitlySuperseded || isHeuristicallySuperseded;
    const isFork = forks.has(mem.id);
    const isBrokenChain = brokenChains.has(mem.id);

    const tmem: TemporalMemory = {
      ...mem,
      _original_relevance: mem.relevance,
      _superseded: isSuperseded,
      _superseded_by: isExplicitlySuperseded
        ? supersededBy.get(mem.id)
        : isHeuristicallySuperseded
          ? heuristic.get(mem.id)!.supersededBy
          : undefined,
      _supersession_confidence: isExplicitlySuperseded
        ? 'explicit'
        : isHeuristicallySuperseded
          ? 'inferred'
          : 'none',
      _chain_head: chainHeads.has(mem.id),
      _chain_broken: isBrokenChain,
      _chain_fork: isFork,
    };

    // Step 4: Apply relevance adjustments
    if (isExplicitlySuperseded) {
      tmem.relevance = (mem.relevance ?? 0) * SUPERSEDED_FACTOR;
    } else if (isBrokenChain) {
      tmem.relevance = (mem.relevance ?? 0) * BROKEN_CHAIN_FACTOR;
    } else if (!isHeuristicallySuperseded) {
      // Only apply temporal decay to non-superseded memories
      tmem.relevance = applyTemporalDecay(tmem);
    }
    // Heuristic supersession: do NOT auto-demote, just label

    return tmem;
  });

  // Step 5: Group
  const current = temporal
    .filter(m => !m._superseded || m._supersession_confidence === 'inferred')
    .sort((a, b) => (b.relevance ?? 0) - (a.relevance ?? 0));

  const superseded = temporal
    .filter(m => m._superseded && m._supersession_confidence === 'explicit')
    .sort((a, b) => (b.relevance ?? 0) - (a.relevance ?? 0));

  // Step 6: Temporal context metadata
  const timestamps = memories
    .map(m => m.provenance.created_at)
    .filter(Boolean)
    .sort();

  const spanDays = timestamps.length >= 2
    ? (new Date(timestamps[timestamps.length - 1]).getTime() - new Date(timestamps[0]).getTime()) / (1000 * 60 * 60 * 24)
    : 0;

  return {
    current,
    superseded,
    temporal_context: {
      newest_memory: timestamps[timestamps.length - 1] || '',
      oldest_memory: timestamps[0] || '',
      chain_count: supersededBy.size,
      fork_count: forks.size,
      broken_chain_count: brokenChains.size,
      warning: spanDays > 14
        ? `Results span ${Math.round(spanDays)} days — beliefs may have evolved`
        : forks.size > 0
          ? `${forks.size} chain fork(s) detected — possible contradictions`
          : null,
    },
  };
}

// ── Multi-Query Merge ──

/**
 * Deduplicate and merge memories from multiple search queries.
 * Memories appearing in multiple queries get boosted scores.
 * H3.4: Returns matched_query_indices per memory (not full strings).
 * H3.5: Never reorders input queries — indices are stable.
 */
export function mergeMultiQueryResults(
  perQueryResults: Array<{ query: string; memories: MemoryItem[] }>,
  strategy: 'union' | 'intersection' | 'weighted' = 'weighted',
  limit: number = 10,
  queryWeights?: number[],
  threshold: number = 2,
): { merged: MemoryItem[]; diversity_score: number; per_query_counts: number[]; matched_query_indices: Record<string, number[]> } {
  const seen = new Map<string, { mem: MemoryItem; hitCount: number; maxScore: number; queryIndices: number[] }>();

  for (let qi = 0; qi < perQueryResults.length; qi++) {
    const weight = queryWeights?.[qi] ?? 1;
    for (const mem of perQueryResults[qi].memories) {
      const existing = seen.get(mem.id);
      const weightedScore = (mem.relevance ?? 0) * weight;
      if (existing) {
        existing.hitCount++;
        existing.maxScore = Math.max(existing.maxScore, weightedScore);
        existing.queryIndices.push(qi);
      } else {
        seen.set(mem.id, { mem, hitCount: 1, maxScore: weightedScore, queryIndices: [qi] });
      }
    }
  }

  let merged = [...seen.values()].map(({ mem, hitCount, maxScore, queryIndices }) => ({
    ...mem,
    relevance: strategy === 'weighted'
      ? maxScore * (1 + 0.2 * (hitCount - 1))
      : maxScore,
    _hit_count: hitCount,
    _matched_queries: hitCount,
    _query_indices: queryIndices,
  }));

  if (strategy === 'intersection') {
    merged = merged.filter(m => (m as any)._hit_count >= threshold);
  }

  merged.sort((a, b) => (b.relevance ?? 0) - (a.relevance ?? 0));

  const totalSlots = perQueryResults.reduce((sum, r) => sum + r.memories.length, 0);
  const diversity_score = totalSlots > 0 ? seen.size / totalSlots : 1;

  // H3.4: Build matched_query_indices map
  const matched_query_indices: Record<string, number[]> = {};
  for (const item of merged.slice(0, limit)) {
    matched_query_indices[item.id] = (item as any)._query_indices;
  }

  return {
    merged: merged.slice(0, limit),
    diversity_score: Math.round(diversity_score * 100) / 100,
    per_query_counts: perQueryResults.map(r => r.memories.length),
    matched_query_indices,
  };
}
