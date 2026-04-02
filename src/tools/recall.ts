// ── Recall Tools ──
// velixar_context — synthesized workspace brief (flagship)
// velixar_inspect — deep single-memory inspection

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ApiClient } from '../api.js';
import { normalizeMemory, wrapResponse } from '../api.js';
import type { ApiConfig, MemoryItem } from '../types.js';
import { justify } from '../justify.js';
import { validateSearchResponse, validateListResponse, validateOverviewResponse } from '../validate.js';
import { temporalMerge, mergeMultiQueryResults } from '../temporal_merge.js';

export const recallTools: Tool[] = [
  {
    name: 'velixar_context',
    description:
      'Synthesize the best working brief for the current workspace. Use when broad orientation is needed — starting a task, resuming work, or unclear what is relevant. ' +
      'Do NOT use when you know the exact entity to inspect (use velixar_inspect) or have a specific search query (use velixar_search). ' +
      'Returns: summary, relevant facts, open issues, contradiction flags, pattern hints. ' +
      'This is the recommended first tool for any new task — orient, then narrow.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'Optional topic to focus the brief on' },
        compact: { type: 'boolean', description: 'Compact mode (default true) — shorter summary' },
      },
    },
  },
  {
    name: 'velixar_inspect',
    description:
      'Deep inspection of a specific memory — raw content, provenance, relations, chain links. ' +
      'Use to explain or debug a specific recall. Do NOT use for broad search (use velixar_search first to find IDs).',
    inputSchema: {
      type: 'object',
      properties: {
        memory_id: { type: 'string', description: 'Memory ID to inspect' },
      },
      required: ['memory_id'],
    },
  },
];

export async function handleRecallTool(
  name: string,
  args: Record<string, unknown>,
  api: ApiClient,
  config: ApiConfig,
): Promise<{ text: string; isError?: boolean }> {
  if (name === 'velixar_context') {
    const topic = (args.topic as string) || '';
    const compact = args.compact !== false;
    const multiAngle = process.env.VELIXAR_CONTEXT_MULTI_ANGLE === 'true';

    const listParams = new URLSearchParams({ user_id: config.userId, limit: '5' });
    const startMs = Date.now();

    // Build search queries — single or multi-angle based on feature flag
    let searchPromises: Array<Promise<unknown>>;
    if (multiAngle && topic) {
      const angles = [topic, `decisions about ${topic}`, `problems or issues with ${topic}`];
      const perAngleLimit = compact ? '3' : '5';
      searchPromises = angles.map(q => {
        const p = new URLSearchParams({ q, user_id: config.userId, limit: perAngleLimit });
        return api.get<unknown>(`/memory/search?${p}`, true);
      });
    } else if (multiAngle && !topic) {
      const angles = ['important recent context', 'open decisions', 'unresolved issues'];
      searchPromises = angles.map(q => {
        const p = new URLSearchParams({ q, user_id: config.userId, limit: compact ? '3' : '5' });
        return api.get<unknown>(`/memory/search?${p}`, true);
      });
    } else {
      const searchQ = topic || 'important recent context';
      const params = new URLSearchParams({ q: searchQ, user_id: config.userId, limit: compact ? '5' : '10' });
      searchPromises = [api.get<unknown>(`/memory/search?${params}`, true)];
    }

    const [searchResults, listRes, overviewRes, contradictionsRes] = await Promise.allSettled([
      Promise.allSettled(searchPromises),
      api.get<unknown>(`/memory/list?${listParams}`, true),
      api.get<unknown>('/exocortex/overview', true),
      api.get<unknown>('/exocortex/contradictions?status=open', true),
    ]);

    // Merge search results — multi-angle dedup or single pass
    let relevantFacts: MemoryItem[] = [];
    const searchAnglesUsed = searchPromises.length;
    if (searchResults.status === 'fulfilled') {
      const subResults = searchResults.value as PromiseSettledResult<unknown>[];
      if (multiAngle && subResults.length > 1) {
        // Multi-angle: merge + dedup via temporal_merge
        const perQuery = subResults.map((r, i) => {
          if (r.status !== 'fulfilled') return { query: `angle-${i}`, memories: [] as MemoryItem[] };
          try {
            const validated = validateSearchResponse(r.value, '/memory/search');
            return {
              query: `angle-${i}`,
              memories: validated.memories.map(m => { const mem = normalizeMemory(m); mem.workspace_id = config.workspaceId; return mem; }),
            };
          } catch { return { query: `angle-${i}`, memories: [] as MemoryItem[] }; }
        });
        const { merged } = mergeMultiQueryResults(perQuery, 'weighted', compact ? 8 : 15);
        const temporal = temporalMerge(merged);
        relevantFacts = temporal.current;
      } else {
        // Single angle
        const r = subResults[0];
        if (r && r.status === 'fulfilled') {
          try {
            const validated = validateSearchResponse(r.value, '/memory/search');
            relevantFacts = validated.memories.map(m => { const mem = normalizeMemory(m); mem.workspace_id = config.workspaceId; return mem; });
          } catch { /* empty */ }
        }
      }
    }

    // Sort: semantic first, then by relevance
    relevantFacts.sort((a, b) => {
      if (a.memory_type === 'semantic' && b.memory_type !== 'semantic') return -1;
      if (a.memory_type !== 'semantic' && b.memory_type === 'semantic') return 1;
      return (b.relevance ?? 0) - (a.relevance ?? 0);
    });

    const list = listRes.status === 'fulfilled' ? validateListResponse(listRes.value, '/memory/list') : null;
    const overview = overviewRes.status === 'fulfilled' ? validateOverviewResponse(overviewRes.value, '/exocortex/overview') : null;
    const contradictionsRaw = contradictionsRes.status === 'fulfilled'
      ? ((contradictionsRes.value && typeof contradictionsRes.value === 'object') ? contradictionsRes.value as Record<string, unknown> : {})
      : null;

    // Recent activity from list
    const recentItems = (list?.memories || []).map(m => {
      const mem = normalizeMemory(m);
      mem.workspace_id = config.workspaceId;
      return mem;
    });

    // Contradiction flags
    const rawCArr = contradictionsRaw ? (Array.isArray(contradictionsRaw.contradictions) ? contradictionsRaw.contradictions : []) : [];
    const openContradictions = rawCArr.map((c: any) => ({
      id: c.id,
      statement_a: c.statement_a || c.memory_a_content,
      statement_b: c.statement_b || c.memory_b_content,
      severity: c.severity || 'medium',
    }));

    // Build brief
    const brief = {
      summary: overview
        ? `Workspace has ${overview.total_memories || 0} memories, ${overview.cortex_nodes || 0} entities, ${overview.temporal_chains || 0} chains. Mode: ${overview.system_mode || 'unknown'}.`
        : `${relevantFacts.length} relevant facts found${topic ? ` for "${topic}"` : ''}.`,
      relevant_facts: relevantFacts,
      recent_activity: compact ? recentItems.slice(0, 3) : recentItems,
      open_issues: openContradictions,
      contradiction_count: openContradictions.length,
      pattern_hints: [] as string[],
      // Phase 4: Multi-angle search metadata
      ...(multiAngle ? { search_angles_used: searchAnglesUsed } : {}),
      section_freshness: {
        relevant_facts: { source: multiAngle ? 'multi_angle_search' : 'search', fetched_at: new Date().toISOString() },
        recent_activity: { source: 'list', fetched_at: new Date().toISOString() },
        overview: overviewRes.status === 'fulfilled' ? { source: 'overview', fetched_at: new Date().toISOString() } : { source: 'overview', status: 'unavailable' },
        contradictions: contradictionsRes.status === 'fulfilled' ? { source: 'contradictions', fetched_at: new Date().toISOString() } : { source: 'contradictions', status: 'unavailable' },
      },
      justification: justify(
        overview
          ? `Workspace context synthesis from ${overview.total_memories || 0} memories`
          : `Context synthesis from ${relevantFacts.length} relevant facts`,
        'synthesized_summary',
        relevantFacts as MemoryItem[],
        config.workspaceId,
        { contradictionCount: openContradictions.length },
      ),
    };

    const partial = [searchResults, listRes, overviewRes, contradictionsRes].some(r => r.status === 'rejected');
    const contextMs = Date.now() - startMs;

    return {
      text: JSON.stringify(wrapResponse(brief, config, {
        data_absent: relevantFacts.length === 0 && recentItems.length === 0,
        partial_context: partial,
        contradictions_present: openContradictions.length > 0,
        request_ms: contextMs,
      })),
    };
  }

  if (name === 'velixar_inspect') {
    const id = args.memory_id as string;
    const raw = await api.get<unknown>(`/memory/${id}`, true);
    if (!raw || typeof raw !== 'object') throw new Error(`Memory ${id} not found`);
    const result = raw as Record<string, unknown>;
    if (result.error) throw new Error(String(result.error));
    if (!result.memory || typeof result.memory !== 'object') throw new Error(`Memory ${id} not found`);

    const rawMem = result.memory as Record<string, unknown>;
    const mem = normalizeMemory({
      id: String(rawMem.id || ''),
      content: String(rawMem.content || ''),
      score: typeof rawMem.score === 'number' ? rawMem.score : undefined,
      tier: typeof rawMem.tier === 'number' ? rawMem.tier : undefined,
      type: typeof rawMem.type === 'string' ? rawMem.type : null,
      tags: Array.isArray(rawMem.tags) ? rawMem.tags.filter((t): t is string => typeof t === 'string') : [],
      salience: typeof rawMem.salience === 'number' ? rawMem.salience : undefined,
      created_at: typeof rawMem.created_at === 'string' ? rawMem.created_at : undefined,
      updated_at: typeof rawMem.updated_at === 'string' ? rawMem.updated_at : undefined,
      previous_memory_id: typeof rawMem.previous_memory_id === 'string' ? rawMem.previous_memory_id : null,
    });
    mem.workspace_id = config.workspaceId;

    // H17: Validate provenance — check derived_from IDs exist
    let provenanceStatus: Array<{ id: string; status: 'exists' | 'deleted' }> | undefined;
    if (mem.provenance.derived_from?.length) {
      const checks = await Promise.allSettled(
        mem.provenance.derived_from.map(refId =>
          api.get<unknown>(`/memory/${refId}`, true),
        ),
      );
      provenanceStatus = mem.provenance.derived_from.map((refId, i) => {
        if (checks[i].status !== 'fulfilled') return { id: refId, status: 'deleted' as const };
        const val = checks[i].status === 'fulfilled' ? (checks[i] as PromiseFulfilledResult<unknown>).value : null;
        const hasMemory = val && typeof val === 'object' && 'memory' in (val as Record<string, unknown>) && (val as Record<string, unknown>).memory;
        return { id: refId, status: hasMemory ? 'exists' as const : 'deleted' as const };
      });
    }

    const justification = justify(
      `Inspection of memory ${id}`,
      'retrieved_fact',
      [mem] as MemoryItem[],
      config.workspaceId,
    );

    return { text: JSON.stringify(wrapResponse({ memory: mem, justification, ...(provenanceStatus ? { provenance_validation: provenanceStatus } : {}) }, config)) };
  }

  throw new Error(`Unknown recall tool: ${name}`);
}
