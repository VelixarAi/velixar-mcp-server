// ── Memory CRUD Tools ──
// store, search, list, update, delete
// Phase 0: Added tags, before, after, tier filters (backend-side via Qdrant).
// H1.5: _warnings array when backend may not support filter params.

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ApiClient } from '../api.js';
import { getClientSlug, normalizeMemory, userParams, withUser, wrapResponse } from '../api.js';
import type { ApiConfig } from '../types.js';
import { validateStoreResponse, validateSearchResponse, validateListResponse, validateMutationResponse } from '../validate.js';

// H1.5: Track warned params to avoid cluttering every response
const _warnedParams = new Set<string>();

// H6.1/Chain 9: _baseFilter — single source of truth for building search/list query params
// All retrieval handlers must use this instead of constructing URLSearchParams directly.
export function _baseFilter(config: ApiConfig, args: Record<string, unknown>): URLSearchParams {
  const params = userParams(config, {  });
  if (args.limit) params.set('limit', String(args.limit));
  if (args.tags) params.set('tags', (args.tags as string[]).join(','));
  if (args.before) params.set('before', args.before as string);
  if (args.after) params.set('after', args.after as string);
  if (args.tier !== undefined) params.set('tier', String(args.tier));
  if (args.sort) params.set('sort', args.sort as string);
  return params;
}

export const memoryTools: Tool[] = [
  {
    name: 'velixar_store',
    description:
      'Store a memory for later retrieval. Use for important facts, decisions, user preferences, project context, or anything worth remembering long-term. ' +
      'Memories are workspace-scoped and persist across sessions. ' +
      'Use check_duplicate: true when storing content that may overlap with existing memories.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The memory content to store' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags for categorization' },
        tier: { type: 'number', description: 'Memory tier: 0=pinned, 1=session, 2=semantic (default), 3=org' },
        quarantine_zone: { type: 'string', description: 'Optional quarantine zone ID. Memory will only be visible to zone members.' },
        check_duplicate: { type: 'boolean', description: 'Exact byte-duplicates are BLOCKED server-side (existing id returned, nothing written); near-duplicates above dedup_threshold warn but still store.' },
        dedup_threshold: { type: 'number', description: 'Similarity threshold for duplicate detection (default: 0.95). Only used when check_duplicate is true.' },
        source: { type: 'string', description: 'Provenance label (e.g., "user-stated", "derived-from-analysis")' },
        source_ids: { type: 'array', items: { type: 'string' }, description: 'DERIVATION lineage — the memory IDs this new memory was reasoned/built FROM (e.g. you learned context B from context A). An explicit, directed "derived-from" edge, DISTINCT from semantic similarity and from the temporal previous-memory chain. Omit for an origin memory (learned fresh, no prior context). Query the resulting graph with velixar_lineage.' },
        atomic: { type: 'boolean', description: 'Store as a single unit — never split into chunks. Use for poems, quotes, structured data that must stay whole.' },
      },
      required: ['content'],
    },
  },
  {
    name: 'velixar_search',
    description:
      'Search stored memories by semantic similarity. Returns ranked results with relevance scores. ' +
      'Supports filtering by tags, date range, tier, and memory type.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        limit: { type: 'number', description: 'Max results (default 5)' },
        memory_type: { type: 'string', enum: ['episodic', 'semantic'], description: 'Filter by memory type' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Filter by tags (AND logic — memory must have all specified tags)' },
        before: { type: 'string', description: 'ISO timestamp — only return memories created before this time' },
        after: { type: 'string', description: 'ISO timestamp — only return memories created after this time' },
        tier: { type: 'number', description: 'Filter by memory tier (0=pinned, 1=session, 2=semantic, 3=org)' },
        full_content: { type: 'boolean', description: 'Reassemble chunked memories into full content (default: false). Use for poems, essays, or content that must be returned whole.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'velixar_list',
    description:
      'List recent memories with pagination. Returns full metadata including IDs, tags, and timestamps. ' +
      'Supports filtering by tags, date range, tier, and memory type.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max results (default 10)' },
        cursor: { type: 'string', description: 'Pagination cursor from previous response' },
        memory_type: { type: 'string', enum: ['episodic', 'semantic'], description: 'Filter by memory type' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Filter by tags (AND logic)' },
        before: { type: 'string', description: 'ISO timestamp — only return memories created before this time' },
        after: { type: 'string', description: 'ISO timestamp — only return memories created after this time' },
        tier: { type: 'number', description: 'Filter by memory tier (0=pinned, 1=session, 2=semantic, 3=org)' },
        sort: { type: 'string', enum: ['recent', 'oldest', 'tier'], description: 'Sort order (default: recent)' },
        count_only: { type: 'boolean', description: 'Return only the total count, no memory content' },
      },
      required: [],
    },
  },
  {
    name: 'velixar_update',
    description: "Update an existing memory's content or tags.",
    inputSchema: {
      type: 'object',
      properties: {
        memory_id: { type: 'string', description: 'Memory ID to update' },
        id: { type: 'string', description: 'Alias for memory_id (backward compat)' },
        content: { type: 'string', description: 'New content' },
        tags: { type: 'array', items: { type: 'string' }, description: 'New tags' },
      },
    },
  },
  {
    name: 'velixar_delete',
    description: 'Delete or archive memories. Use archive: true for soft-delete (recoverable).',
    inputSchema: {
      type: 'object',
      properties: {
        memory_id: { type: 'string', description: 'Memory ID to delete (single)' },
        id: { type: 'string', description: 'Alias for memory_id (backward compat)' },
        ids: { type: 'array', items: { type: 'string' }, description: 'Memory IDs to delete (bulk)' },
        archive: { type: 'boolean', description: 'Soft-delete: set archived=true instead of hard-deleting (default: false)' },
      },
    },
  },
];

export async function handleMemoryTool(
  name: string,
  args: Record<string, unknown>,
  api: ApiClient,
  config: ApiConfig,
): Promise<{ text: string; isError?: boolean }> {
  if (name === 'velixar_store') {
    // Build 1.1: Opt-in dedup check
    let similar_existing: { id: string; content_preview: string; similarity: number; threshold_used: number } | null = null;
    if (args.check_duplicate) {
      const threshold = (args.dedup_threshold as number) ?? 0.95;
      try {
        const content = args.content as string;
        // Skip dedup for very long content (embedding token limit)
        if (content.length < 25000) {
          const searchParams = userParams(config, { q: content.slice(0, 500), limit: '1' });
          const searchRaw = await api.get<unknown>(`/memory/search?${searchParams}`, false);
          const searchResult = validateSearchResponse(searchRaw, '/memory/search');
          if (searchResult.memories.length > 0) {
            const top = searchResult.memories[0];
            const score = top.score ?? 0;
            if (score >= threshold) {
              similar_existing = {
                id: top.id,
                content_preview: (top.content || '').slice(0, 200),
                similarity: Math.round(score * 1000) / 1000,
                threshold_used: threshold,
              };
            }
          }
        }
      } catch {
        // Dedup check failed — store anyway (H2.7: graceful fallback)
      }
    }

    // Build 1.2: Provenance params
    const storeBody: Record<string, unknown> = withUser(config, {
      content: args.content,
      tier: (args.tier as number) ?? 2,
      tags: (args.tags as string[]) || [],
      author: { type: 'agent', agent_id: config.userId ?? getClientSlug() ?? 'mcp' },
      source_type: (args.source as string) || 'mcp_store',
      quarantine_zone: (args.quarantine_zone as string) || null,
      no_chunk: args.atomic === true,
      // Server enforces EXACT-duplicate blocking (content_hash match returns
      // the existing id, stored:false). The similarity search above stays as
      // the ADVISORY near-duplicate layer — two different promises, both kept.
      ...(args.check_duplicate ? { check_duplicate: true } : {}),
    });
    // Derivation lineage: source_ids are the memories this one was reasoned FROM.
    // Send them ALL, to their own `references` field — NOT previous_memory_id (that
    // is the temporal session chain, a different lineage). The prior code collapsed
    // the whole derivation set into previous_memory_id[0], losing every id past the
    // first and conflating "built on" with "came after".
    if (Array.isArray(args.source_ids) && args.source_ids.length) {
      storeBody.references = (args.source_ids as string[]).filter(Boolean);
    }

    const raw = await api.post<unknown>('/memory', storeBody);
    const rawObj = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {};
    if (rawObj.duplicate === true && rawObj.id) {
      return { text: JSON.stringify(wrapResponse(
        { id: String(rawObj.id), action: 'duplicate', message: 'Exact content already stored — existing id returned, nothing written.' },
        config,
      )) };
    }
    const result = validateStoreResponse(raw, '/memory');
    const responseData: Record<string, unknown> = { id: result.id, action: 'stored' };
    if (similar_existing) responseData.similar_existing = similar_existing;
    return { text: JSON.stringify(wrapResponse(responseData, config)) };
  }

  if (name === 'velixar_search') {
    const params = _baseFilter(config, args);
    params.set('q', args.query as string);
    if (args.full_content) params.set('reassemble', 'true');
    const raw = await api.get<unknown>(`/memory/search?${params}`, true);
    const result = validateSearchResponse(raw, '/memory/search');
    let items = result.memories.map(m => {
      const mem = normalizeMemory(m);
      mem.workspace_id = config.workspaceId;
      return mem;
    });
    if (args.memory_type) items = items.filter(m => m.memory_type === args.memory_type);
    // H1.5: Verify backend actually applied filters — warn if results don't match
    const _warnings: string[] = [];
    if (args.tags && items.length > 0) {
      const requiredTags = args.tags as string[];
      const unfiltered = items.filter(m => !requiredTags.every(t => m.tags.includes(t)));
      if (unfiltered.length > 0) {
        items = items.filter(m => requiredTags.every(t => m.tags.includes(t)));
        if (!_warnedParams.has('search:tags')) {
          _warnings.push('tags filter may not be fully supported by backend — applied client-side fallback');
          _warnedParams.add('search:tags');
        }
      }
    }
    return {
      text: JSON.stringify(wrapResponse(
        { items, count: items.length, ...(_warnings.length ? { _warnings } : {}) },
        config,
        { data_absent: items.length === 0 },
      )),
    };
  }

  if (name === 'velixar_list') {
    const params = _baseFilter(config, args);
    if (args.cursor) params.set('cursor', args.cursor as string);
    if (args.count_only) {
      // Ask the STORE for the count. Counting the returned page reported
      // "count: 19" for a corpus of thousands — a page length wearing a
      // count's name. Older backends without count_only 400 on the unknown
      // param; fall through to the labeled page-count then.
      params.set('count_only', 'true');
      try {
        const rawCount = await api.get<unknown>(`/memory/list?${params}`, false);
        const c = (rawCount && typeof rawCount === 'object') ? rawCount as Record<string, unknown> : {};
        if (c.count_only === true && typeof c.count === 'number') {
          return { text: JSON.stringify(wrapResponse({ count: c.count }, config)) };
        }
      } catch { /* backend predates count_only — fall through */ }
      params.delete('count_only');
    }
    const raw = await api.get<unknown>(`/memory/list?${params}`, true);
    const result = validateListResponse(raw, '/memory/list');
    let items = result.memories.map(m => {
      const mem = normalizeMemory(m);
      mem.workspace_id = config.workspaceId;
      return mem;
    });
    if (args.memory_type) items = items.filter(m => m.memory_type === args.memory_type);
    if (args.count_only) {
      return { text: JSON.stringify(wrapResponse(
        { count: items.length, count_is: 'first page only — backend count unavailable' }, config)) };
    }
    return {
      text: JSON.stringify(wrapResponse(
        { items, count: items.length, cursor: result.cursor },
        config,
        { data_absent: items.length === 0 },
      )),
    };
  }

  if (name === 'velixar_update') {
    const memoryId = (args.memory_id || args.id) as string;
    if (!memoryId) throw new Error('memory_id or id required');
    const body: Record<string, unknown> = withUser(config, {});
    if (args.content) body.content = args.content;
    if (args.tags) body.tags = args.tags;
    const raw = await api.patch<unknown>(`/memory/${memoryId}`, body);
    validateMutationResponse(raw, `/memory/${memoryId}`);
    return { text: JSON.stringify(wrapResponse({ id: memoryId, action: 'updated' }, config)) };
  }

  if (name === 'velixar_delete') {
    const archive = args.archive as boolean;
    const targetIds: string[] = args.ids
      ? (args.ids as string[])
      : (args.memory_id || args.id) ? [(args.memory_id || args.id) as string] : [];
    if (targetIds.length === 0) throw new Error('id or ids required');

    if (archive) {
      // Build 1.5: Soft-delete via archive — bulk all-or-nothing (H6.6)
      // Archive = update with archived: true
      const results: Array<{ id: string; status: string }> = [];
      for (const mid of targetIds) {
        try {
          const body = withUser(config, { archived: true });
          await api.patch<unknown>(`/memory/${mid}`, body);
          results.push({ id: mid, status: 'archived' });
        } catch {
          // H6.6: If any fails, report but continue (best-effort for archive)
          results.push({ id: mid, status: 'error' });
        }
      }
      return { text: JSON.stringify(wrapResponse({ results, action: 'archived', count: results.filter(r => r.status === 'archived').length }, config)) };
    }

    // Hard delete
    if (targetIds.length === 1) {
      const raw = await api.delete<unknown>(`/memory/${targetIds[0]}`);
      validateMutationResponse(raw, `/memory/${targetIds[0]}`);
      return { text: JSON.stringify(wrapResponse({ id: targetIds[0], action: 'deleted' }, config)) };
    }
    // Bulk hard delete
    const results: Array<{ id: string; status: string }> = [];
    for (const mid of targetIds) {
      try {
        await api.delete<unknown>(`/memory/${mid}`);
        results.push({ id: mid, status: 'deleted' });
      } catch {
        results.push({ id: mid, status: 'error' });
      }
    }
    return { text: JSON.stringify(wrapResponse({ results, action: 'deleted', count: results.filter(r => r.status === 'deleted').length }, config)) };
  }

  throw new Error(`Unknown memory tool: ${name}`);
}
