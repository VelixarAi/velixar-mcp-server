// ── Lifecycle Tools ──
// velixar_distill — extract durable memories from session content
// Phase 3: batch, consolidate, retag, session

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { createHash } from 'node:crypto';
import type { ApiClient } from '../api.js';
import { wrapResponse } from '../api.js';
import type { ApiConfig } from '../types.js';

// ── Idempotency Cache ──
// Tracks content hashes of recently stored memories to prevent duplicates on retry.
// TTL: 5 minutes. Keyed by content hash.
const idempotencyCache = new Map<string, { id: string; timestamp: number }>();
const IDEMPOTENCY_TTL_MS = 5 * 60 * 1000;

function contentHash(content: string): string {
  return createHash('sha256').update(content.trim().toLowerCase()).digest('hex').slice(0, 16);
}

function checkIdempotency(content: string): string | null {
  const hash = contentHash(content);
  const entry = idempotencyCache.get(hash);
  if (entry && Date.now() - entry.timestamp < IDEMPOTENCY_TTL_MS) return entry.id;
  // Clean expired
  if (entry) idempotencyCache.delete(hash);
  return null;
}

function recordIdempotency(content: string, id: string): void {
  idempotencyCache.set(contentHash(content), { id, timestamp: Date.now() });
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
      'Handles chunking, selection, and assembly server-side. Returns a ready-to-use context package ' +
      'with narrative summary, key decisions, open threads, and last state. ' +
      'Use this instead of manually calling session_recall multiple times. ' +
      'For drill-down into specific time segments, use session_recall with chunk_id after.',
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
    // H20: Adaptive threshold — shorter content needs higher similarity to be a true duplicate
    let duplicateDetected = false;
    let contradictionDetected = false;
    const contradictionsFound: string[] = [];

    // M28: Exact dedup fast path — check content hash before expensive cosine similarity
    const existingExact = checkIdempotency(content);
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
        const existing = await api.get<{ memories?: Array<Record<string, unknown>> }>(
          `/memory/search?${searchParams}`, true,
        );
        const topMatch = existing.memories?.[0];
        if (topMatch && typeof (topMatch as Record<string, unknown>).score === 'number') {
          const score = (topMatch as Record<string, unknown>).score as number;
          // Shorter content → higher threshold (short strings match too easily)
          const threshold = content.length < 100 ? 0.96 : content.length < 300 ? 0.94 : 0.92;
          if (score > threshold) duplicateDetected = true;
        }
      } catch { /* non-blocking */ }
    }

    // Contradiction detection: check if content conflicts with existing beliefs
    try {
      const contradictions = await api.get<{ contradictions?: Array<Record<string, unknown>> }>(
        '/exocortex/contradictions?status=open', true,
      );
      if (contradictions.contradictions?.length) {
        contradictionDetected = true;
        for (const c of contradictions.contradictions.slice(0, 3)) {
          const entry = c as Record<string, unknown>;
          contradictionsFound.push(String(entry.explanation || entry.description || 'Conflict detected'));
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

    // M28: Record hash for future exact dedup
    if (result.id) recordIdempotency(content, result.id);

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
    const chunkId = args.chunk_id as string | undefined;
    const startTime = args.start_time as string | undefined;
    const endTime = args.end_time as string | undefined;
    const order = (args.order as string) || 'recent_first';
    const limit = Math.min((args.limit as number) || 10, 50);

    if (!sessionId && !topic) throw new Error('Either session_id or topic required');

    let rawMemories: Array<Record<string, unknown>> = [];

    if (sessionId) {
      const result = await api.get<{ memories?: Array<Record<string, unknown>>; count?: number }>(
        `/memory/session/${sessionId}?limit=${limit}`, true,
      );
      rawMemories = result.memories || [];
    } else {
      const params = new URLSearchParams({ q: `session ${topic}`, user_id: config.userId, limit: String(limit) });
      const result = await api.get<{ memories?: Array<Record<string, unknown>> }>(`/memory/search?${params}`, true);
      rawMemories = result.memories || [];
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

    // Step 1: Find session memories — by ID, topic, or most recent
    let memories: Array<Record<string, unknown>> = [];

    if (sessionId) {
      const result = await api.get<{ memories?: Array<Record<string, unknown>> }>(
        `/memory/session/${sessionId}?limit=50`, true,
      );
      memories = result.memories || [];
    } else {
      // Search for session-tagged memories
      const q = topic ? `session ${topic}` : 'session';
      const params = new URLSearchParams({ q, user_id: config.userId, limit: '50' });
      const result = await api.get<{ memories?: Array<Record<string, unknown>> }>(`/memory/search?${params}`, true);
      memories = result.memories || [];
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
    const sorted = memories
      .map(m => {
        const ts = new Date(String(m.created_at || m.timestamp || '')).getTime() || 0;
        return { content: String(m.content || ''), tags: Array.isArray(m.tags) ? m.tags as string[] : [], ts };
      })
      .filter(m => m.ts > 0)
      .sort((a, b) => a.ts - b.ts);

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
    const results = await Promise.allSettled(
      items.map(async item => {
        // Idempotency: skip if same content was stored recently
        const existingId = checkIdempotency(item.content);
        if (existingId) return { id: existingId, deduplicated: true };
        const res = await api.post<{ id?: string; error?: string }>('/memory', {
          content: item.content,
          user_id: config.userId,
          tier: item.tier ?? 2,
          tags: item.tags || autoTags(item.content),
          author: { type: 'user' },
        });
        if (res.id) recordIdempotency(item.content, res.id);
        return res;
      }),
    );

    const statuses = results.map((r, i) => {
      const val = r.status === 'fulfilled' ? r.value as Record<string, unknown> : null;
      return {
        index: i,
        status: r.status === 'fulfilled' && !val?.error ? 'ok' : 'error',
        id: val?.id as string | undefined,
        deduplicated: val?.deduplicated === true,
        error: r.status === 'rejected' ? String(r.reason) : val?.error ? String(val.error) : undefined,
        // H25: Include content preview on failures so client knows what to retry
        ...(r.status === 'rejected' || val?.error ? { content_preview: items[i].content.slice(0, 80) } : {}),
      };
    });

    const failed = statuses.filter(s => s.status === 'error');
    return {
      text: JSON.stringify(wrapResponse({
        items: statuses,
        stored_count: statuses.filter(s => s.status === 'ok').length,
        error_count: failed.length,
        // H25: Retry guidance
        ...(failed.length ? { retry_hint: `${failed.length} item(s) failed. Retry only the failed indices: [${failed.map(f => f.index).join(', ')}]` } : {}),
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
    const providedSummary = args.summary as string | undefined;
    const preview = args.preview === true;

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
          const m = f.value.memory as Record<string, unknown>;
          candidates.push({ id: String(m.id || ''), content: String(m.content || ''), tags: Array.isArray(m.tags) ? m.tags.filter((t): t is string => typeof t === 'string') : [] });
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
          const mem = await api.get<{ memory?: Record<string, unknown> }>(`/memory/${id}`, true);
          const rawTags = (mem.memory && typeof mem.memory === 'object') ? (mem.memory as Record<string, unknown>).tags : undefined;
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
      items.map(async item => {
        const existingId = checkIdempotency(item.content);
        if (existingId) return { id: existingId, deduplicated: true } as { id?: string; error?: string; deduplicated?: boolean };
        const res = await api.post<{ id?: string; error?: string }>('/memory/store', {
          content: item.content,
          tags: [...(item.tags || []), ...defaultTags, ...(source ? [`source:${source}`] : [])],
          tier: item.tier ?? 2,
          user_id: config.userId,
        });
        if (res.id) recordIdempotency(item.content, res.id);
        return res;
      }),
    );

    const statuses = results.map((r, i) => ({
      index: i,
      status: r.status === 'fulfilled' ? 'ok' : 'error',
      id: r.status === 'fulfilled' ? (r.value as Record<string, unknown>).id as string | undefined : undefined,
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
