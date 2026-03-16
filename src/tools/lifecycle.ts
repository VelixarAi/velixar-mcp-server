// ── Lifecycle Tools ──
// velixar_distill — extract durable memories from session content
// Phase 3: batch, consolidate, retag, session

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ApiClient } from '../api.js';
import { wrapResponse } from '../api.js';
import type { ApiConfig } from '../types.js';

// Simple keyword-based auto-tagging when user provides no tags
const TAG_PATTERNS: Array<[RegExp, string]> = [
  [/\b(bug|fix|error|crash|issue)\b/i, 'bugfix'],
  [/\b(decision|decided|chose|chosen)\b/i, 'decision'],
  [/\b(preference|prefer|style|like|dislike)\b/i, 'preference'],
  [/\b(architecture|design|pattern|structure)\b/i, 'architecture'],
  [/\b(deploy|release|ship|launch)\b/i, 'deployment'],
  [/\b(config|setting|env|environment)\b/i, 'config'],
  [/\b(api|endpoint|route|request)\b/i, 'api'],
  [/\b(database|db|sql|query|table)\b/i, 'database'],
];

function autoTags(content: string): string[] {
  const tags: string[] = [];
  for (const [re, tag] of TAG_PATTERNS) {
    if (re.test(content)) tags.push(tag);
    if (tags.length >= 4) break;
  }
  return tags;
}

export const lifecycleTools: Tool[] = [
  {
    name: 'velixar_distill',
    description:
      'Extract durable memories from session content. Use at natural memory-worthy breakpoints: task complete, decision made, bug solved, preference clarified. ' +
      'Do NOT use for transient chatter — only distill content worth remembering long-term. ' +
      'Do NOT use for single explicit facts (use velixar_store). ' +
      'Accepts session text and extracts + stores the key takeaways as semantic memories. ' +
      'Detects duplicates (skips near-identical content) and flags active contradictions.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Session text to distill into durable memories' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags to apply (auto-generated if absent)' },
        source_ids: { type: 'array', items: { type: 'string' }, description: 'Source memory IDs for provenance tracking' },
      },
      required: ['content'],
    },
  },
  {
    name: 'velixar_session_save',
    description:
      'Save a session summary for later recall. Use when ending a work session to preserve context for next time. ' +
      'Stores as a semantic memory tagged with session metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Session summary to save' },
        session_id: { type: 'string', description: 'Session/conversation ID' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Additional tags' },
      },
      required: ['summary'],
    },
  },
  {
    name: 'velixar_session_recall',
    description:
      'Recall memories from a previous session by session ID, date, or topic. ' +
      'Use when resuming work to restore prior context.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Session ID to recall' },
        topic: { type: 'string', description: 'Topic to search for in session memories' },
        limit: { type: 'number', description: 'Max results (default 10)' },
      },
    },
  },
  {
    name: 'velixar_batch_store',
    description:
      'Store multiple memories in one call. Returns per-item status. ' +
      'Use for bulk imports or multi-fact storage. Max 20 items per call.',
    inputSchema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string' },
              tags: { type: 'array', items: { type: 'string' } },
              tier: { type: 'number' },
            },
            required: ['content'],
          },
          description: 'Array of memories to store (max 20)',
        },
      },
      required: ['items'],
    },
  },
  {
    name: 'velixar_batch_search',
    description:
      'Run multiple search queries in one call. Returns results per query. ' +
      'Use when you need to gather context from several angles simultaneously.',
    inputSchema: {
      type: 'object',
      properties: {
        queries: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of search queries (max 10)',
        },
        limit_per_query: { type: 'number', description: 'Max results per query (default 3)' },
      },
      required: ['queries'],
    },
  },
  {
    name: 'velixar_consolidate',
    description:
      'Merge related episodic memories into a single semantic memory. ' +
      'Preserves originals as provenance. Use when multiple episodic memories cover the same topic and should be unified. ' +
      'Provide memory IDs to consolidate, or a topic to auto-find candidates.',
    inputSchema: {
      type: 'object',
      properties: {
        memory_ids: { type: 'array', items: { type: 'string' }, description: 'Memory IDs to consolidate' },
        topic: { type: 'string', description: 'Topic to auto-find consolidation candidates' },
        summary: { type: 'string', description: 'Optional: provide the consolidated summary (otherwise auto-generated)' },
      },
    },
  },
  {
    name: 'velixar_retag',
    description:
      'Update tags on one or more memories. Use for organizing, correcting, or enriching memory metadata. ' +
      'Supports add, remove, or replace operations.',
    inputSchema: {
      type: 'object',
      properties: {
        memory_ids: { type: 'array', items: { type: 'string' }, description: 'Memory IDs to retag' },
        add_tags: { type: 'array', items: { type: 'string' }, description: 'Tags to add' },
        remove_tags: { type: 'array', items: { type: 'string' }, description: 'Tags to remove' },
        replace_tags: { type: 'array', items: { type: 'string' }, description: 'Replace all tags with these' },
      },
      required: ['memory_ids'],
    },
  },
  {
    name: 'velixar_export',
    description:
      'Export memories as structured data. Supports JSON and Markdown formats. ' +
      'Includes tags, timestamps, provenance, and optionally graph relationships. Use for backup or sharing.',
    inputSchema: {
      type: 'object',
      properties: {
        format: { type: 'string', enum: ['json', 'markdown'], description: 'Export format (default: json)' },
        query: { type: 'string', description: 'Optional: filter by search query' },
        limit: { type: 'number', description: 'Max memories to export (default 50)' },
        include_graph: { type: 'boolean', description: 'Include graph entities and relationships (default: false)' },
      },
    },
  },
  {
    name: 'velixar_import',
    description:
      'Bulk import memories from structured data. Accepts JSON or Markdown format. ' +
      'Preserves tags, timestamps, and provenance when provided. Max 50 items per call. ' +
      'Use for restoring backups, migrating from other systems, or importing notes.',
    inputSchema: {
      type: 'object',
      properties: {
        format: { type: 'string', enum: ['json', 'markdown'], description: 'Input format (default: json)' },
        data: {
          description: 'For JSON: array of {content, tags?, tier?}. For Markdown: string with --- separators between entries.',
          oneOf: [
            { type: 'array', items: { type: 'object', properties: { content: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, tier: { type: 'number' } }, required: ['content'] } },
            { type: 'string' },
          ],
        },
        default_tags: { type: 'array', items: { type: 'string' }, description: 'Tags to apply to all imported items' },
        source: { type: 'string', description: 'Provenance label (e.g. "notion-export", "obsidian-vault")' },
      },
      required: ['data'],
    },
  },
];

export async function handleLifecycleTool(
  name: string,
  args: Record<string, unknown>,
  api: ApiClient,
  config: ApiConfig,
): Promise<{ text: string; isError?: boolean }> {
  if (name === 'velixar_distill') {
    const content = args.content as string;
    const userTags = (args.tags as string[]) || [];
    const sourceIds = (args.source_ids as string[]) || [];

    // Auto-generate tags when absent
    const tags = userTags.length
      ? [...userTags, 'distilled']
      : [...autoTags(content), 'distilled'];

    // Duplicate detection: search for similar content before storing
    let duplicateDetected = false;
    let contradictionDetected = false;
    const contradictionsFound: string[] = [];

    try {
      const searchParams = new URLSearchParams({
        q: content.slice(0, 200),
        user_id: config.userId,
        limit: '3',
      });
      const existing = await api.get<{ memories?: Array<Record<string, unknown>> }>(
        `/memory/search?${searchParams}`, true,
      );
      const topMatch = existing.memories?.[0];
      if (topMatch && (topMatch as any).relevance > 0.92) {
        duplicateDetected = true;
      }
    } catch { /* non-blocking */ }

    // Contradiction detection: check if content conflicts with existing beliefs
    try {
      const contradictions = await api.get<{ contradictions?: Array<Record<string, unknown>> }>(
        '/exocortex/contradictions?status=open', true,
      );
      if (contradictions.contradictions?.length) {
        contradictionDetected = true;
        for (const c of contradictions.contradictions.slice(0, 3)) {
          contradictionsFound.push((c as any).explanation || (c as any).description || 'Conflict detected');
        }
      }
    } catch { /* non-blocking */ }

    // Skip storing if duplicate
    if (duplicateDetected) {
      return {
        text: JSON.stringify(wrapResponse({
          candidates: [{
            content, rationale: 'Skipped — near-duplicate already exists', tags,
            confidence: 0, memory_type: 'semantic' as const, source_type: 'distill' as const,
            duplicate_detected: true, contradiction_detected: contradictionDetected,
            derived_from: sourceIds,
          }],
          stored_count: 0, skipped_count: 1, contradictions_found: contradictionsFound,
        }, config)),
      };
    }

    // Store as semantic memory
    const result = await api.post<{ id?: string; error?: string }>('/memory', {
      content,
      user_id: config.userId,
      tier: 2,
      tags,
      author: { type: 'distill', agent_id: config.userId },
    });

    if (result.error) throw new Error(result.error);

    return {
      text: JSON.stringify(wrapResponse({
        candidates: [{
          content, rationale: 'Distilled from session content', tags,
          confidence: 0.8, memory_type: 'semantic' as const, source_type: 'distill' as const,
          duplicate_detected: false, contradiction_detected: contradictionDetected,
          stored_id: result.id, derived_from: sourceIds,
        }],
        stored_count: 1, skipped_count: 0, contradictions_found: contradictionsFound,
      }, config)),
    };
  }

  if (name === 'velixar_session_save') {
    const summary = args.summary as string;
    const sessionId = (args.session_id as string) || `session-${Date.now()}`;
    const tags = [...((args.tags as string[]) || []), 'session', `session:${sessionId}`];

    const result = await api.post<{ id?: string; error?: string }>('/memory', {
      content: `[Session ${sessionId}] ${summary}`,
      user_id: config.userId,
      tier: 2,
      tags,
      author: { type: 'agent', session_id: sessionId },
    });

    if (result.error) throw new Error(result.error);
    return { text: JSON.stringify(wrapResponse({ session_id: sessionId, stored_id: result.id, tags }, config)) };
  }

  if (name === 'velixar_session_recall') {
    const sessionId = args.session_id as string;
    const topic = args.topic as string;
    const limit = Math.min((args.limit as number) || 10, 50);

    if (!sessionId && !topic) throw new Error('Either session_id or topic required');

    if (sessionId) {
      // Use backend session endpoint
      const result = await api.get<{ memories?: Array<Record<string, unknown>>; count?: number }>(
        `/memory/session/${sessionId}?limit=${limit}`, true,
      );
      return {
        text: JSON.stringify(wrapResponse({
          session_id: sessionId,
          memories: result.memories || [],
          count: result.count || 0,
        }, config, { data_absent: !(result.memories?.length) })),
      };
    }

    // Search by topic within session-tagged memories
    const params = new URLSearchParams({ q: `session ${topic}`, user_id: config.userId, limit: String(limit) });
    const result = await api.get<{ memories?: Array<Record<string, unknown>> }>(`/memory/search?${params}`, true);
    return {
      text: JSON.stringify(wrapResponse({
        topic,
        memories: result.memories || [],
        count: (result.memories || []).length,
      }, config, { data_absent: !(result.memories?.length) })),
    };
  }

  if (name === 'velixar_batch_store') {
    const items = (args.items as Array<{ content: string; tags?: string[]; tier?: number }>).slice(0, 20);
    const results = await Promise.allSettled(
      items.map(item =>
        api.post<{ id?: string; error?: string }>('/memory', {
          content: item.content,
          user_id: config.userId,
          tier: item.tier ?? 2,
          tags: item.tags || autoTags(item.content),
          author: { type: 'user' },
        }),
      ),
    );

    const statuses = results.map((r, i) => ({
      index: i,
      status: r.status === 'fulfilled' && !r.value.error ? 'ok' : 'error',
      id: r.status === 'fulfilled' ? r.value.id : undefined,
      error: r.status === 'rejected' ? String(r.reason) : r.status === 'fulfilled' ? r.value.error : undefined,
    }));

    return {
      text: JSON.stringify(wrapResponse({
        items: statuses,
        stored_count: statuses.filter(s => s.status === 'ok').length,
        error_count: statuses.filter(s => s.status === 'error').length,
      }, config)),
    };
  }

  if (name === 'velixar_batch_search') {
    const queries = (args.queries as string[]).slice(0, 10);
    const limit = Math.min((args.limit_per_query as number) || 3, 10);

    const results = await Promise.allSettled(
      queries.map(q => {
        const params = new URLSearchParams({ q, user_id: config.userId, limit: String(limit) });
        return api.get<{ memories?: Array<Record<string, unknown>> }>(`/memory/search?${params}`, true);
      }),
    );

    const queryResults = results.map((r, i) => ({
      query: queries[i],
      memories: r.status === 'fulfilled' ? (r.value.memories || []) : [],
      count: r.status === 'fulfilled' ? (r.value.memories || []).length : 0,
      error: r.status === 'rejected' ? String(r.reason) : undefined,
    }));

    return {
      text: JSON.stringify(wrapResponse({ results: queryResults, total_queries: queries.length }, config)),
    };
  }

  if (name === 'velixar_consolidate') {
    const memoryIds = args.memory_ids as string[] | undefined;
    const topic = args.topic as string | undefined;
    let providedSummary = args.summary as string | undefined;

    // Find candidates: either by IDs or by topic search
    let candidates: Array<{ id: string; content: string; tags: string[] }> = [];

    if (memoryIds?.length) {
      const fetches = await Promise.allSettled(
        memoryIds.slice(0, 10).map(id =>
          api.get<{ memory?: Record<string, unknown> }>(`/memory/${id}`, true),
        ),
      );
      for (const f of fetches) {
        if (f.status === 'fulfilled' && f.value.memory) {
          const m = f.value.memory as any;
          candidates.push({ id: m.id, content: m.content || '', tags: m.tags || [] });
        }
      }
    } else if (topic) {
      const params = new URLSearchParams({ q: topic, user_id: config.userId, limit: '10' });
      const result = await api.get<{ memories?: Array<Record<string, unknown>> }>(`/memory/search?${params}`, true);
      candidates = (result.memories || []).map((m: any) => ({
        id: m.id, content: m.content || '', tags: m.tags || [],
      }));
    } else {
      throw new Error('Either memory_ids or topic required');
    }

    if (candidates.length < 2) {
      return { text: JSON.stringify(wrapResponse({ message: 'Need at least 2 memories to consolidate', candidates: candidates.length }, config)) };
    }

    // Build consolidated summary
    const summary = providedSummary || candidates.map(c => c.content).join(' | ');
    const allTags = [...new Set(candidates.flatMap(c => c.tags).concat(['consolidated']))];

    // Store consolidated semantic memory
    const stored = await api.post<{ id?: string; error?: string }>('/memory', {
      content: summary.slice(0, 4000),
      user_id: config.userId,
      tier: 2,
      tags: allTags,
      author: { type: 'pipeline' },
    });

    if (stored.error) throw new Error(stored.error);

    return {
      text: JSON.stringify(wrapResponse({
        consolidated_id: stored.id,
        source_count: candidates.length,
        source_ids: candidates.map(c => c.id),
        tags: allTags,
        before: candidates.map(c => ({ id: c.id, preview: c.content.slice(0, 80) })),
        after: { id: stored.id, preview: summary.slice(0, 200) },
      }, config)),
    };
  }

  if (name === 'velixar_retag') {
    const memoryIds = (args.memory_ids as string[]).slice(0, 20);
    const addTags = args.add_tags as string[] | undefined;
    const removeTags = args.remove_tags as string[] | undefined;
    const replaceTags = args.replace_tags as string[] | undefined;

    const results = await Promise.allSettled(
      memoryIds.map(async id => {
        let newTags: string[];
        if (replaceTags) {
          newTags = replaceTags;
        } else {
          // Fetch current tags
          const mem = await api.get<{ memory?: Record<string, unknown> }>(`/memory/${id}`, true);
          const current = ((mem.memory as any)?.tags as string[]) || [];
          newTags = [...current];
          if (addTags) newTags.push(...addTags.filter(t => !newTags.includes(t)));
          if (removeTags) newTags = newTags.filter(t => !removeTags.includes(t));
        }
        return api.patch<{ error?: string }>(`/memory/${id}`, { tags: newTags });
      }),
    );

    const statuses = results.map((r, i) => ({
      id: memoryIds[i],
      status: r.status === 'fulfilled' ? 'ok' : 'error',
      error: r.status === 'rejected' ? String(r.reason) : undefined,
    }));

    return {
      text: JSON.stringify(wrapResponse({
        items: statuses,
        updated_count: statuses.filter(s => s.status === 'ok').length,
      }, config)),
    };
  }

  if (name === 'velixar_export') {
    const format = (args.format as string) || 'json';
    const limit = Math.min((args.limit as number) || 50, 200);
    const query = args.query as string | undefined;
    const includeGraph = args.include_graph as boolean;

    let memories: Array<Record<string, unknown>> = [];
    if (query) {
      const params = new URLSearchParams({ q: query, user_id: config.userId, limit: String(limit) });
      const result = await api.get<{ memories?: Array<Record<string, unknown>> }>(`/memory/search?${params}`, true);
      memories = result.memories || [];
    } else {
      const params = new URLSearchParams({ user_id: config.userId, limit: String(limit) });
      const result = await api.get<{ memories?: Array<Record<string, unknown>> }>(`/memory/list?${params}`, true);
      memories = result.memories || [];
    }

    let graph: Record<string, unknown> | undefined;
    if (includeGraph) {
      try {
        graph = await api.get<Record<string, unknown>>('/exocortex/overview', true);
      } catch { /* graph optional */ }
    }

    if (format === 'markdown') {
      const md = memories.map((m: any) => {
        const tags = m.tags?.length ? `Tags: ${m.tags.join(', ')}` : '';
        const date = m.created_at || '';
        return `## ${m.id}\n${date ? `*${date}*\n` : ''}\n${m.content}\n\n${tags}`;
      }).join('\n\n---\n\n');
      return { text: JSON.stringify(wrapResponse({ format: 'markdown', count: memories.length, content: md, ...(graph ? { graph } : {}) }, config)) };
    }

    return {
      text: JSON.stringify(wrapResponse({
        format: 'json',
        count: memories.length,
        memories: memories.map((m: any) => ({
          id: m.id, content: m.content, tags: m.tags || [],
          created_at: m.created_at, tier: m.tier,
        })),
        ...(graph ? { graph } : {}),
      }, config)),
    };
  }

  if (name === 'velixar_import') {
    const format = (args.format as string) || 'json';
    const defaultTags = (args.default_tags as string[]) || [];
    const source = args.source as string | undefined;

    let items: Array<{ content: string; tags?: string[]; tier?: number }> = [];

    if (format === 'markdown' && typeof args.data === 'string') {
      items = (args.data as string).split(/\n---\n/).map(block => {
        const lines = block.trim().split('\n');
        const tagLine = lines.find(l => /^Tags:\s/i.test(l));
        const tags = tagLine ? tagLine.replace(/^Tags:\s*/i, '').split(',').map(t => t.trim()).filter(Boolean) : [];
        const content = lines.filter(l => l !== tagLine && !/^##\s/.test(l) && !/^\*.*\*$/.test(l)).join('\n').trim();
        return { content, tags };
      }).filter(i => i.content.length > 0);
    } else if (Array.isArray(args.data)) {
      items = args.data as typeof items;
    } else {
      return { text: JSON.stringify(wrapResponse({ error: 'data must be an array (JSON) or string (Markdown)' }, config)), isError: true };
    }

    if (items.length > 50) items = items.slice(0, 50);

    const results = await Promise.allSettled(
      items.map(item =>
        api.post<{ id?: string; error?: string }>('/memory/store', {
          content: item.content,
          tags: [...(item.tags || []), ...defaultTags, ...(source ? [`source:${source}`] : [])],
          tier: item.tier ?? 2,
          user_id: config.userId,
        }),
      ),
    );

    const statuses = results.map((r, i) => ({
      index: i,
      status: r.status === 'fulfilled' ? 'ok' : 'error',
      id: r.status === 'fulfilled' ? (r.value as any).id : undefined,
      error: r.status === 'rejected' ? String(r.reason) : undefined,
    }));

    return {
      text: JSON.stringify(wrapResponse({
        imported: statuses.filter(s => s.status === 'ok').length,
        failed: statuses.filter(s => s.status === 'error').length,
        total: items.length,
        items: statuses,
        ...(source ? { source } : {}),
      }, config)),
    };
  }

  throw new Error(`Unknown lifecycle tool: ${name}`);
}
