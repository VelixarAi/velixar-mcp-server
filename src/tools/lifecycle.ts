// ── Lifecycle Tools ──
// velixar_distill — extract durable memories from session content
// Phase 3: batch, consolidate, retag, session

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ApiClient } from '../api.js';
import { wrapResponse } from '../api.js';
import type { ApiConfig } from '../types.js';

export const lifecycleTools: Tool[] = [
  {
    name: 'velixar_distill',
    description:
      'Extract durable memories from session content. Use at natural memory-worthy breakpoints: task complete, decision made, bug solved, preference clarified. ' +
      'Do NOT use for transient chatter — only distill content worth remembering long-term. ' +
      'Do NOT use for single explicit facts (use velixar_store). ' +
      'Accepts session text and extracts + stores the key takeaways as semantic memories.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Session text to distill into durable memories' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags to apply to distilled memories' },
      },
      required: ['content'],
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
    const tags = (args.tags as string[]) || [];

    // Store as semantic memory with distill source type marker
    const result = await api.post<{ id?: string; error?: string }>('/memory', {
      content,
      user_id: config.userId,
      tier: 2,
      tags: [...tags, 'distilled'],
      author: { type: 'distill', agent_id: config.userId },
    });

    if (result.error) throw new Error(result.error);

    const candidate = {
      content,
      rationale: 'Distilled from session content',
      tags: [...tags, 'distilled'],
      confidence: 0.8,
      memory_type: 'semantic' as const,
      source_type: 'distill' as const,
      duplicate_detected: false,
      contradiction_detected: false,
      stored_id: result.id,
    };

    return {
      text: JSON.stringify(wrapResponse({
        candidates: [candidate],
        stored_count: 1,
        skipped_count: 0,
        contradictions_found: [],
      }, config)),
    };
  }

  throw new Error(`Unknown lifecycle tool: ${name}`);
}
