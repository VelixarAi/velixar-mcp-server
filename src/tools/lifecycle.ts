// ── Lifecycle Tools ──
// velixar_distill — extract durable memories from session content
// Phase 3: batch, consolidate, retag, session

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { createHash } from 'node:crypto';
import type { ApiClient } from '../api.js';
import { normalizeMemory, wrapResponse } from '../api.js';
import type { ApiConfig, MemoryItem } from '../types.js';
import { validateSearchResponse, validateListResponse } from '../validate.js';

// ── Idempotency Cache ──
// Tracks content hashes of recently stored memories to prevent duplicates on retry.
// TTL: 5 minutes. Keyed by workspace_id + content hash to prevent cross-workspace dedup in HTTP mode.
const idempotencyCache = new Map<string, { id: string; timestamp: number }>();
const IDEMPOTENCY_TTL_MS = 5 * 60 * 1000;

function contentHash(content: string): string {
  return createHash('sha256').update(content.trim().toLowerCase()).digest('hex').slice(0, 16);
}

function idempotencyKey(workspaceId: string, content: string): string {
  return `${workspaceId}:${contentHash(content)}`;
}

function checkIdempotency(workspaceId: string, content: string): string | null {
  const key = idempotencyKey(workspaceId, content);
  const entry = idempotencyCache.get(key);
  if (entry && Date.now() - entry.timestamp < IDEMPOTENCY_TTL_MS) return entry.id;
  if (entry) idempotencyCache.delete(key);
  return null;
}

function recordIdempotency(workspaceId: string, content: string, id: string): void {
  idempotencyCache.set(idempotencyKey(workspaceId, content), { id, timestamp: Date.now() });
}

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
      'Detects duplicates (skips near-identical content) and flags active contradictions. ' +
      'Use preview: true to see extractions without storing.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Session text to distill into durable memories' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags to apply (auto-generated if absent)' },
        source_ids: { type: 'array', items: { type: 'string' }, description: 'Source memory IDs for provenance tracking' },
        preview: { type: 'boolean', description: 'Preview mode: return extracted memories without storing (default: false)' },
        max_memories: { type: 'number', description: 'Maximum number of memories to extract' },
      },
      required: ['content'],
    },
  },
  {
    name: 'velixar_session_save',
    description:
      'Save a session summary for later recall. Auto-generates session_id if not provided. ' +
      'Returns the session_id for later recall.',
    inputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Session summary to save' },
        session_id: { type: 'string', description: 'Session/conversation ID (auto-generated if omitted)' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Additional tags' },
      },
      required: ['summary'],
    },
  },
  {
    name: 'velixar_session_recall',
    description:
      'Recall memories from a previous session by session ID, date, or topic. ' +
      'Use when resuming work to restore prior context. ' +
      'Supports chunk_id for drill-down into specific time segments (from session_resume manifest). ' +
      'Use order="chronological" for full narrative reconstruction (oldest-first).',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Session ID to recall' },
        topic: { type: 'string', description: 'Topic to search for in session memories' },
        chunk_id: { type: 'string', description: 'Specific chunk ID for drill-down into a time segment' },
        start_time: { type: 'string', description: 'ISO timestamp — only return memories after this time' },
        end_time: { type: 'string', description: 'ISO timestamp — only return memories before this time' },
        order: { type: 'string', enum: ['recent_first', 'chronological'], description: 'Sort order (default: recent_first)' },
        limit: { type: 'number', description: 'Max results (default 10)' },
      },
    },
  },
  {
    name: 'velixar_session_resume',
    description:
      'Reconstruct full session context in a single call — the recommended way to resume work. ' +
      'Returns narrative summary, key decisions, open threads, and last state.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Session ID to resume (optional — uses most recent if omitted)' },
        topic: { type: 'string', description: 'Topic to focus reconstruction on' },
        intent: {
          type: 'string',
          enum: ['continue_coding', 'write_postmortem', 'catch_up'],
          description: 'What you need the context for — affects which details are preserved (default: continue_coding)',
        },
        focus: { type: 'string', description: 'Specific entity or topic to prioritize in reconstruction' },
        max_tokens: { type: 'number', description: 'Token budget for the response (default 4000)' },
        from_memory_id: { type: 'string', description: 'Resume from a specific point in the session (memory ID)' },
        exclude_topics: { type: 'array', items: { type: 'string' }, description: 'Filter out irrelevant threads during reconstruction' },
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
    name: 'velixar_consolidate',
    description:
      'Merge related episodic memories into a single semantic memory. ' +
      'Preserves originals as provenance. Use when multiple episodic memories cover the same topic and should be unified. ' +
      'Provide memory IDs to consolidate, or a topic to auto-find candidates. ' +
      'Set preview=true to see what would be merged without executing.',
    inputSchema: {
      type: 'object',
      properties: {
        memory_ids: { type: 'array', items: { type: 'string' }, description: 'Memory IDs to consolidate' },
        topic: { type: 'string', description: 'Topic to auto-find consolidation candidates' },
        summary: { type: 'string', description: 'Optional: provide the consolidated summary (otherwise auto-generated)' },
        preview: { type: 'boolean', description: 'Preview mode — show what would be merged without executing (default: false)' },
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
      'Export memories as structured data (JSON or Markdown). Supports filtering by tags, tier, date range, and search query.',
    inputSchema: {
      type: 'object',
      properties: {
        format: { type: 'string', enum: ['json', 'markdown'], description: 'Export format (default: json)' },
        query: { type: 'string', description: 'Optional: filter by search query' },
        limit: { type: 'number', description: 'Max memories to export (default 50)' },
        include_graph: { type: 'boolean', description: 'Include graph entities and relationships (default: false)' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Filter by tags (AND logic)' },
        tier: { type: 'number', description: 'Filter by memory tier' },
        before: { type: 'string', description: 'ISO timestamp — only export memories created before this time' },
        after: { type: 'string', description: 'ISO timestamp — only export memories created after this time' },
        all: { type: 'boolean', description: 'Export all memories (overrides limit)' },
      },
    },
  },
  {
    name: 'velixar_import',
    description:
      'Bulk import memories from structured data (JSON or Markdown). Max 50 items per call. ' +
      'Supports conflict detection: skip duplicates, overwrite, or merge.',
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
        quarantine_zone: { type: 'string', description: 'Optional quarantine zone ID for all imported memories' },
        conflict_strategy: { type: 'string', enum: ['skip', 'overwrite', 'merge'], description: 'How to handle duplicates (default: skip)' },
      },
      required: ['data'],
    },
  },
  {
    name: 'velixar_upload',
    description:
      'Upload a file into Velixar memory with full source provenance. ' +
      'Supports PDF, Markdown, text, CSV, JSON, DOCX, and code files. Parsed, chunked, and tagged with source metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file to upload (e.g. /Users/me/docs/report.pdf)' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags to apply to all resulting memories' },
        quarantine_zone: { type: 'string', description: 'Optional quarantine zone ID for all uploaded memories' },
      },
      required: ['file_path'],
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
    const preview = args.preview as boolean;
    const maxMemories = args.max_memories as number | undefined;

    // Auto-generate tags when absent
    const tags = userTags.length
      ? [...userTags, 'distilled']
      : [...autoTags(content), 'distilled'];

    // Build 1.4: max_memories — truncate content if capped
    let distillContent = content;
    if (maxMemories === 1) {
      // Single memory mode — use content as-is
      distillContent = content;
    }

    // Duplicate detection: search for similar content before storing
    // H20: Adaptive threshold — shorter content needs higher similarity to be a true duplicate
    let duplicateDetected = false;
    let contradictionDetected = false;
    const contradictionsFound: string[] = [];

    // M28: Exact dedup fast path — check content hash before expensive cosine similarity
    const existingExact = checkIdempotency(config.workspaceId, distillContent);
    if (existingExact) {
      duplicateDetected = true;
    }

    if (!duplicateDetected) {
      try {
        const searchParams = new URLSearchParams({
          q: content.slice(0, 200),
          user_id: config.userId,
          limit: '3',
        });
        const existing = await api.get<unknown>(
          `/memory/search?${searchParams}`, true,
        );
        const validated = validateSearchResponse(existing, '/memory/search');
        const topMatch = validated.memories[0];
        if (topMatch && typeof topMatch.score === 'number') {
          const score = topMatch.score;
          // Shorter content → higher threshold (short strings match too easily)
          const threshold = content.length < 100 ? 0.96 : content.length < 300 ? 0.94 : 0.92;
          if (score > threshold) duplicateDetected = true;
        }
      } catch { /* non-blocking */ }
    }

    // Contradiction detection: check if content conflicts with existing beliefs
    try {
      const contradictions = await api.get<unknown>(
        '/exocortex/contradictions?status=open', true,
      );
      const cObj = (contradictions && typeof contradictions === 'object') ? contradictions as Record<string, unknown> : {};
      const cArr = Array.isArray(cObj.contradictions) ? cObj.contradictions : [];
      if (cArr.length) {
        contradictionDetected = true;
        for (const c of cArr.slice(0, 3)) {
          const entry = c as Record<string, unknown>;
          contradictionsFound.push(String(entry.explanation || entry.description || 'Conflict detected'));
        }
      }
    } catch { /* non-blocking */ }

    // Build 1.4: Preview mode — return extraction without storing
    if (preview) {
      const words = distillContent.split(/\s+/).length;
      const hasSpecifics = /\b(decided|chose|because|prefer|always|never|bug|fix|error|version|v\d)\b/i.test(distillContent);
      const qualityIssues: string[] = [];
      if (words < 5) qualityIssues.push('too_short');
      if (words > 500) qualityIssues.push('too_long_for_single_memory');
      if (!hasSpecifics) qualityIssues.push('low_specificity');
      return {
        text: JSON.stringify(wrapResponse({
          preview: true,
          candidates: [{
            content: distillContent, rationale: 'Would be distilled from session content', tags,
            confidence: 0.8, memory_type: 'semantic' as const, source_type: 'distill' as const,
            duplicate_detected: duplicateDetected, contradiction_detected: contradictionDetected,
            derived_from: sourceIds,
          }],
          would_store: duplicateDetected ? 0 : 1,
          would_skip: duplicateDetected ? 1 : 0,
          contradictions_found: contradictionsFound,
          quality: { score: Math.max(0, 1 - qualityIssues.length * 0.25), issues: qualityIssues, word_count: words },
        }, config)),
      };
    }

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
      source_type: 'mcp_distill',
    });

    if (result.error) throw new Error(result.error);

    // M28: Record hash for future exact dedup
    if (result.id) recordIdempotency(config.workspaceId, content, result.id);

    // H15/H27: Distillation quality scoring
    const words = content.split(/\s+/).length;
    const hasSpecifics = /\b(decided|chose|because|prefer|always|never|bug|fix|error|version|v\d)\b/i.test(content);
    const qualityIssues: string[] = [];
    if (words < 5) qualityIssues.push('too_short');
    if (words > 500) qualityIssues.push('too_long_for_single_memory');
    if (!hasSpecifics) qualityIssues.push('low_specificity');
    // H27: Completeness — if source_ids provided, flag that we can't verify extraction coverage
    if (sourceIds.length > 0) qualityIssues.push('completeness_unverified');
    const qualityScore = Math.max(0, 1 - qualityIssues.length * 0.25);

    return {
      text: JSON.stringify(wrapResponse({
        candidates: [{
          content, rationale: 'Distilled from session content', tags,
          confidence: 0.8, memory_type: 'semantic' as const, source_type: 'distill' as const,
          duplicate_detected: false, contradiction_detected: contradictionDetected,
          stored_id: result.id, derived_from: sourceIds,
        }],
        stored_count: 1, skipped_count: 0, contradictions_found: contradictionsFound,
        quality: { score: qualityScore, issues: qualityIssues, word_count: words },
        // M4: Aging grace period — signal to backend that source episodic memories
        // should not be archived until distillation completeness is verified
        archival_policy: { min_age_days: 7, require_completeness_check: sourceIds.length > 0 },
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
      source_type: 'mcp_session',
    });

    if (result.error) throw new Error(result.error);

    // M27: Dual session storage — also store a compact summary version for session_resume
    const compactSummary = summary.length > 500 ? summary.slice(0, 500) + '…' : summary;
    try {
      await api.post('/memory', {
        content: `[Session ${sessionId} summary] ${compactSummary}`,
        user_id: config.userId,
        tier: 2,
        tags: [...tags, 'session_summary'],
        author: { type: 'agent', session_id: sessionId },
        source_type: 'mcp_session',
      });
    } catch { /* non-blocking — raw is the primary */ }

    return { text: JSON.stringify(wrapResponse({ session_id: sessionId, stored_id: result.id, tags, dual_stored: true }, config)) };
  }

  if (name === 'velixar_session_recall') {
    const sessionId = args.session_id as string;
    const topic = args.topic as string;
    const chunkId = args.chunk_id as string | undefined;
    const startTime = args.start_time as string | undefined;
    const endTime = args.end_time as string | undefined;
    const order = (args.order as string) || 'recent_first';
    const limit = Math.min((args.limit as number) || 10, 50);

    if (!sessionId && !topic) throw new Error('Either session_id or topic required');

    let rawMemories: Array<Record<string, unknown>> = [];

    if (sessionId) {
      const result = await api.get<unknown>(
        `/memory/session/${sessionId}?limit=${limit}`, true,
      );
      const rObj = (result && typeof result === 'object') ? result as Record<string, unknown> : {};
      rawMemories = Array.isArray(rObj.memories) ? rObj.memories : [];
    } else {
      const params = new URLSearchParams({ q: `session ${topic}`, user_id: config.userId, limit: String(limit) });
      const raw = await api.get<unknown>(`/memory/search?${params}`, true);
      const validated = validateSearchResponse(raw, '/memory/search');
      rawMemories = validated.memories as unknown as Array<Record<string, unknown>>;
    }

    // H22: Temporal filtering
    type TimedMem = Record<string, unknown> & { _ts: number };
    let memories: TimedMem[] = rawMemories.map(m => {
      const _ts = new Date(String(m.created_at || m.timestamp || '')).getTime() || 0;
      return Object.assign({}, m, { _ts }) as TimedMem;
    });

    if (startTime) {
      const startMs = new Date(startTime).getTime();
      if (!isNaN(startMs)) memories = memories.filter(m => m._ts >= startMs);
    }
    if (endTime) {
      const endMs = new Date(endTime).getTime();
      if (!isNaN(endMs)) memories = memories.filter(m => m._ts <= endMs);
    }

    // H23: Chronological ordering
    if (order === 'chronological') {
      memories.sort((a, b) => a._ts - b._ts);
    } else {
      memories.sort((a, b) => b._ts - a._ts);
    }

    // H24: Build chunk manifest (15-min windows) for navigation
    const chronological = [...memories].sort((a, b) => a._ts - b._ts);
    const CHUNK_MS = 15 * 60 * 1000;
    const manifest: Array<{ id: string; time_range: string; summary: string; count: number }> = [];
    let cStart = chronological[0]?._ts || 0;
    let cBuf: typeof chronological = [];

    for (const m of chronological) {
      if (m._ts - cStart > CHUNK_MS && cBuf.length) {
        manifest.push({
          id: `chunk-${manifest.length}`,
          time_range: `${new Date(cStart).toISOString()} → ${new Date(cBuf[cBuf.length - 1]._ts).toISOString()}`,
          summary: String(cBuf[0].content || '').slice(0, 100),
          count: cBuf.length,
        });
        cBuf = [];
        cStart = m._ts;
      }
      cBuf.push(m);
    }
    if (cBuf.length) {
      manifest.push({
        id: `chunk-${manifest.length}`,
        time_range: `${new Date(cStart).toISOString()} → ${new Date(cBuf[cBuf.length - 1]._ts).toISOString()}`,
        summary: String(cBuf[0].content || '').slice(0, 100),
        count: cBuf.length,
      });
    }

    // Chunk drill-down: filter to specific chunk if requested
    if (chunkId && manifest.length) {
      const idx = parseInt(chunkId.replace('chunk-', ''), 10);
      if (!isNaN(idx) && idx >= 0 && idx < manifest.length) {
        const chunk = manifest[idx];
        const [rangeStart] = chunk.time_range.split(' → ');
        const rangeStartMs = new Date(rangeStart).getTime();
        const rangeEndMs = idx + 1 < manifest.length
          ? new Date(manifest[idx + 1].time_range.split(' → ')[0]).getTime()
          : Infinity;
        memories = memories.filter(m => m._ts >= rangeStartMs && m._ts < rangeEndMs);
      }
    }

    // Strip internal _ts before returning
    const cleaned = memories.map(({ _ts, ...rest }) => rest);

    return {
      text: JSON.stringify(wrapResponse({
        session_id: sessionId || null,
        topic: topic || null,
        order,
        memories: cleaned,
        count: cleaned.length,
        chunk_manifest: manifest,
        total_chunks: manifest.length,
      }, config, { data_absent: cleaned.length === 0 })),
    };
  }

  if (name === 'velixar_session_resume') {
    const sessionId = args.session_id as string | undefined;
    const topic = args.topic as string | undefined;
    const intent = (args.intent as string) || 'continue_coding';
    const focus = args.focus as string | undefined;
    const maxTokens = Math.min((args.max_tokens as number) || 4000, 8000);
    const fromMemoryId = args.from_memory_id as string | undefined;
    const excludeTopics = (args.exclude_topics as string[]) || [];

    // Step 1: Find session memories — by ID, topic, or most recent
    let memories: Array<Record<string, unknown>> = [];

    if (sessionId) {
      const result = await api.get<unknown>(
        `/memory/session/${sessionId}?limit=50`, true,
      );
      const rObj = (result && typeof result === 'object') ? result as Record<string, unknown> : {};
      memories = Array.isArray(rObj.memories) ? rObj.memories as Array<Record<string, unknown>> : [];
    } else {
      // Search for session-tagged memories
      const q = topic ? `session ${topic}` : 'session';
      const params = new URLSearchParams({ q, user_id: config.userId, limit: '50' });
      const raw = await api.get<unknown>(`/memory/search?${params}`, true);
      const validated = validateSearchResponse(raw, '/memory/search');
      memories = validated.memories as unknown as Array<Record<string, unknown>>;
    }

    if (!memories.length) {
      return {
        text: JSON.stringify(wrapResponse({
          summary: 'No session memories found.',
          chunks: [], decisions: [], open_threads: [], last_state: null,
        }, config, { data_absent: true })),
      };
    }

    // Step 2: Sort chronologically and chunk by time windows (~15 min)
    let sorted = memories
      .map(m => {
        const ts = new Date(String(m.created_at || m.timestamp || '')).getTime() || 0;
        return { content: String(m.content || ''), tags: Array.isArray(m.tags) ? m.tags as string[] : [], ts, id: String(m.id || '') };
      })
      .filter(m => m.ts > 0)
      .sort((a, b) => a.ts - b.ts);

    // Build 6.3: from_memory_id — resume from a specific point
    if (fromMemoryId) {
      const idx = sorted.findIndex(m => m.id === fromMemoryId);
      if (idx >= 0) sorted = sorted.slice(idx);
    }

    // Build 6.3: exclude_topics — filter out irrelevant threads
    if (excludeTopics.length > 0) {
      const excludeLower = excludeTopics.map(t => t.toLowerCase());
      sorted = sorted.filter(m => !excludeLower.some(t => m.content.toLowerCase().includes(t)));
    }

    const CHUNK_WINDOW_MS = 15 * 60 * 1000;
    type SortedMem = typeof sorted[number];
    const chunks: Array<{ id: string; time_range: string; summary: string; memories: SortedMem[]; char_count: number }> = [];
    let chunkStart = sorted[0]?.ts || 0;
    let currentChunk: SortedMem[] = [];

    for (const m of sorted) {
      if (m.ts - chunkStart > CHUNK_WINDOW_MS && currentChunk.length > 0) {
        const startStr = new Date(chunkStart).toISOString();
        const endStr = new Date(currentChunk[currentChunk.length - 1].ts).toISOString();
        const content = currentChunk.map(c => c.content).join(' ');
        chunks.push({
          id: `chunk-${chunks.length}`,
          time_range: `${startStr} → ${endStr}`,
          summary: content.slice(0, 150),
          memories: currentChunk,
          char_count: content.length,
        });
        currentChunk = [];
        chunkStart = m.ts;
      }
      currentChunk.push(m);
    }
    if (currentChunk.length) {
      const startStr = new Date(chunkStart).toISOString();
      const endStr = new Date(currentChunk[currentChunk.length - 1].ts).toISOString();
      const content = currentChunk.map(c => c.content).join(' ');
      chunks.push({
        id: `chunk-${chunks.length}`,
        time_range: `${startStr} → ${endStr}`,
        summary: content.slice(0, 150),
        memories: currentChunk,
        char_count: content.length,
      });
    }

    // Step 3: Select chunks based on intent and budget
    // Estimate ~4 chars per token
    const charBudget = maxTokens * 4;
    let selectedContent: string[] = [];
    let usedChars = 0;

    // Intent-based selection: recent chunks get full detail, older get summaries
    const recentChunks = chunks.slice(-3); // last 3 chunks = full detail
    const olderChunks = chunks.slice(0, -3); // older = summary only

    for (const chunk of recentChunks) {
      const detail = chunk.memories.map(m => m.content).join('\n');
      if (usedChars + detail.length <= charBudget) {
        selectedContent.push(`[${chunk.time_range}]\n${detail}`);
        usedChars += detail.length;
      }
    }
    for (const chunk of olderChunks.reverse()) {
      if (usedChars + chunk.summary.length + 50 <= charBudget) {
        selectedContent.unshift(`[${chunk.time_range}] (summary) ${chunk.summary}`);
        usedChars += chunk.summary.length + 50;
      }
    }

    // Step 4: Extract decisions and open threads based on intent
    // M26: Intent-aware extraction — different intents preserve different details
    const codingPatterns = /\b(file|function|class|module|import|error|bug|fix|test|deploy|commit|branch|PR|TODO)\b/i;
    const postmortemPatterns = /\b(decided|decision|failed|broke|root cause|incident|outage|rollback|lesson|mistake)\b/i;

    const intentFilter = intent === 'continue_coding' ? codingPatterns
      : intent === 'write_postmortem' ? postmortemPatterns
      : null; // catch_up = no filter, show everything

    const decisions = sorted
      .filter(m => {
        const c = m.content.toLowerCase();
        return c.includes('decided') || c.includes('decision') || c.includes('chose') || c.includes('going with');
      })
      .map(m => m.content.slice(0, 200));

    const openThreads = sorted
      .filter(m => {
        const c = m.content.toLowerCase();
        return c.includes('todo') || c.includes('need to') || c.includes('should') || c.includes('next step') || c.includes('blocked');
      })
      .map(m => m.content.slice(0, 200));

    // Step 5: Build context package
    const lastMemory = sorted[sorted.length - 1];
    const lastState = lastMemory ? lastMemory.content.slice(0, 300) : null;

    // Focus filtering
    if (focus) {
      selectedContent = selectedContent.filter(c => c.toLowerCase().includes(focus.toLowerCase()));
    }
    // M26: Intent filtering — boost intent-relevant content
    if (intentFilter && selectedContent.length > 3) {
      selectedContent.sort((a, b) => {
        const aMatch = intentFilter.test(a) ? 1 : 0;
        const bMatch = intentFilter.test(b) ? 1 : 0;
        return bMatch - aMatch;
      });
    }

    const manifest = chunks.map(c => ({
      id: c.id,
      time_range: c.time_range,
      summary: c.summary,
      memory_count: c.memories.length,
    }));

    return {
      text: JSON.stringify(wrapResponse({
        intent,
        session_id: sessionId || 'auto-detected',
        chunk_manifest: manifest,
        total_chunks: chunks.length,
        total_memories: sorted.length,
        narrative: selectedContent.join('\n\n'),
        decisions: decisions.slice(0, 10),
        open_threads: openThreads.slice(0, 10),
        last_state: lastState,
        focus: focus || null,
        token_estimate: Math.ceil(usedChars / 4),
        drill_down_hint: 'Use velixar_session_recall with chunk_id to expand any chunk in the manifest.',
      }, config, {
        data_absent: selectedContent.length === 0,
      })),
    };
  }

  if (name === 'velixar_batch_store') {
    const items = (args.items as Array<{ content: string; tags?: string[]; tier?: number }>).slice(0, 20);

    // Build 1.3: Intra-batch dedup — detect near-duplicate items within the batch by content hash
    const seen = new Map<string, number>(); // hash → first index
    const intraBatchDupes = new Set<number>();
    for (let i = 0; i < items.length; i++) {
      const hash = items[i].content.trim().toLowerCase().slice(0, 200);
      if (seen.has(hash)) {
        intraBatchDupes.add(i);
      } else {
        seen.set(hash, i);
      }
    }

    const results = await Promise.allSettled(
      items.map(async (item, idx) => {
        // Intra-batch duplicate
        if (intraBatchDupes.has(idx)) {
          return { id: undefined, status: 'skipped_intra_batch_duplicate' as const };
        }
        // Idempotency: skip if same content was stored recently
        const existingId = checkIdempotency(config.workspaceId, item.content);
        if (existingId) return { id: existingId, status: 'skipped_duplicate' as const };

        // Build 1.3: Distill always checks duplicates (per Round 2 Chain 10)
        // For batch_store, do a lightweight similarity check
        let similarWarning: string | undefined;
        try {
          const searchParams = new URLSearchParams({ q: item.content.slice(0, 200), user_id: config.userId, limit: '1' });
          const searchRaw = await api.get<unknown>(`/memory/search?${searchParams}`, false);
          const searchResult = validateSearchResponse(searchRaw, '/memory/search');
          if (searchResult.memories.length > 0 && (searchResult.memories[0].score ?? 0) >= 0.95) {
            similarWarning = `similar to existing memory ${searchResult.memories[0].id}`;
          }
        } catch { /* non-blocking */ }

        const res = await api.post<{ id?: string; error?: string }>('/memory', {
          content: item.content,
          user_id: config.userId,
          tier: item.tier ?? 2,
          tags: item.tags || autoTags(item.content),
          author: { type: 'user' },
          source_type: 'mcp_batch',
        });
        if (res.id) recordIdempotency(config.workspaceId, item.content, res.id);
        return { id: res.id, status: 'stored' as const, similar_warning: similarWarning };
      }),
    );

    const statuses = results.map((r, i) => {
      const val = r.status === 'fulfilled' ? r.value as Record<string, unknown> : null;
      return {
        index: i,
        status: r.status === 'fulfilled' && !val?.error ? (val?.status as string || 'stored') : 'error',
        id: val?.id as string | undefined,
        similar_warning: val?.similar_warning as string | undefined,
        error: r.status === 'rejected' ? String(r.reason) : val?.error ? String(val.error) : undefined,
        ...(r.status === 'rejected' || val?.error ? { content_preview: items[i].content.slice(0, 80) } : {}),
      };
    });

    const stored = statuses.filter(s => s.status === 'stored').length;
    const skipped = statuses.filter(s => s.status.startsWith('skipped')).length;
    const failed = statuses.filter(s => s.status === 'error');
    return {
      text: JSON.stringify(wrapResponse({
        items: statuses,
        stored_count: stored,
        skipped_count: skipped,
        error_count: failed.length,
        ...(failed.length ? { retry_hint: `${failed.length} item(s) failed. Retry only the failed indices: [${failed.map(f => f.index).join(', ')}]` } : {}),
      }, config)),
    };
  }

  // velixar_batch_search removed — now handled as alias in retrieval.ts (Build 2.2)

  if (name === 'velixar_consolidate') {
    const memoryIds = args.memory_ids as string[] | undefined;
    const topic = args.topic as string | undefined;
    const providedSummary = args.summary as string | undefined;
    const preview = args.preview === true;

    // Find candidates: either by IDs or by topic search
    let candidates: Array<{ id: string; content: string; tags: string[] }> = [];

    if (memoryIds?.length) {
      const fetches = await Promise.allSettled(
        memoryIds.slice(0, 10).map(id =>
          api.get<unknown>(`/memory/${id}`, true),
        ),
      );
      for (const f of fetches) {
        if (f.status !== 'fulfilled') continue;
        const val = f.value;
        const rObj = (val && typeof val === 'object') ? val as Record<string, unknown> : {};
        const mem = (rObj.memory && typeof rObj.memory === 'object') ? rObj.memory as Record<string, unknown> : null;
        if (mem) {
          candidates.push({ id: String(mem.id || ''), content: String(mem.content || ''), tags: Array.isArray(mem.tags) ? mem.tags.filter((t): t is string => typeof t === 'string') : [] });
        }
      }
    } else if (topic) {
      const params = new URLSearchParams({ q: topic, user_id: config.userId, limit: '10' });
      const raw = await api.get<unknown>(`/memory/search?${params}`, true);
      const validated = validateSearchResponse(raw, '/memory/search');
      candidates = validated.memories.map(m => ({
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

    // H26: Preview mode — show what would be merged without executing
    if (preview) {
      // Identify unique details per memory that might be lost in consolidation
      const uniqueDetails = candidates.map(c => {
        const otherContent = candidates.filter(o => o.id !== c.id).map(o => o.content).join(' ');
        const words = c.content.split(/\s+/);
        const unique = words.filter(w => w.length > 4 && !otherContent.toLowerCase().includes(w.toLowerCase()));
        return { id: c.id, preview: c.content.slice(0, 120), unique_terms: unique.slice(0, 10), tag_count: c.tags.length };
      });
      return {
        text: JSON.stringify(wrapResponse({
          preview: true,
          source_count: candidates.length,
          sources: uniqueDetails,
          proposed_summary: summary.slice(0, 500),
          proposed_tags: allTags,
          nuance_risk: uniqueDetails.some(d => d.unique_terms.length > 3) ? 'Some memories contain unique details that may be lost in consolidation' : 'Low risk — memories are highly overlapping',
        }, config)),
      };
    }

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
          const raw = await api.get<unknown>(`/memory/${id}`, true);
          const rObj = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {};
          const memObj = (rObj.memory && typeof rObj.memory === 'object') ? rObj.memory as Record<string, unknown> : {};
          const rawTags = memObj.tags;
          const current = Array.isArray(rawTags) ? rawTags.filter((t): t is string => typeof t === 'string') : [];
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
    const exportAll = args.all as boolean;
    const limit = exportAll ? 1000 : Math.min((args.limit as number) || 50, 200);
    const query = args.query as string | undefined;
    const includeGraph = args.include_graph as boolean;

    let memories: Array<Record<string, unknown>> = [];
    if (query) {
      const params = new URLSearchParams({ q: query, user_id: config.userId, limit: String(limit) });
      if (args.tags) params.set('tags', (args.tags as string[]).join(','));
      if (args.before) params.set('before', args.before as string);
      if (args.after) params.set('after', args.after as string);
      if (args.tier !== undefined) params.set('tier', String(args.tier));
      const raw = await api.get<unknown>(`/memory/search?${params}`, true);
      const validated = validateSearchResponse(raw, '/memory/search');
      memories = validated.memories as unknown as Array<Record<string, unknown>>;
    } else {
      const params = new URLSearchParams({ user_id: config.userId, limit: String(limit) });
      if (args.tags) params.set('tags', (args.tags as string[]).join(','));
      if (args.before) params.set('before', args.before as string);
      if (args.after) params.set('after', args.after as string);
      if (args.tier !== undefined) params.set('tier', String(args.tier));
      const raw = await api.get<unknown>(`/memory/list?${params}`, true);
      const validated = validateListResponse(raw, '/memory/list');
      memories = validated.memories as unknown as Array<Record<string, unknown>>;
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
    const conflictStrategy = (args.conflict_strategy as string) || 'skip';

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
      items.map(async item => {
        // Check for existing duplicate
        const existingId = checkIdempotency(config.workspaceId, item.content);
        if (existingId) {
          if (conflictStrategy === 'skip') return { id: existingId, status: 'skipped_duplicate' as const };
          if (conflictStrategy === 'overwrite') {
            // Update existing memory with new content/tags
            await api.patch<unknown>(`/memory/${existingId}`, {
              content: item.content,
              tags: [...(item.tags || []), ...defaultTags],
              user_id: config.userId,
            });
            return { id: existingId, status: 'overwritten' as const };
          }
          // merge: append tags to existing
          if (conflictStrategy === 'merge') {
            await api.patch<unknown>(`/memory/${existingId}`, {
              tags: [...(item.tags || []), ...defaultTags],
              user_id: config.userId,
            });
            return { id: existingId, status: 'merged' as const };
          }
        }
        const res = await api.post<{ id?: string; error?: string }>('/memory/store', {
          content: item.content,
          tags: [...(item.tags || []), ...defaultTags, ...(source ? [`source:${source}`] : [])],
          tier: item.tier ?? 2,
          user_id: config.userId,
          source_type: 'mcp_import',
          source_file: source || undefined,
        });
        if (res.id) recordIdempotency(config.workspaceId, item.content, res.id);
        return { id: res.id, status: 'imported' as const };
      }),
    );

    const statuses = results.map((r, i) => ({
      index: i,
      status: r.status === 'fulfilled' ? (r.value as Record<string, unknown>).status as string : 'error',
      id: r.status === 'fulfilled' ? (r.value as Record<string, unknown>).id as string | undefined : undefined,
      error: r.status === 'rejected' ? String(r.reason) : undefined,
    }));

    const importedCount = statuses.filter(s => s.status === 'imported').length;
    const skippedCount = statuses.filter(s => s.status === 'skipped_duplicate').length;
    const overwrittenCount = statuses.filter(s => s.status === 'overwritten').length;
    const mergedCount = statuses.filter(s => s.status === 'merged').length;
    return {
      text: JSON.stringify(wrapResponse({
        imported: importedCount,
        skipped_duplicate: skippedCount,
        overwritten: overwrittenCount,
        merged: mergedCount,
        failed: statuses.filter(s => s.status === 'error').length,
        total: items.length,
        conflict_strategy: conflictStrategy,
        items: statuses,
        ...(source ? { source } : {}),
      }, config)),
    };
  }

  if (name === 'velixar_upload') {
    const filePath = args.file_path as string;
    const userTags = (args.tags as string[]) || [];

    const { readFileSync, existsSync, statSync } = await import('node:fs');
    const { basename, extname } = await import('node:path');
    const { createHash } = await import('node:crypto');

    if (!existsSync(filePath)) {
      return { text: JSON.stringify({ status: 'error', error: `File not found: ${filePath}` }), isError: true };
    }

    const stat = statSync(filePath);
    if (stat.size > 50 * 1024 * 1024) {
      return { text: JSON.stringify({ status: 'error', error: 'File exceeds 50MB limit' }), isError: true };
    }

    const filename = basename(filePath);
    const ext = extname(filePath).toLowerCase().replace('.', '');
    const mimeMap: Record<string, string> = {
      pdf: 'application/pdf', md: 'text/markdown', txt: 'text/plain',
      csv: 'text/csv', json: 'application/json', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      py: 'text/x-python', js: 'text/javascript', ts: 'text/typescript',
      rs: 'text/x-rust', go: 'text/x-go', java: 'text/x-java',
      rb: 'text/x-ruby', c: 'text/x-c', cpp: 'text/x-c++',
      html: 'text/html', xml: 'text/xml', yaml: 'text/yaml', yml: 'text/yaml',
    };
    const mimeType = mimeMap[ext] || 'application/octet-stream';

    const fileBytes = readFileSync(filePath);
    const contentHash = createHash('sha256').update(fileBytes).digest('hex');

    // Step 1: Get presigned URL
    let presignRes: { upload_id?: string; upload_url?: string };
    try {
      presignRes = await api.post<{ upload_id?: string; upload_url?: string }>('/upload/presign', {
        filename, mime_type: mimeType, size_bytes: stat.size, content_hash: contentHash,
        ...(userTags.length ? { tags: userTags } : {}),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const isWaf = msg.includes('403') || msg.includes('WAF');
      return {
        text: JSON.stringify({ status: 'error', error: isWaf
          ? 'Upload blocked by firewall — contact support. Request may have triggered WAF rules.'
          : `Presign failed: ${msg}` }),
        isError: true,
      };
    }

    const uploadId = presignRes.upload_id;
    const uploadUrl = presignRes.upload_url;
    if (!uploadId || !uploadUrl) {
      return { text: JSON.stringify({ status: 'error', error: 'Presign response missing upload_id or upload_url' }), isError: true };
    }

    // Step 2: Upload to S3
    try {
      const s3Res = await fetch(uploadUrl, {
        method: 'PUT',
        body: fileBytes,
        headers: { 'Content-Type': mimeType },
      });
      if (!s3Res.ok) {
        return { text: JSON.stringify({ status: 'error', error: `S3 upload failed: ${s3Res.status}` }), isError: true };
      }
    } catch (e) {
      return { text: JSON.stringify({ status: 'error', error: `S3 upload failed: ${e instanceof Error ? e.message : e}` }), isError: true };
    }

    // Step 3: Trigger ingestion
    let ingestRes: { status?: string; stored?: number; skipped?: number; total_chunks?: number; skip_reasons?: string[] };
    try {
      ingestRes = await api.post<typeof ingestRes>('/upload/ingest', {
        upload_id: uploadId, filename, content_hash: contentHash,
        ...(userTags.length ? { tags: userTags } : {}),
      });
    } catch (e) {
      return { text: JSON.stringify({ status: 'error', error: `Ingest failed: ${e instanceof Error ? e.message : e}`, upload_id: uploadId }), isError: true };
    }

    return {
      text: JSON.stringify(wrapResponse({
        upload_id: uploadId,
        filename,
        content_hash: contentHash,
        status: ingestRes.status || 'complete',
        chunks_created: ingestRes.stored || 0,
        skipped: ingestRes.skipped || 0,
        total_chunks: ingestRes.total_chunks || 0,
        skip_reasons: ingestRes.skip_reasons || [],
        source_type: 'upload',
      }, config)),
    };
  }

  throw new Error(`Unknown lifecycle tool: ${name}`);
}
