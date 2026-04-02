// ── Context Construction Tools ──
// velixar_prepare_context — task-aware context assembly with anti-hallucination
// velixar_refine_context — iterative mid-generation refinement
// Phase 5: The capstone — consumes all retrieval tools internally.

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
import type { ApiClient } from '../api.js';
import { normalizeMemory, wrapResponse } from '../api.js';
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
        token_budget: { type: 'number', description: 'Max tokens for context package. Auto-scales by strategy if omitted: task_answer=4000, decision_support=6000, historical_review=8000, exploration=3000.' },
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
    const STRATEGY_BUDGETS: Record<Strategy, number> = { task_answer: 4000, decision_support: 6000, historical_review: 8000, exploration: 3000 };
    const budget = Math.min((args.token_budget as number) || STRATEGY_BUDGETS[strategy], 12000);
    const contextTtlSec = (args.context_ttl as number) || 600;
    const contextTtlMs = contextTtlSec * 1000;
    const includeIds = new Set((args.include_ids as string[]) || []);
    const excludeIds = new Set((args.exclude_ids as string[]) || []);
    // Include wins over exclude
    for (const id of includeIds) excludeIds.delete(id);

    const contextId = randomUUID();
    const provenanceLog: Array<Record<string, unknown>> = [];
    const INTERNAL_TIMEOUT = 3000;

    // Step 1: Multi-angle retrieval (with timeout)
    // Prefer explicit queries from LLM (they know the vocabulary); fall back to intent extraction
    const explicitQueries = args.queries as string[] | undefined;
    let angles: string[];
    if (explicitQueries?.length) {
      angles = explicitQueries.slice(0, 5);
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
      const searchResults = await Promise.race([
        Promise.allSettled(
          angles.map(q => {
            const params = new URLSearchParams({ q, user_id: config.userId, limit: '10' });
            return api.get<unknown>(`/memory/search?${params}`, true);
          }),
        ),
        new Promise<PromiseSettledResult<unknown>[]>(resolve =>
          setTimeout(() => resolve([]), INTERNAL_TIMEOUT)
        ),
      ]);

      const perQuery = (searchResults as PromiseSettledResult<unknown>[]).map((r, i) => {
        if (r.status !== 'fulfilled') return { query: angles[i], memories: [] as MemoryItem[] };
        try {
          const validated = validateSearchResponse(r.value, '/memory/search');
          return {
            query: angles[i],
            memories: validated.memories.map(m => { const mem = normalizeMemory(m); mem.workspace_id = config.workspaceId; return mem; }),
          };
        } catch { return { query: angles[i], memories: [] as MemoryItem[] }; }
      });

      const { merged } = mergeMultiQueryResults(perQuery, 'weighted', 20);
      allMemories = merged;
      provenanceLog.push({ step: 'multi_search', queries: angles, results: merged.length, ms: Date.now() - searchStart });
    } catch {
      provenanceLog.push({ step: 'multi_search', error: 'timeout', ms: INTERNAL_TIMEOUT });
    }

    // Add forced includes
    for (const id of includeIds) {
      if (!allMemories.some(m => m.id === id)) {
        try {
          const raw = await api.get<unknown>(`/memory/${id}`, true);
          const rObj = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {};
          const memData = (rObj.memory && typeof rObj.memory === 'object') ? rObj.memory as Record<string, unknown> : null;
          if (memData) {
            const mem = normalizeMemory({
              id: String(memData.id || ''), content: String(memData.content || ''),
              score: typeof memData.score === 'number' ? memData.score : undefined,
              tier: typeof memData.tier === 'number' ? memData.tier : undefined,
              type: typeof memData.type === 'string' ? memData.type : null,
              tags: Array.isArray(memData.tags) ? memData.tags.filter((t): t is string => typeof t === 'string') : [],
              created_at: typeof memData.created_at === 'string' ? memData.created_at : undefined,
              previous_memory_id: typeof memData.previous_memory_id === 'string' ? memData.previous_memory_id : null,
            });
            mem.workspace_id = config.workspaceId;
            allMemories.push(mem);
          }
        } catch { /* skip unfetchable includes */ }
      }
    }

    // Remove excludes
    allMemories = allMemories.filter(m => !excludeIds.has(m.id));

    // Step 2: Temporal merge
    const temporal = temporalMerge(allMemories);
    const currentMemories = temporal.current;
    provenanceLog.push({ step: 'temporal_merge', current: currentMemories.length, superseded: temporal.superseded.length });

    // Step 3: Coverage check (best-effort, skip if slow)
    let coverageRatio: number | null = null;
    let gaps: Array<{ id: string; preview: string; relevance: number }> = [];
    let suggestedQueries: string[] = [];
    try {
      const covRaw = await Promise.race([
        api.post<unknown>('/memory/coverage', { topic: intent, memory_ids: currentMemories.map(m => m.id) }),
        new Promise<null>(resolve => setTimeout(() => resolve(null), 2000)),
      ]);
      if (covRaw) {
        const cov = validateCoverageResponse(covRaw, '/memory/coverage');
        coverageRatio = cov.coverage_ratio;
        gaps = cov.gaps;
        suggestedQueries = cov.suggested_queries;
        provenanceLog.push({ step: 'coverage_check', ratio: coverageRatio, gaps: gaps.length });
      }
    } catch {
      // Fallback: estimate from search
      coverageRatio = null;
      provenanceLog.push({ step: 'coverage_check', status: 'unavailable' });
    }

    // Step 4: Build sections by strategy priority
    const sectionOrder = SECTION_PRIORITY[strategy];
    const sections: Array<{ label: string; content: string; memory_ids: string[]; confidence: number; truncated: boolean }> = [];
    let usedTokens = 0;
    const charBudget = budget * 4;

    // Current state section
    const currentContent = currentMemories.slice(0, 8).map(m => m.content).join('\n\n');
    if (currentContent) {
      const tokens = estimateTokens(currentContent);
      const truncated = usedTokens + tokens > charBudget / 4 && sections.length > 0;
      const finalContent = truncated ? currentContent.slice(0, Math.max(200, (charBudget - usedTokens * 4))) : currentContent;
      sections.push({
        label: 'current_state',
        content: finalContent,
        memory_ids: currentMemories.slice(0, 8).map(m => m.id),
        confidence: coverageRatio !== null ? Math.min(0.95, coverageRatio + 0.1) : 0.7,
        truncated,
      });
      usedTokens += estimateTokens(finalContent);
    }

    // Decisions section
    const decisions = currentMemories.filter(m =>
      /\b(decided|decision|chose|going with)\b/i.test(m.content)
    );
    if (decisions.length > 0 && usedTokens * 4 < charBudget * 0.8) {
      const decContent = decisions.slice(0, 5).map(m => m.content).join('\n\n');
      const finalContent = decContent.slice(0, Math.max(200, charBudget - usedTokens * 4));
      sections.push({
        label: 'key_decisions',
        content: finalContent,
        memory_ids: decisions.slice(0, 5).map(m => m.id),
        confidence: 0.85,
        truncated: finalContent.length < decContent.length,
      });
      usedTokens += estimateTokens(finalContent);
    }

    // Unknowns section (always included — anti-hallucination)
    const gapDescriptions = gaps.map(g => g.preview).filter(Boolean);
    const unknownsContent = gapDescriptions.length > 0
      ? `No data retrieved for: ${gapDescriptions.slice(0, 5).join('; ')}`
      : coverageRatio !== null && coverageRatio < 0.7
        ? 'Coverage is below 70% — some relevant context may be missing.'
        : '';
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
          memories_excluded_budget: Math.max(0, currentMemories.length - 8),
          coverage_ratio: coverageRatio,
          temporal_span: {
            from: temporal.temporal_context.oldest_memory,
            to: temporal.temporal_context.newest_memory,
          },
          chain_count: temporal.temporal_context.chain_count,
        },
        anti_hallucination: {
          explicit_gaps: gapDescriptions.slice(0, 10),
          low_confidence_sections: sections.filter(s => s.confidence < 0.5).map(s => s.label),
          contradictions_active: 0,
          instruction: gaps.length > 0
            ? 'Do NOT fill gaps listed above with inference. State them as unknown.'
            : coverageRatio !== null && coverageRatio < 0.7
              ? 'Coverage is incomplete. Qualify your answer and note what may be missing.'
              : 'Context appears adequate for synthesis.',
          suggested_queries: suggestedQueries,
        },
        provenance: { context_id: contextId, created_at: new Date().toISOString(), expires_at: expiresAt, intent, strategy, steps: provenanceLog },
      }, config, {
        data_absent: currentMemories.length === 0,
        partial_context: coverageRatio !== null && coverageRatio < 0.5,
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

      const params = new URLSearchParams({ q: act.target, user_id: config.userId, limit: '10' });
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
