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
      'Accepts session text and extracts + stores the key takeaways as semantic memories.',
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

    // Store as semantic memory with distill source type marker
    const result = await api.post<{ id?: string; error?: string }>('/memory', {
      content,
      user_id: config.userId,
      tier: 2,
      tags,
      author: { type: 'distill', agent_id: config.userId },
    });

    if (result.error) throw new Error(result.error);

    const candidate = {
      content,
      rationale: 'Distilled from session content',
      tags,
      confidence: 0.8,
      memory_type: 'semantic' as const,
      source_type: 'distill' as const,
      duplicate_detected: false,
      contradiction_detected: false,
      stored_id: result.id,
      derived_from: sourceIds,
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
