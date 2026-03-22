// ── Memory CRUD Tools ──
// store, search, list, update, delete
// These are the foundation — typed but behaviorally unchanged from v0.2.4.

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ApiClient } from '../api.js';
import { normalizeMemory, wrapResponse } from '../api.js';
import type { ApiConfig } from '../types.js';
import { validateStoreResponse, validateSearchResponse, validateListResponse, validateMutationResponse } from '../validate.js';

export const memoryTools: Tool[] = [
  {
    name: 'velixar_store',
    description:
      'Store a memory for later retrieval. Use for important facts, decisions, user preferences, project context, or anything worth remembering long-term. ' +
      'Do NOT use for transient conversation details — only store durable, likely-future-useful knowledge. ' +
      'Memories are workspace-scoped and persist across sessions.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The memory content to store' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags for categorization' },
        tier: { type: 'number', description: 'Memory tier: 0=pinned, 1=session, 2=semantic (default), 3=org' },
      },
      required: ['content'],
    },
  },
  {
    name: 'velixar_search',
    description:
      'Search stored memories by semantic similarity. Use to find specific factual assertions, past decisions, or user preferences relevant to a known topic or query. ' +
      'Do NOT use for broad orientation — use velixar_context for that. ' +
      'Do NOT use to find contradictions — use velixar_contradictions for that. ' +
      'Returns ranked results with relevance scores.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        limit: { type: 'number', description: 'Max results (default 5)' },
        memory_type: { type: 'string', enum: ['episodic', 'semantic'], description: 'Filter by memory type' },
      },
      required: ['query'],
    },
  },
  {
    name: 'velixar_list',
    description:
      'List recent memories with pagination. Returns full metadata including IDs, tags, and timestamps. ' +
      'Use to browse what has been stored or to find memory IDs for update/delete operations.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max results (default 10)' },
        cursor: { type: 'string', description: 'Pagination cursor from previous response' },
        memory_type: { type: 'string', enum: ['episodic', 'semantic'], description: 'Filter by memory type' },
      },
      required: [],
    },
  },
  {
    name: 'velixar_update',
    description:
      "Update an existing memory's content or tags. Use velixar_list to find memory IDs first.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Memory ID to update' },
        content: { type: 'string', description: 'New content' },
        tags: { type: 'array', items: { type: 'string' }, description: 'New tags' },
      },
      required: ['id'],
    },
  },
  {
    name: 'velixar_delete',
    description: 'Delete a memory by ID. Use velixar_list to find memory IDs first.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Memory ID to delete' },
      },
      required: ['id'],
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
    const raw = await api.post<unknown>('/memory', {
      content: args.content,
      user_id: config.userId,
      tier: (args.tier as number) ?? 2,
      tags: (args.tags as string[]) || [],
      author: { type: 'agent', agent_id: config.userId },
      source_type: 'mcp_store',
    });
    const result = validateStoreResponse(raw, '/memory');
    return { text: JSON.stringify(wrapResponse({ id: result.id }, config)) };
  }

  if (name === 'velixar_search') {
    const params = new URLSearchParams({ q: args.query as string, user_id: config.userId });
    if (args.limit) params.set('limit', String(args.limit));
    const raw = await api.get<unknown>(`/memory/search?${params}`, true);
    const result = validateSearchResponse(raw, '/memory/search');
    let items = result.memories.map(m => {
      const mem = normalizeMemory(m);
      mem.workspace_id = config.workspaceId;
      return mem;
    });
    if (args.memory_type) items = items.filter(m => m.memory_type === args.memory_type);
    return {
      text: JSON.stringify(wrapResponse(
        { items, count: items.length },
        config,
        { data_absent: items.length === 0 },
      )),
    };
  }

  if (name === 'velixar_list') {
    const params = new URLSearchParams({ user_id: config.userId });
    if (args.limit) params.set('limit', String(args.limit));
    if (args.cursor) params.set('cursor', args.cursor as string);
    const raw = await api.get<unknown>(`/memory/list?${params}`, true);
    const result = validateListResponse(raw, '/memory/list');
    let items = result.memories.map(m => {
      const mem = normalizeMemory(m);
      mem.workspace_id = config.workspaceId;
      return mem;
    });
    if (args.memory_type) items = items.filter(m => m.memory_type === args.memory_type);
    return {
      text: JSON.stringify(wrapResponse(
        { items, count: items.length, cursor: result.cursor },
        config,
        { data_absent: items.length === 0 },
      )),
    };
  }

  if (name === 'velixar_update') {
    const body: Record<string, unknown> = { user_id: config.userId };
    if (args.content) body.content = args.content;
    if (args.tags) body.tags = args.tags;
    const raw = await api.patch<unknown>(`/memory/${args.id}`, body);
    validateMutationResponse(raw, `/memory/${args.id}`);
    return { text: JSON.stringify(wrapResponse({ id: args.id as string }, config)) };
  }

  if (name === 'velixar_delete') {
    const raw = await api.delete<unknown>(`/memory/${args.id}`);
    validateMutationResponse(raw, `/memory/${args.id}`);
    return { text: JSON.stringify(wrapResponse({ id: args.id as string }, config)) };
  }

  throw new Error(`Unknown memory tool: ${name}`);
}
