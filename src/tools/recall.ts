// ── Recall Tools ──
// velixar_context — synthesized workspace brief (flagship)
// velixar_inspect — deep single-memory inspection

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ApiClient } from '../api.js';
import { normalizeMemory, wrapResponse } from '../api.js';
import type { ApiConfig, MemoryItem } from '../types.js';
import { justify } from '../justify.js';

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
    const searchQ = topic || 'important recent context';
    const params = new URLSearchParams({ q: searchQ, user_id: config.userId, limit: compact ? '5' : '10' });
    const listParams = new URLSearchParams({ user_id: config.userId, limit: '5' });

    const [searchRes, listRes, overviewRes, contradictionsRes] = await Promise.allSettled([
      api.get<{ memories?: Array<Record<string, unknown>>; count?: number }>(`/memory/search?${params}`, true),
      api.get<{ memories?: Array<Record<string, unknown>>; count?: number }>(`/memory/list?${listParams}`, true),
      api.get<Record<string, unknown>>('/exocortex/overview', true),
      api.get<{ contradictions?: Array<Record<string, unknown>> }>('/exocortex/contradictions?status=open', true),
    ]);

    const search = searchRes.status === 'fulfilled' ? searchRes.value : null;
    const list = listRes.status === 'fulfilled' ? listRes.value : null;
    const overview = overviewRes.status === 'fulfilled' ? overviewRes.value : null;
    const contradictions = contradictionsRes.status === 'fulfilled' ? contradictionsRes.value : null;

    // Normalize search results
    const relevantFacts = (search?.memories || []).map(m => {
      const mem = normalizeMemory(m as any);
      mem.workspace_id = config.workspaceId;
      return mem;
    });

    // Recent activity from list
    const recentItems = (list?.memories || []).map(m => {
      const mem = normalizeMemory(m as any);
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
        ? `Workspace has ${(overview as any).total_memories || 0} memories, ${(overview as any).cortex_nodes || 0} entities, ${(overview as any).temporal_chains || 0} chains. Mode: ${(overview as any).system_mode || 'unknown'}.`
        : `${relevantFacts.length} relevant facts found${topic ? ` for "${topic}"` : ''}.`,
      relevant_facts: relevantFacts,
      recent_activity: compact ? recentItems.slice(0, 3) : recentItems,
      open_issues: openContradictions,
      contradiction_count: openContradictions.length,
      pattern_hints: [] as string[],
      justification: justify(
        overview
          ? `Workspace context synthesis from ${(overview as any).total_memories || 0} memories`
          : `Context synthesis from ${relevantFacts.length} relevant facts`,
        'synthesized_summary',
        relevantFacts as MemoryItem[],
        config.workspaceId,
        { contradictionCount: openContradictions.length },
      ),
    };

    const partial = [searchRes, listRes, overviewRes, contradictionsRes].some(r => r.status === 'rejected');

    return {
      text: JSON.stringify(wrapResponse(brief, config, {
        data_absent: relevantFacts.length === 0 && recentItems.length === 0,
        partial_context: partial,
        contradictions_present: openContradictions.length > 0,
      })),
    };
  }

  if (name === 'velixar_inspect') {
    const id = args.memory_id as string;
    const result = await api.get<{ memory?: Record<string, unknown>; error?: string }>(`/memory/${id}`, true);
    if (result.error) throw new Error(result.error);
    if (!result.memory) throw new Error(`Memory ${id} not found`);

    const mem = normalizeMemory(result.memory as any);
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
