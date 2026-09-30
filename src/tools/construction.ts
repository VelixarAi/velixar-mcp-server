// ── Context Construction Tools ──
// velixar_prepare_context — task-aware context assembly with anti-hallucination
// velixar_refine_context — iterative mid-generation refinement
// Phase 5: The capstone — consumes all retrieval tools internally.

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
import type { ApiClient } from '../api.js';
import { normalizeMemory, userParams, wrapResponse, toRawMemory } from '../api.js';
import type { ApiConfig, MemoryItem } from '../types.js';
import { validateSearchResponse } from '../validate.js';
import { validateCoverageResponse } from '../validate_retrieval.js';
import { temporalMerge, mergeMultiQueryResults } from '../temporal_merge.js';

// ── Context State Cache ──
// Keyed by workspaceId:contextId. TTL 10 minutes.
interface ContextState {
  contextId: string;
  intent: string;
  strategy: string;
  memories: MemoryItem[];
  gaps: Array<{ id: string; preview: string; relevance: number }>;
  coverageRatio: number | null;
  refinementCount: number;
  createdAt: number;
  ttlMs: number;
  provenance: Array<Record<string, unknown>>;
}

const contextCache = new Map<string, ContextState>();
const MAX_REFINEMENTS = 5;

function cacheKey(workspaceId: string, contextId: string): string {
  return `${workspaceId}:${contextId}`;
}

function getContext(workspaceId: string, contextId: string): ContextState | null {
  const key = cacheKey(workspaceId, contextId);
  const state = contextCache.get(key);
  if (!state) return null;
  if (Date.now() - state.createdAt > state.ttlMs) { contextCache.delete(key); return null; }
  return state;
}

// ── Token Estimation ──
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ── Strategy Section Priority ──
type Strategy = 'task_answer' | 'decision_support' | 'historical_review' | 'exploration';

const SECTION_PRIORITY: Record<Strategy, string[]> = {
  task_answer: ['current_state', 'key_decisions', 'unknowns', 'history'],
  decision_support: ['contradictions', 'current_state', 'alternatives', 'precedents'],
  historical_review: ['timeline', 'evolution', 'superseded', 'current_state'],
  exploration: ['broad_coverage', 'related_entities', 'patterns', 'unknowns'],
};

export const constructionTools: Tool[] = [
  {
    name: 'velixar_prepare_context',
    description:
      'Assemble a token-budgeted, task-aware context package with explicit gap declaration. ' +
      'Runs multi-angle search, coverage check, and temporal analysis internally.',
    inputSchema: {
      type: 'object',
      properties: {
        queries: { type: 'array', items: { type: 'string' }, description: 'Explicit search queries (recommended). If omitted, queries are auto-generated from intent.' },
        intent: { type: 'string', description: 'What you are about to do — drives section prioritization' },
        token_budget: { type: 'number', description: 'Max tokens for context package (up to 32000). Auto-scales by strategy if omitted: task_answer=8000, decision_support=8000, historical_review=12000, exploration=4000. Larger budgets also retrieve more candidates.' },
        max_tokens_per_memory: { type: 'number', description: 'Trim each included memory to its first N tokens (min 100; default 400; 0 = never trim) so more distinct memories fit the budget. Trimmed memories are marked \u2026[trimmed].' },
        strategy: { type: 'string', enum: ['task_answer', 'decision_support', 'historical_review', 'exploration'], description: 'Shapes section priority (default: task_answer)' },
        include_ids: { type: 'array', items: { type: 'string' }, description: 'Memory IDs that MUST be included' },
        exclude_ids: { type: 'array', items: { type: 'string' }, description: 'Memory IDs to exclude' },
        context_ttl: { type: 'number', description: 'TTL in seconds for the context package (default: 600). After expiry, refine_context will fail.' },
      },
      required: ['intent'],
    },
  },
  {
    name: 'velixar_refine_context',
    description:
      'Expand a section, fill a gap, or add a topic to an existing context package. ' +
      'Accepts a single action or an array of actions for batch refinement.',
    inputSchema: {
      type: 'object',
      properties: {
        context_id: { type: 'string', description: 'ID from prepare_context response' },
        action: { type: 'string', enum: ['expand_section', 'fill_gap', 'add_topic'], description: 'What to do (single action)' },
        target: { type: 'string', description: 'Section label, gap name, or new topic (single action)' },
        actions: { type: 'array', items: { type: 'object', properties: { action: { type: 'string' }, target: { type: 'string' }, budget: { type: 'number' } } }, description: 'Batch: array of {action, target, budget?} for multiple refinements in one call' },
        additional_budget: { type: 'number', description: 'Extra tokens (default 1000)' },
      },
      required: ['context_id'],
    },
  },
];

export async function handleConstructionTool(
  name: string,
  args: Record<string, unknown>,
  api: ApiClient,
  config: ApiConfig,
): Promise<{ text: string; isError?: boolean }> {

  if (name === 'velixar_prepare_context') {
    const intent = args.intent as string;
    const strategy = (args.strategy as Strategy) || (intent.length < 20 ? 'exploration' : 'task_answer');
    // Build 5.1: Smart token budget — auto-scale by strategy
    // task_answer 4000 → 8000 (2026-09-30, 40-task A/B: 8K + 400 tokens/memory beat plain search at the same size).
    const STRATEGY_BUDGETS: Record<Strategy, number> = { task_answer: 8000, decision_support: 8000, historical_review: 12000, exploration: 4000 };
    // Cap raised 12000 -> 32000 (2026-09-30, 40-task A/B): the 8K package held too few of the memories a
    // task needed; a request above the old cap was silently clamped to 12K.
    const budget = Math.min((args.token_budget as number) || STRATEGY_BUDGETS[strategy], 32000);
    // Candidate pool scales with the budget (~1 candidate per 400 tokens, 20..60): a fixed top-20 merge
    // capped a large budget at 20 memories whatever it could hold.
    const maxCandidates = Math.max(20, Math.min(60, Math.round(budget / 400)));
    const perAngleLimit = Math.max(10, Math.min(25, Math.ceil(maxCandidates / 2)));
    // Optional per-memory cap: trims each memory to its first N tokens so more distinct memories fit.
    // Default 400 tokens per memory (same A/B: trimming roughly doubled the needed memories per token). 0 disables.
    const perMemoryTokens = args.max_tokens_per_memory === undefined ? 400 : Number(args.max_tokens_per_memory);
    const perMemoryChars = perMemoryTokens > 0 ? Math.max(100, perMemoryTokens) * 4 : Infinity;
    const clip = (c: string) => c.length > perMemoryChars ? c.slice(0, perMemoryChars) + ' …[trimmed]' : c;
    const contextTtlSec = (args.context_ttl as number) || 600;
    const contextTtlMs = contextTtlSec * 1000;
    const includeIds = new Set((args.include_ids as string[]) || []);
    const excludeIds = new Set((args.exclude_ids as string[]) || []);
    // Include wins over exclude
    for (const id of includeIds) excludeIds.delete(id);

    const contextId = randomUUID();
    const provenanceLog: Array<Record<string, unknown>> = [];
    // 3000ms was too tight AND failed silently. Every angle issues a /memory/search, and
    // search EMBEDS the query server-side — the measured store-pipeline baseline is ~5s, so
    // three parallel embedding searches routinely exceeded a 3s budget. The race then
    // resolved to [], which does not throw, so the catch never fired and the provenance log
    // recorded `results: 0` — a slow search became indistinguishable from an empty corpus.
    // Verified in prod 2026-07-31: memories_considered 0 at request_ms 3103, on a
    // 2670-memory workspace where velixar_search returned 10 hits immediately.
    // PER-ANGLE deadlines (2026-09-30). The single Promise.race over allSettled was
    // all-or-nothing: one slow angle past 10s discarded EVERY angle, including the ones that
    // had already answered. Measured: 5 explicit queries -> retrieval_status timeout, 0
    // memories; the same intent with 2 queries -> 14 memories in 3.3s. Each angle now races
    // its own deadline; answered angles are kept, and a lookup with some angles missing is
    // PARTIAL (never complete, never empty).
    const PER_ANGLE_TIMEOUT = 12000;
    const TIMED_OUT = Symbol('retrieval_timeout');
    let retrievalStatus: 'ok' | 'partial' | 'timeout' | 'error' = 'ok';
    const angleStatus: Array<{ query: string; status: 'ok' | 'timeout' | 'error'; ms: number }> = [];

    // Step 1: Multi-angle retrieval (per-angle deadlines)
    // Prefer explicit queries from LLM (they know the vocabulary); fall back to intent extraction
    const explicitQueries = args.queries as string[] | undefined;
    let angles: string[];
    if (explicitQueries?.length) {
      // The intent itself is always an angle (2026-09-30 A/B): a single meaning search on the full
      // task description beat the keyword angles alone on recall and precision.
      angles = [...new Set([intent.trim(), ...explicitQueries.map(q => q.trim())].filter(Boolean))].slice(0, 5);
    } else {
      const intentClean = intent.replace(/[?!.]+$/g, '').trim();
      const significant = intentClean.split(/\s+/).filter(w =>
        w.length > 3 && !/^(what|that|this|with|from|about|should|could|would|does|have|been|their|there|which|where|when|into|status|current)$/i.test(w)
      );
      const topicPhrase = significant.slice(0, 3).join(' ') || intentClean.slice(0, 30);
      angles = [topicPhrase, `${topicPhrase} plan`, `${topicPhrase} strategy`];
    }
    const searchStart = Date.now();

    let allMemories: MemoryItem[] = [];
    try {
      const settled = await Promise.all(angles.map(async q => {
        const t0 = Date.now();
        const params = userParams(config, { q, limit: String(perAngleLimit) });
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const r = await Promise.race([
            api.get<unknown>(`/memory/search?${params}`, true),
            new Promise<typeof TIMED_OUT>(resolve => { timer = setTimeout(() => resolve(TIMED_OUT), PER_ANGLE_TIMEOUT); }),
          ]);
          if (r === TIMED_OUT) { angleStatus.push({ query: q, status: 'timeout', ms: Date.now() - t0 }); return { query: q, raw: null as unknown }; }
          angleStatus.push({ query: q, status: 'ok', ms: Date.now() - t0 });
          return { query: q, raw: r as unknown };
        } catch {
          angleStatus.push({ query: q, status: 'error', ms: Date.now() - t0 });
          return { query: q, raw: null as unknown };
        } finally { if (timer) clearTimeout(timer); }
      }));
      const okCount = angleStatus.filter(a => a.status === 'ok').length;
      const timeoutCount = angleStatus.filter(a => a.status === 'timeout').length;
      retrievalStatus = okCount === angles.length ? 'ok'
        : okCount > 0 ? 'partial'
        : timeoutCount > 0 ? 'timeout' : 'error';

      const perQuery = settled.map(({ query, raw }) => {
        if (raw == null) return { query, memories: [] as MemoryItem[] };
        try {
          const validated = validateSearchResponse(raw, '/memory/search');
          return { query, memories: validated.memories.map(m => { const mem = normalizeMemory(m); mem.workspace_id = config.workspaceId; return mem; }) };
        } catch { return { query, memories: [] as MemoryItem[] }; }
      });

      const { merged } = mergeMultiQueryResults(perQuery, 'weighted', maxCandidates);
      allMemories = merged;
      provenanceLog.push({ step: 'multi_search', status: retrievalStatus, queries: angles, angles: angleStatus, results: merged.length, ms: Date.now() - searchStart });
    } catch (e) {
      retrievalStatus = 'error';
      provenanceLog.push({ step: 'multi_search', status: 'error', detail: String(e), ms: Date.now() - searchStart });
    }

    // Add forced includes
    for (const id of includeIds) {
      if (!allMemories.some(m => m.id === id)) {
        try {
          const raw = await api.get<unknown>(`/memory/${id}`, true);
          const rObj = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {};
          const memData = (rObj.memory && typeof rObj.memory === 'object') ? rObj.memory as Record<string, unknown> : null;
          if (memData) {
            const mem = normalizeMemory(toRawMemory(memData));
            mem.workspace_id = config.workspaceId;
            allMemories.push(mem);
          }
        } catch { /* skip unfetchable includes */ }
      }
    }

    // Remove excludes
    allMemories = allMemories.filter(m => !excludeIds.has(m.id));

    // DE-DUPLICATE identical content (2026-09-30). The store can hold the same text under two
    // ids (duplicate-write defect); the package then spent budget on it twice. Only IDENTICAL
    // normalized content is merged — near-duplicates stay distinct — and the newest id is kept.
    const byContent = new Map<string, MemoryItem>();
    const duplicateIds: string[] = [];
    const norm = (c: string) => (c || '').replace(/\s+/g, ' ').trim();
    for (const m of allMemories) {
      const k = norm(m.content);
      const prev = byContent.get(k);
      if (!prev) { byContent.set(k, m); continue; }
      const keepNew = includeIds.has(m.id) || (!includeIds.has(prev.id) && String(m.provenance?.created_at ?? '') > String(prev.provenance?.created_at ?? ''));
      duplicateIds.push(keepNew ? prev.id : m.id);
      if (keepNew) byContent.set(k, { ...m, relevance: Math.max(m.relevance ?? 0, prev.relevance ?? 0) });
    }
    allMemories = [...byContent.values()];
    if (duplicateIds.length) provenanceLog.push({ step: 'dedupe', removed: duplicateIds.length, removed_ids: duplicateIds });

    // RELEVANCE FLOOR relative to the best match (2026-09-30): the merged top-20 admitted
    // weak matches (an unrelated review rode in on a shared word). Forced includes bypass it.
    const RELEVANCE_FLOOR = 0.55;
    const top = Math.max(0, ...allMemories.map(m => m.relevance ?? 0));
    const belowFloor = top > 0 ? allMemories.filter(m => !includeIds.has(m.id) && (m.relevance ?? 0) < RELEVANCE_FLOOR * top) : [];
    if (belowFloor.length) {
      const drop = new Set(belowFloor.map(m => m.id));
      allMemories = allMemories.filter(m => !drop.has(m.id));
      provenanceLog.push({ step: 'relevance_floor', floor_ratio: RELEVANCE_FLOOR, top_relevance: top, removed: belowFloor.length, removed_ids: [...drop] });
    }

    // Step 2: Temporal merge
    const temporal = temporalMerge(allMemories);
    const currentMemories = temporal.current;
    provenanceLog.push({ step: 'temporal_merge', current: currentMemories.length, superseded: temporal.superseded.length });

    // Step 3: Coverage check (best-effort, skip if slow)
    let coverageRatio: number | null = null;
    let gaps: Array<{ id: string; preview: string; relevance: number }> = [];
    let suggestedQueries: string[] = [];
    try {
      const covStart = Date.now();
      const covRaw = await Promise.race([
        api.post<unknown>('/memory/coverage', { topic: intent, memory_ids: currentMemories.map(m => m.id) }),
        new Promise<null>(resolve => setTimeout(() => resolve(null), 5000)),
      ]);
      // A timeout used to resolve null and leave NO provenance entry, so "coverage unavailable"
      // had no recorded cause. Every outcome is logged now.
      if (!covRaw) provenanceLog.push({ step: 'coverage_check', status: 'timeout', ms: Date.now() - covStart });
      if (covRaw) {
        const cov = validateCoverageResponse(covRaw, '/memory/coverage');
        coverageRatio = cov.coverage_ratio;
        gaps = cov.gaps;
        suggestedQueries = cov.suggested_queries;
        provenanceLog.push({ step: 'coverage_check', ratio: coverageRatio, gaps: gaps.length });
      }
    } catch (e) {
      coverageRatio = null;
      provenanceLog.push({ step: 'coverage_check', status: 'unavailable', detail: String(e).slice(0, 160) });
    }

    // Step 4: Build sections by strategy priority
    const sectionOrder = SECTION_PRIORITY[strategy];
    const sections: Array<{ label: string; content: string; memory_ids: string[]; confidence: number; truncated: boolean }> = [];
    let usedTokens = 0;

    // Current state section — memories in relevance order until the budget share is used.
    // The old code joined the top 8 whole and could never truncate the FIRST section, so the
    // package could exceed its token budget.
    const charBudget = budget * 4;
    const ranked = [...currentMemories].sort((a, b) => (b.relevance ?? 0) - (a.relevance ?? 0));
    const stateBudget = Math.floor(charBudget * 0.75);
    const stateParts: string[] = []; const stateIds: string[] = []; let stateChars = 0; let stateTruncated = false;
    for (const m of ranked.slice(0, 8)) {
      const room = stateBudget - stateChars;
      if (room < 200) { stateTruncated = true; break; }
      const full = clip(m.content);
      const c = full.length > room ? full.slice(0, room) : full;
      if (c.length < m.content.length) stateTruncated = true;
      stateParts.push(c); stateIds.push(m.id); stateChars += c.length + 2;
    }
    if (stateParts.length) {
      const content = stateParts.join('\n\n');
      sections.push({ label: 'current_state', content, memory_ids: stateIds,
        confidence: coverageRatio !== null ? Math.min(0.95, coverageRatio + 0.1) : 0.7, truncated: stateTruncated });
      usedTokens += estimateTokens(content);
    }

    // Decisions section — never repeats a memory already in current_state.
    const included = new Set(stateIds);
    const decisions = ranked.filter(m => !included.has(m.id) && /\b(decided|decision|chose|going with|ruling|ruled)\b/i.test(m.content));
    if (decisions.length > 0 && usedTokens * 4 < charBudget * 0.9) {
      const decContent = decisions.slice(0, 5).map(m => clip(m.content)).join('\n\n');
      const finalContent = decContent.slice(0, Math.max(200, charBudget - usedTokens * 4));
      sections.push({ label: 'key_decisions', content: finalContent, memory_ids: decisions.slice(0, 5).map(m => m.id),
        confidence: 0.85, truncated: finalContent.length < decContent.length });
      usedTokens += estimateTokens(finalContent);
    }

    // Fill the remaining budget with the next-ranked memories (2026-09-30 A/B): the package stopped at
    // 8 memories + decisions even with half the budget unused, and missed needed records.
    const usedIds = new Set(sections.flatMap(x => x.memory_ids));
    const rest = ranked.filter(m => !usedIds.has(m.id));
    const relParts: string[] = []; const relIds: string[] = [];
    for (const m of rest) {
      const room = Math.floor(charBudget * 0.95) - usedTokens * 4 - relParts.reduce((n, x) => n + x.length + 2, 0);
      if (room < 300) break;
      const full = clip(m.content);
      relParts.push(full.length > room ? full.slice(0, room) : full); relIds.push(m.id);
    }
    if (relParts.length) {
      const content = relParts.join('\n\n');
      sections.push({ label: 'related', content, memory_ids: relIds, confidence: 0.6, truncated: false });
      usedTokens += estimateTokens(content);
    }

    // Unknowns section (always included — anti-hallucination)
    const gapDescriptions = gaps.map(g => g.preview).filter(Boolean);
    const unknownsContent = gapDescriptions.length > 0
      ? `No data retrieved for: ${gapDescriptions.slice(0, 5).join('; ')}`
      : coverageRatio !== null && coverageRatio < 0.7
        ? 'Coverage is below 70% — some relevant context may be missing.'
        : '';
    const unknownsTokens = unknownsContent ? estimateTokens(unknownsContent) : 0;
    // HARD budget cap (2026-09-30): measured 8,132 tokens against an 8,000 budget on the live
    // store. Trim from the end until the package fits, leaving room for the unknowns line.
    const reserve = unknownsTokens + 10;
    while (sections.length && usedTokens > budget - reserve) {
      const last = sections[sections.length - 1];
      const over = (usedTokens - (budget - reserve)) * 4;
      if (last.content.length - over < 200) { usedTokens -= estimateTokens(last.content); sections.pop(); continue; }
      const before = estimateTokens(last.content);
      last.content = last.content.slice(0, last.content.length - over); last.truncated = true;
      usedTokens += estimateTokens(last.content) - before;
    }

    if (unknownsContent) {
      sections.push({
        label: 'unknowns',
        content: unknownsContent,
        memory_ids: [],
        confidence: 1.0,
        truncated: false,
      });
      usedTokens += estimateTokens(unknownsContent);
    }

    // Cache state for refine_context
    const state: ContextState = {
      contextId, intent, strategy, memories: currentMemories,
      gaps, coverageRatio, refinementCount: 0,
      createdAt: Date.now(), ttlMs: contextTtlMs, provenance: provenanceLog,
    };
    contextCache.set(cacheKey(config.workspaceId, contextId), state);
    const expiresAt = new Date(state.createdAt + contextTtlMs).toISOString();

    return {
      text: JSON.stringify(wrapResponse({
        context_id: contextId,
        context_package: {
          sections,
          token_count: usedTokens,
          budget_used: Math.round((usedTokens / budget) * 100) / 100,
        },
        retrieval_metadata: {
          memories_considered: allMemories.length + (excludeIds.size),
          memories_included: currentMemories.length,
          memories_excluded_superseded: temporal.superseded.length,
          memories_excluded_budget: Math.max(0, currentMemories.length - sections.reduce((n, x) => n + x.memory_ids.length, 0)),
          duplicates_removed: duplicateIds.length,
          below_relevance_floor: belowFloor.length,
          coverage_ratio: coverageRatio,
          temporal_span: {
            from: temporal.temporal_context.oldest_memory,
            to: temporal.temporal_context.newest_memory,
          },
          chain_count: temporal.temporal_context.chain_count,
        },
        anti_hallucination: (() => {
          // DENY-BY-DEFAULT ADEQUACY. The old ternary fell through to "Context appears
          // adequate for synthesis" in the two states where adequacy is LEAST knowable:
          //   * zero memories retrieved  -> no gaps found, because there was nothing to
          //     find gaps IN. Absence of evidence became evidence of adequacy.
          //   * coverage check unavailable -> `coverageRatio !== null` is false, so the
          //     "incomplete" branch was SKIPPED and UNKNOWN coverage read as fine.
          // Verified in prod 2026-07-31: 0 memories, data_absent true, coverage
          // "unavailable" — and the tool still emitted "adequate for synthesis" with
          // explicit_gaps []. That is an FIR §3.5 violation (confidence must survive every
          // boundary hop) in the one tool whose entire purpose is preventing ungrounded
          // assertion. Adequacy is now something we must AFFIRMATIVELY KNOW, never a
          // default reached by elimination.
          const evidenceCount = currentMemories.length;
          const coverageKnown = coverageRatio !== null;
          let instruction: string;
          let doNotAssert = false;
          if (retrievalStatus === 'partial') {
            const missing = angleStatus.filter(a => a.status !== 'ok').map(a => a.query);
            instruction = `PARTIAL RETRIEVAL: ${missing.length} of ${angles.length} query angles did not answer (${missing.join('; ')}). What is here is real but incomplete — qualify the answer and do not treat missing topics as absent.`;
          } else if (retrievalStatus !== 'ok') {
            doNotAssert = true;
            instruction = `RETRIEVAL DID NOT COMPLETE (${retrievalStatus}). This is NOT an empty corpus — it is an unfinished lookup. Do not treat this as evidence of absence, and do not answer from it. Retry, or narrow the intent.`;
          } else if (evidenceCount === 0) {
            doNotAssert = true;
            instruction = 'NO MEMORIES RETRIEVED. Do not synthesise an answer from this context and do not report the topic as unknown to the organisation — retrieval returning nothing is not the same as nothing existing. Try velixar_context or a direct velixar_search first.';
          } else if (gaps.length > 0) {
            instruction = 'Do NOT fill gaps listed above with inference. State them as unknown.';
          } else if (coverageRatio === null) {   // narrow on the value so TS proves the next branch
            instruction = 'Coverage could NOT be verified (the check was unavailable). Treat this context as possibly incomplete and qualify the answer — an unverified coverage is not a good one.';
          } else if (coverageRatio < 0.7) {
            instruction = 'Coverage is incomplete. Qualify your answer and note what may be missing.';
          } else {
            instruction = 'Context appears adequate for synthesis.';
          }
          return {
            explicit_gaps: gapDescriptions.slice(0, 10),
            low_confidence_sections: sections.filter(s => s.confidence < 0.5).map(s => s.label),
            contradictions_active: 0,
            // Machine-readable twin of `instruction`, so a caller that never reads prose
            // still cannot mistake this for a green light.
            do_not_assert: doNotAssert,
            retrieval_status: retrievalStatus,
            coverage_verified: coverageKnown,
            instruction,
            suggested_queries: suggestedQueries,
          };
        })(),
        provenance: { context_id: contextId, created_at: new Date().toISOString(), expires_at: expiresAt, intent, strategy, steps: provenanceLog },
      }, config, {
        // A timed-out or errored retrieval is NOT absence — same lie class as an empty
        // page with a live cursor being reported as data_absent.
        data_absent: retrievalStatus === 'ok' && currentMemories.length === 0,
        ...(retrievalStatus !== 'ok' ? { absence_reason: 'retrieval_incomplete' as const } : {}),
        // Unknown coverage, or any angle that did not answer, is partial context.
        partial_context: retrievalStatus !== 'ok' || coverageRatio === null || coverageRatio < 0.5,
      })),
    };
  }

  if (name === 'velixar_refine_context') {
    const contextId = args.context_id as string;
    const state = getContext(config.workspaceId, contextId);
    if (!state) {
      return { text: JSON.stringify(wrapResponse({ error: 'Context expired or not found. Call velixar_prepare_context again.' }, config)), isError: true };
    }

    // Build 5.2: Support single action OR batch actions array
    type RefinementAction = { action: string; target: string; budget?: number };
    const actionsList: RefinementAction[] = args.actions
      ? (args.actions as RefinementAction[])
      : (args.action && args.target)
        ? [{ action: args.action as string, target: args.target as string, budget: args.additional_budget as number }]
        : [];
    if (actionsList.length === 0) {
      return { text: JSON.stringify(wrapResponse({ error: 'Provide action+target or actions array.' }, config)), isError: true };
    }

    if (state.refinementCount + actionsList.length > MAX_REFINEMENTS) {
      return { text: JSON.stringify(wrapResponse({ error: `Would exceed max ${MAX_REFINEMENTS} refinements (current: ${state.refinementCount}, requested: ${actionsList.length}).` }, config)), isError: true };
    }

    const existingIds = new Set(state.memories.map(m => m.id));
    const results: Array<Record<string, unknown>> = [];

    for (const act of actionsList) {
      const additionalBudget = Math.min(act.budget || 1000, 2000);
      let newMemories: MemoryItem[] = [];

      const params = userParams(config, { q: act.target, limit: '10' });
      try {
        const raw = await api.get<unknown>(`/memory/search?${params}`, true);
        const validated = validateSearchResponse(raw, '/memory/search');
        newMemories = validated.memories
          .map(m => { const mem = normalizeMemory(m); mem.workspace_id = config.workspaceId; return mem; })
          .filter(m => !existingIds.has(m.id));
      } catch { /* empty */ }

      const temporal = temporalMerge(newMemories);
      const added = temporal.current.slice(0, 5);
      state.memories.push(...added);
      for (const m of added) existingIds.add(m.id);
      state.refinementCount++;

      if (act.action === 'fill_gap') {
        state.gaps = state.gaps.filter(g => !g.preview.toLowerCase().includes(act.target.toLowerCase()));
      }

      state.provenance.push({ step: 'refinement', action: act.action, target: act.target, memories_added: added.length, refinement_number: state.refinementCount });

      const newContent = added.map(m => m.content).join('\n\n');
      results.push({
        action: act.action,
        target: act.target,
        memories_added: added.length,
        new_section: newContent ? {
          label: `${act.action}:${act.target}`,
          content: newContent.slice(0, additionalBudget * 4),
          memory_ids: added.map(m => m.id),
          confidence: added.length >= 3 ? 0.8 : added.length >= 1 ? 0.6 : 0.3,
          truncated: newContent.length > additionalBudget * 4,
        } : null,
      });
    }

    return {
      text: JSON.stringify(wrapResponse({
        context_id: contextId,
        refinements: results,
        remaining_gaps: state.gaps.map(g => g.preview),
        refinements_remaining: MAX_REFINEMENTS - state.refinementCount,
      }, config, {
        data_absent: results.every(r => r.memories_added === 0),
      })),
    };
  }

  throw new Error(`Unknown construction tool: ${name}`);
}
