// ── Recall Tools ──
// velixar_context — synthesized workspace brief (flagship)
// velixar_inspect — deep single-memory inspection

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ApiClient } from '../api.js';
import { normalizeMemory, wrapResponse } from '../api.js';
import type { ApiConfig, MemoryItem } from '../types.js';
import { justify } from '../justify.js';
import { validateSearchResponse, validateListResponse, validateOverviewResponse } from '../validate.js';

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

    // Parallel fetch: search (topic or general), recent list, overview, contradictions
    // Returns partial results if some fail — time-to-first-useful-context optimization
    const searchQ = topic || 'important recent context';
    const params = new URLSearchParams({ q: searchQ, user_id: config.userId, limit: compact ? '5' : '10' });
    const listParams = new URLSearchParams({ user_id: config.userId, limit: '5' });

    const startMs = Date.now();
    const [searchRes, listRes, overviewRes, contradictionsRes] = await Promise.allSettled([
      api.get<unknown>(`/memory/search?${params}`, true),
      api.get<unknown>(`/memory/list?${listParams}`, true),
      api.get<unknown>('/exocortex/overview', true),
      api.get<{ contradictions?: Array<Record<string, unknown>> }>('/exocortex/contradictions?status=open', true),
    ]);

    const search = searchRes.status === 'fulfilled' ? validateSearchResponse(searchRes.value, '/memory/search') : null;
    const list = listRes.status === 'fulfilled' ? validateListResponse(listRes.value, '/memory/list') : null;
    const overview = overviewRes.status === 'fulfilled' ? validateOverviewResponse(overviewRes.value, '/exocortex/overview') : null;
    const contradictions = contradictionsRes.status === 'fulfilled' ? contradictionsRes.value : null;

    // Normalize search results — prefer semantic for context, episodic for evidence
    const relevantFacts = (search?.memories || []).map(m => {
      const mem = normalizeMemory(m);
      mem.workspace_id = config.workspaceId;
      return mem;
    });
    // Sort: semantic first (context injection), then episodic (evidence citations)
    relevantFacts.sort((a, b) => {
      if (a.memory_type === 'semantic' && b.memory_type !== 'semantic') return -1;
      if (a.memory_type !== 'semantic' && b.memory_type === 'semantic') return 1;
      return (b.relevance ?? 0) - (a.relevance ?? 0);
    });

    // Recent activity from list
    const recentItems = (list?.memories || []).map(m => {
      const mem = normalizeMemory(m);
      mem.workspace_id = config.workspaceId;
      return mem;
    });

    // Contradiction flags
    const openContradictions = (contradictions?.contradictions || []).map((c: any) => ({
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

    const partial = [searchRes, listRes, overviewRes, contradictionsRes].some(r => r.status === 'rejected');
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

    const justification = justify(
      `Inspection of memory ${id}`,
      'retrieved_fact',
      [mem] as MemoryItem[],
      config.workspaceId,
    );

    return { text: JSON.stringify(wrapResponse({ memory: mem, justification }, config)) };
  }

  throw new Error(`Unknown recall tool: ${name}`);
}
