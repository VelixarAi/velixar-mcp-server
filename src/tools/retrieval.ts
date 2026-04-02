// ── Retrieval Tools ──
// velixar_multi_search, velixar_search_neighborhood, velixar_coverage_check
// Phase 3: Multi-position vector retrieval with temporal awareness.

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ApiClient } from '../api.js';
import { normalizeMemory, wrapResponse } from '../api.js';
import type { ApiConfig, MemoryItem } from '../types.js';
import { validateSearchResponse } from '../validate.js';
import { validateMultiSearchResponse, validateNeighborhoodResponse, validateCoverageResponse } from '../validate_retrieval.js';
import { temporalMerge, mergeMultiQueryResults, type TemporalGrouping } from '../temporal_merge.js';

export const retrievalTools: Tool[] = [
  {
    name: 'velixar_multi_search',
    description:
      'Search from multiple angles simultaneously with deduplication and temporal awareness. ' +
      'Returns merged results by default. Set `merge: false` for per-query results (replaces velixar_batch_search).',
    inputSchema: {
      type: 'object',
      properties: {
        queries: { type: 'array', items: { type: 'string' }, description: 'Search queries from different angles (max 5)' },
        strategy: { type: 'string', enum: ['union', 'intersection', 'weighted'], description: 'union: all unique. intersection: 2+ query matches only. weighted (default): boost multi-match memories.' },
        limit: { type: 'number', description: 'Max total results (default 10)' },
        merge: { type: 'boolean', description: 'Merge results across queries (default true). Set false for per-query results.' },
        query_weights: { type: 'array', items: { type: 'number' }, description: 'Per-query importance weights (same length as queries)' },
        threshold: { type: 'number', description: 'For intersection strategy: minimum query match count (default 2)' },
      },
      required: ['queries'],
    },
  },
  {
    name: 'velixar_search_neighborhood',
    description:
      'Find memories near a known memory in vector space. ' +
      'Classifies results as forward (newer chain links), backward (older), or lateral (related but independent).',
    inputSchema: {
      type: 'object',
      properties: {
        memory_id: { type: 'string', description: 'Anchor memory ID to search around' },
        exclude_ids: { type: 'array', items: { type: 'string' }, description: 'Memory IDs to exclude (already seen)' },
        limit: { type: 'number', description: 'Max results (default 5)' },
        direction: { type: 'string', enum: ['forward', 'backward', 'lateral', 'all'], description: 'Filter by relationship direction (default: all)' },
        min_similarity: { type: 'number', description: 'Minimum similarity threshold 0-1' },
      },
      required: ['memory_id'],
    },
  },
  {
    name: 'velixar_coverage_check',
    description:
      'Check how well retrieved memories cover a topic. Returns coverage ratio, gaps, and suggested follow-up queries. ' +
      'Anti-hallucination guardrail — use before synthesizing an answer to verify completeness.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'The topic being investigated' },
        memory_ids: { type: 'array', items: { type: 'string' }, description: 'Memory IDs already retrieved' },
        auto_retrieve: { type: 'boolean', description: 'Run internal search to assess coverage (makes memory_ids optional)' },
      },
      required: ['topic'],
    },
  },
];

export async function handleRetrievalTool(
  name: string,
  args: Record<string, unknown>,
  api: ApiClient,
  config: ApiConfig,
): Promise<{ text: string; isError?: boolean }> {

  if (name === 'velixar_multi_search' || name === 'velixar_batch_search') {
    const queries = (args.queries as string[]).slice(0, 5); // H3.5: never reorder
    const strategy = (args.strategy as 'union' | 'intersection' | 'weighted') || 'weighted';
    const limit = Math.min((args.limit as number) || 10, 20);
    const queryWeights = args.query_weights as number[] | undefined; // H3.6: optional
    const merge = name === 'velixar_batch_search' ? (args.merge !== true) ? false : true : (args.merge !== false); // batch_search defaults merge:false
    const threshold = (args.threshold as number) || 2;

    // H3.3: Validate intersection threshold ≤ query count
    if (strategy === 'intersection' && threshold > queries.length) {
      return {
        text: JSON.stringify({ error: `threshold (${threshold}) exceeds query count (${queries.length})` }),
        isError: true,
      };
    }

    // Try backend multi_search endpoint first; fall back to parallel single searches
    let perQueryResults: Array<{ query: string; memories: MemoryItem[] }>;

    try {
      const raw = await api.post<unknown>('/memory/multi_search', {
        queries, limit_per_query: limit, user_id: config.userId,
      });
      const validated = validateMultiSearchResponse(raw, '/memory/multi_search');
      perQueryResults = validated.results.map((r, i) => ({
        query: queries[i] || r.query, // H3.5: preserve input order
        memories: r.memories.map(m => {
          const mem = normalizeMemory(m);
          mem.workspace_id = config.workspaceId;
          return mem;
        }),
      }));
    } catch {
      const results = await Promise.allSettled(
        queries.map(q => {
          const params = new URLSearchParams({ q, user_id: config.userId, limit: String(limit) });
          return api.get<unknown>(`/memory/search?${params}`, true);
        }),
      );
      perQueryResults = results.map((r, i) => {
        if (r.status !== 'fulfilled') return { query: queries[i], memories: [] };
        try {
          const validated = validateSearchResponse(r.value, '/memory/search');
          return {
            query: queries[i],
            memories: validated.memories.map(m => {
              const mem = normalizeMemory(m);
              mem.workspace_id = config.workspaceId;
              return mem;
            }),
          };
        } catch { return { query: queries[i], memories: [] }; }
      });
    }

    // Build 2.2: merge:false returns per-query results (batch_search compat)
    if (!merge) {
      return {
        text: JSON.stringify(wrapResponse({
          results: perQueryResults.map(r => ({
            query: r.query,
            memories: r.memories,
            count: r.memories.length,
          })),
          total_queries: queries.length,
        }, config, {
          data_absent: perQueryResults.every(r => r.memories.length === 0),
        })),
      };
    }

    // Merge across queries with optional weights and configurable threshold
    const { merged, diversity_score, per_query_counts, matched_query_indices } =
      mergeMultiQueryResults(perQueryResults, strategy, limit, queryWeights, threshold);

    // Apply temporal analysis
    const temporal = temporalMerge(merged);

    return {
      text: JSON.stringify(wrapResponse({
        current: temporal.current,
        superseded: temporal.superseded,
        temporal_context: temporal.temporal_context,
        diversity_score,
        strategy,
        search_angles_used: queries.length,
        per_query_counts,
        total_unique: merged.length,
        matched_query_indices, // H3.4: indices not full strings
      }, config, {
        data_absent: merged.length === 0,
      })),
    };
  }

  if (name === 'velixar_search_neighborhood') {
    const memoryId = args.memory_id as string;
    const excludeIds = (args.exclude_ids as string[]) || [];
    const limit = Math.min((args.limit as number) || 5, 20);
    const directionFilter = (args.direction as 'forward' | 'backward' | 'lateral' | 'all') || 'all';
    const minSimilarity = (args.min_similarity as number) || 0;

    // Try backend search_by_vector endpoint; fall back to inspect + search
    let neighbors: MemoryItem[];
    let anchorEmbedding: 'stored' | 'generated' = 'stored';

    try {
      const raw = await api.post<unknown>('/memory/search_by_vector', {
        memory_id: memoryId, exclude_ids: excludeIds, limit: limit + 10, // over-fetch for filtering
      });
      const validated = validateNeighborhoodResponse(raw, '/memory/search_by_vector');
      anchorEmbedding = validated.anchor_embedding;
      neighbors = validated.neighbors.map(m => {
        const mem = normalizeMemory(m);
        mem.workspace_id = config.workspaceId;
        return mem;
      });
    } catch (primaryErr) {
      try {
        const memRaw = await api.get<unknown>(`/memory/${memoryId}`, true);
        const memObj = (memRaw && typeof memRaw === 'object') ? memRaw as Record<string, unknown> : {};
        const memData = (memObj.memory && typeof memObj.memory === 'object') ? memObj.memory as Record<string, unknown> : null;
        if (!memData) throw new Error(`Memory ${memoryId} not found`);

        const content = String(memData.content || '');
        const params = new URLSearchParams({ q: content.slice(0, 200), user_id: config.userId, limit: String(limit + excludeIds.length + 11) });
        const searchRaw = await api.get<unknown>(`/memory/search?${params}`, true);
        const validated = validateSearchResponse(searchRaw, '/memory/search');
        const excludeSet = new Set([memoryId, ...excludeIds]);
        anchorEmbedding = 'generated';
        neighbors = validated.memories
          .filter(m => !excludeSet.has(m.id))
          .map(m => {
            const mem = normalizeMemory(m);
            mem.workspace_id = config.workspaceId;
            return mem;
          });
      } catch {
        neighbors = [];
      }
    }

    // Apply min_similarity filter
    if (minSimilarity > 0) {
      neighbors = neighbors.filter(n => (n.relevance ?? 0) >= minSimilarity);
    }

    // Classify neighbors: forward/backward/lateral
    const anchorRaw = await api.get<unknown>(`/memory/${memoryId}`, true).catch(() => null);
    const anchorObj = (anchorRaw && typeof anchorRaw === 'object') ? anchorRaw as Record<string, unknown> : {};
    const anchorMem = (anchorObj.memory && typeof anchorObj.memory === 'object') ? anchorObj.memory as Record<string, unknown> : {};
    const anchorDerivedFrom = Array.isArray(anchorMem.derived_from) ? anchorMem.derived_from as string[]
      : typeof anchorMem.previous_memory_id === 'string' ? [anchorMem.previous_memory_id] : [];

    const classified = neighbors.map(n => {
      const nDerivedFrom = n.provenance.derived_from || [];
      let direction: 'forward' | 'backward' | 'lateral' = 'lateral';
      if (nDerivedFrom.includes(memoryId)) direction = 'forward';
      else if (anchorDerivedFrom.includes(n.id)) direction = 'backward';
      return { ...n, _direction: direction };
    });

    // Apply direction filter
    const filtered = directionFilter === 'all'
      ? classified
      : classified.filter(n => n._direction === directionFilter);

    const forward = filtered.filter(n => n._direction === 'forward').slice(0, limit);
    const backward = filtered.filter(n => n._direction === 'backward').slice(0, limit);
    const lateral = filtered.filter(n => n._direction === 'lateral').slice(0, limit);
    const total = directionFilter === 'all'
      ? forward.length + backward.length + lateral.length
      : filtered.length;

    return {
      text: JSON.stringify(wrapResponse({
        anchor: { id: memoryId, embedding: anchorEmbedding },
        forward,
        backward,
        lateral,
        total,
        direction_filter: directionFilter,
        ...(minSimilarity > 0 ? { min_similarity_applied: minSimilarity } : {}),
        isolation_signal: total === 0,
        ...(total === 0 ? { suggestion: 'This memory has no close neighbors. It may cover a unique topic.' } : {}),
      }, config, {
        data_absent: total === 0,
      })),
    };
  }

  if (name === 'velixar_coverage_check') {
    const topic = args.topic as string;
    let memoryIds = (args.memory_ids as string[]) || [];
    const autoRetrieve = args.auto_retrieve as boolean;

    // Build 2.4: auto_retrieve — run internal search if no memory_ids provided
    let autoRetrievedMemories: MemoryItem[] | undefined;
    if (autoRetrieve && memoryIds.length === 0) {
      const params = new URLSearchParams({ q: topic, user_id: config.userId, limit: '15' });
      const raw = await api.get<unknown>(`/memory/search?${params}`, true);
      const validated = validateSearchResponse(raw, '/memory/search');
      autoRetrievedMemories = validated.memories.map(m => {
        const mem = normalizeMemory(m);
        mem.workspace_id = config.workspaceId;
        return mem;
      });
      memoryIds = autoRetrievedMemories.map(m => m.id);
    }

    if (!autoRetrieve && memoryIds.length === 0) {
      return {
        text: JSON.stringify({ error: 'memory_ids required when auto_retrieve is not enabled' }),
        isError: true,
      };
    }

    // Try backend coverage endpoint; fall back to client-side approximation
    try {
      const raw = await api.post<unknown>('/memory/coverage', {
        topic, memory_ids: memoryIds,
      });
      const result = validateCoverageResponse(raw, '/memory/coverage');

      const temporalHealth = {
        stale_warning: false,
        evolution_detected: false,
        suggestion: result.coverage_ratio >= 0.7
          ? 'Coverage is adequate for synthesis.'
          : `Coverage is ${Math.round(result.coverage_ratio * 100)}% — consider retrieving more context or explicitly declaring gaps.`,
      };

      // Build 2.4: structured gaps
      const structuredGaps = result.gaps.map(g => ({
        subtopic: g.preview.slice(0, 80),
        suggested_query: g.preview.slice(0, 60),
        severity: g.relevance > 0.7 ? 'high' : g.relevance > 0.4 ? 'medium' : 'low',
        memory_id: g.id,
      }));

      return {
        text: JSON.stringify(wrapResponse({
          ...result,
          gaps: structuredGaps,
          temporal_health: temporalHealth,
          confidence_assessment: result.coverage_ratio >= 0.8
            ? 'high — most relevant context retrieved'
            : result.coverage_ratio >= 0.5
              ? 'medium — significant gaps remain'
              : 'low — most relevant context not yet retrieved',
          ...(autoRetrievedMemories ? { auto_retrieved: autoRetrievedMemories, auto_retrieve_count: autoRetrievedMemories.length } : {}),
        }, config, {
          data_absent: result.total_relevant === 0,
        })),
      };
    } catch {
      // Fallback: broad search + set difference
      const params = new URLSearchParams({ q: topic, user_id: config.userId, limit: '20' });
      const raw = await api.get<unknown>(`/memory/search?${params}`, true);
      const validated = validateSearchResponse(raw, '/memory/search');
      const allRelevant = validated.memories.map(m => {
        const mem = normalizeMemory(m);
        mem.workspace_id = config.workspaceId;
        return mem;
      });

      const retrievedSet = new Set(memoryIds);
      const covered = allRelevant.filter(m => retrievedSet.has(m.id));
      const uncovered = allRelevant.filter(m => !retrievedSet.has(m.id));
      const ratio = allRelevant.length > 0 ? covered.length / allRelevant.length : 1;

      const structuredGaps = uncovered.slice(0, 10).map(m => ({
        subtopic: m.content.slice(0, 80),
        suggested_query: m.content.slice(0, 60),
        severity: (m.relevance ?? 0) > 0.7 ? 'high' as const : (m.relevance ?? 0) > 0.4 ? 'medium' as const : 'low' as const,
        memory_id: m.id,
      }));

      return {
        text: JSON.stringify(wrapResponse({
          topic,
          total_relevant: allRelevant.length,
          retrieved_count: covered.length,
          coverage_ratio: Math.round(ratio * 100) / 100,
          gaps: structuredGaps,
          uncovered_entities: [],
          suggested_queries: [],
          _fallback: true,
          temporal_health: { stale_warning: false, evolution_detected: false, suggestion: 'Coverage computed via fallback (broad search).' },
          confidence_assessment: ratio >= 0.7 ? 'high' : ratio >= 0.5 ? 'medium' : 'low',
          ...(autoRetrievedMemories ? { auto_retrieved: autoRetrievedMemories, auto_retrieve_count: autoRetrievedMemories.length } : {}),
        }, config, {
          data_absent: allRelevant.length === 0,
        })),
      };
    }
  }

  throw new Error(`Unknown retrieval tool: ${name}`);
}
