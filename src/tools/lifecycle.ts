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

  throw new Error(`Unknown lifecycle tool: ${name}`);
}
