// ── Recall Tools ──
// velixar_context — synthesized workspace brief (flagship)
// velixar_inspect — deep single-memory inspection

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ApiClient } from '../api.js';
import { normalizeMemory, userParams, wrapResponse, toRawMemory } from '../api.js';
import type { ApiConfig, MemoryItem } from '../types.js';
import { justify } from '../justify.js';
import { validateSearchResponse, validateListResponse, validateOverviewResponse } from '../validate.js';
import { temporalMerge, mergeMultiQueryResults } from '../temporal_merge.js';

export const recallTools: Tool[] = [
  {
    name: 'velixar_context',
    description:
      'Synthesize the best working brief for the current workspace. Recommended first tool for any new task. ' +
      'Returns summary, relevant facts, open issues, contradiction flags, and pattern hints.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'Optional topic to focus the brief on' },
        compact: { type: 'boolean', description: 'Compact mode (default true) — shorter summary' },
      },
    },
  },
  {
    name: 'velixar_inspect',
    description:
      'Deep inspection of a specific memory — raw content, provenance, relations, chain links.',
    inputSchema: {
      type: 'object',
      properties: {
        memory_id: { type: 'string', description: 'Memory ID to inspect' },
      },
      required: ['memory_id'],
    },
  },
];

export async function handleRecallTool(
  name: string,
  args: Record<string, unknown>,
  api: ApiClient,
  config: ApiConfig,
): Promise<{ text: string; isError?: boolean }> {
  if (name === 'velixar_context') {
    const topic = (args.topic as string) || '';
    const compact = args.compact !== false;
    const multiAngle = process.env.VELIXAR_CONTEXT_MULTI_ANGLE === 'true';

    const listParams = userParams(config, { limit: '5' });
    const startMs = Date.now();

    // Build search queries — single or multi-angle based on feature flag
    let searchPromises: Array<Promise<unknown>>;
    if (multiAngle && topic) {
      const angles = [topic, `decisions about ${topic}`, `problems or issues with ${topic}`];
      const perAngleLimit = compact ? '3' : '5';
      searchPromises = angles.map(q => {
        const p = userParams(config, { q, limit: perAngleLimit });
        return api.get<unknown>(`/memory/search?${p}`, true);
      });
    } else if (multiAngle && !topic) {
      const angles = ['important recent context', 'open decisions', 'unresolved issues'];
      searchPromises = angles.map(q => {
        const p = userParams(config, { q, limit: compact ? '3' : '5' });
        return api.get<unknown>(`/memory/search?${p}`, true);
      });
    } else {
      const searchQ = topic || 'important recent context';
      const params = userParams(config, { q: searchQ, limit: compact ? '5' : '10' });
      searchPromises = [api.get<unknown>(`/memory/search?${params}`, true)];
    }

    const [searchResults, listRes, overviewRes, contradictionsRes] = await Promise.allSettled([
      Promise.allSettled(searchPromises),
      api.get<unknown>(`/memory/list?${listParams}`, true),
      api.get<unknown>('/exocortex/overview', true),
      api.get<unknown>('/exocortex/contradictions?status=open', true),
    ]);

    // Merge search results — multi-angle dedup or single pass
    let relevantFacts: MemoryItem[] = [];
    const searchAnglesUsed = searchPromises.length;
    if (searchResults.status === 'fulfilled') {
      const subResults = searchResults.value as PromiseSettledResult<unknown>[];
      if (multiAngle && subResults.length > 1) {
        // Multi-angle: merge + dedup via temporal_merge
        const perQuery = subResults.map((r, i) => {
          if (r.status !== 'fulfilled') return { query: `angle-${i}`, memories: [] as MemoryItem[] };
          try {
            const validated = validateSearchResponse(r.value, '/memory/search');
            return {
              query: `angle-${i}`,
              memories: validated.memories.map(m => { const mem = normalizeMemory(m); mem.workspace_id = config.workspaceId; return mem; }),
            };
          } catch { return { query: `angle-${i}`, memories: [] as MemoryItem[] }; }
        });
        const { merged } = mergeMultiQueryResults(perQuery, 'weighted', compact ? 8 : 15);
        const temporal = temporalMerge(merged);
        relevantFacts = temporal.current;
      } else {
        // Single angle
        const r = subResults[0];
        if (r && r.status === 'fulfilled') {
          try {
            const validated = validateSearchResponse(r.value, '/memory/search');
            relevantFacts = validated.memories.map(m => { const mem = normalizeMemory(m); mem.workspace_id = config.workspaceId; return mem; });
          } catch { /* empty */ }
        }
      }
    }

    // Sort: semantic first, then by relevance
    relevantFacts.sort((a, b) => {
      if (a.memory_type === 'semantic' && b.memory_type !== 'semantic') return -1;
      if (a.memory_type !== 'semantic' && b.memory_type === 'semantic') return 1;
      return (b.relevance ?? 0) - (a.relevance ?? 0);
    });

    const list = listRes.status === 'fulfilled' ? validateListResponse(listRes.value, '/memory/list') : null;
    const overview = overviewRes.status === 'fulfilled' ? validateOverviewResponse(overviewRes.value, '/exocortex/overview') : null;
    const contradictionsRaw = contradictionsRes.status === 'fulfilled'
      ? ((contradictionsRes.value && typeof contradictionsRes.value === 'object') ? contradictionsRes.value as Record<string, unknown> : {})
      : null;

    // Recent activity from list
    const recentItems = (list?.memories || []).map(m => {
      const mem = normalizeMemory(m);
      mem.workspace_id = config.workspaceId;
      return mem;
    });

    // Contradiction flags
    const rawCArr = contradictionsRaw ? (Array.isArray(contradictionsRaw.contradictions) ? contradictionsRaw.contradictions : []) : [];
    const openContradictions = rawCArr.map((c: any) => {
      const a = c.statement_a || c.memory_a_content;
      const b = c.statement_b || c.memory_b_content;
      return {
        id: c.id,
        statement_a: a,
        statement_b: b,
        severity: c.severity || 'medium',
        // Observed in prod: entries arrived as {id, severity} and nothing else, because the
        // reader returns neither statement under either name. An id and a severity is not a
        // contradiction a model can act on — it is the SHAPE of one. Say that, instead of
        // emitting a stub that looks like content.
        ...((!a && !b) ? {
          detail_unavailable: true,
          note: `contradiction ${c.id} is flagged but its statements were not returned by the contradictions reader — fetch it directly with velixar_contradictions`,
        } : {}),
      };
    });

    // Render a count, or say plainly that it was not measured. Never substitute a number for
    // an absent one: "0" and "unreported" are different facts and a reader cannot recover the
    // difference once they are merged (FIR-2026-08-18).
    const fmtCount = (n: number | null | undefined): string =>
      typeof n === 'number' ? String(n) : 'an unmeasured number of';

    // Build brief
    const brief = {
      // `??` not `||`, and an explicit unknown branch. `0` is a MEANINGFUL value for every
      // count here, so `|| 0` destroyed the one distinction a reader needs: "the backend did
      // not report this" rendered identically to "there are none". Paired with a backend that
      // hardcoded `temporal_chains: 0`, the pair was unfalsifiable — see FIR-2026-08-18.
      summary: overview
        ? `Workspace has ${fmtCount(overview.total_memories)} memories, ${fmtCount(overview.cortex_nodes)} entities, ${fmtCount(overview.chain_edges ?? overview.temporal_chains)} chain edges. Mode: ${overview.system_mode ?? 'not measured'}.`
        : `${relevantFacts.length} relevant facts found${topic ? ` for "${topic}"` : ''}.`,
      relevant_facts: relevantFacts,
      recent_activity: compact ? recentItems.slice(0, 3) : recentItems,
      open_issues: openContradictions,
      contradiction_count: openContradictions.length,
      // NOT a computed empty result. Nothing has ever populated this, and returning []
      // claims "we looked and found none" — which is a different statement, and the one a
      // reader will believe. An empty section must say WHY it is empty.
      pattern_hints: [] as string[],
      // Why each empty section is empty. `[]` is ambiguous between "none exist", "the
      // source failed" and "this was never built", and those demand different reactions
      // from the caller: trust it, retry it, or ignore it forever.
      empty_sections: [
        ...(relevantFacts.length === 0 ? [{
          section: 'relevant_facts',
          reason: searchResults.status === 'rejected' ? 'source_unavailable' : 'no_matches',
          detail: searchResults.status === 'rejected'
            ? 'the search call failed — this is NOT evidence that the workspace lacks matching memories'
            : 'search ran and matched nothing for this topic',
        }] : []),
        ...(recentItems.length === 0 ? [{
          section: 'recent_activity',
          reason: listRes.status === 'rejected' ? 'source_unavailable' : 'no_matches',
          detail: listRes.status === 'rejected'
            ? 'the list call failed — absence here is not evidence of an empty workspace'
            : 'list ran and returned no rows',
        }] : []),
        ...(openContradictions.length === 0 ? [{
          section: 'open_issues',
          reason: contradictionsRes.status === 'rejected' ? 'source_unavailable' : 'no_matches',
          detail: contradictionsRes.status === 'rejected'
            ? 'the contradictions call failed — unknown, not clean'
            : 'no open contradictions recorded',
        }] : []),
        {
          section: 'pattern_hints',
          reason: 'not_implemented',
          detail: 'no pattern extraction runs in this path yet; the empty array is a placeholder, not a finding. Do not read it as "no patterns exist".',
        },
        // A CONSUMER MAY NOT NARRATE A CAUSE IT CANNOT OBSERVE.
        //
        // This used to fire whenever the count was falsy and assert a mechanism: "supersession/
        // previous_memory_id edges are not being written". The client cannot see the write path,
        // and the claim was FALSE — previous_memory_id was populated on the very memories
        // returned in the same response. Every session reading this brief was told temporal
        // ordering was dead while it was live, and that claim propagated into stored reasoning.
        //
        // Now: report only what is observable — that the value was not measured — and say so
        // ONLY when the backend actually says so. A real zero is a finding, not a gap.
        ...((overview && (overview.chain_edges ?? overview.temporal_chains) == null) ? [{
          section: 'chain_edges',
          reason: 'not_measured',
          detail: 'the backend did not report a chain-edge count for this workspace, so the number of temporal links is UNKNOWN — not zero. Treat it as a missing measurement and draw no conclusion about the write path from it.',
        }] : []),
      ],
      // Phase 4: Multi-angle search metadata
      ...(multiAngle ? { search_angles_used: searchAnglesUsed } : {}),
      section_freshness: {
        relevant_facts: { source: multiAngle ? 'multi_angle_search' : 'search', fetched_at: new Date().toISOString() },
        recent_activity: { source: 'list', fetched_at: new Date().toISOString() },
        overview: overviewRes.status === 'fulfilled' ? { source: 'overview', fetched_at: new Date().toISOString() } : { source: 'overview', status: 'unavailable' },
        contradictions: contradictionsRes.status === 'fulfilled' ? { source: 'contradictions', fetched_at: new Date().toISOString() } : { source: 'contradictions', status: 'unavailable' },
      },
      justification: justify(
        overview
          ? `Workspace context synthesis from ${overview.total_memories || 0} memories`
          : `Context synthesis from ${relevantFacts.length} relevant facts`,
        'synthesized_summary',
        relevantFacts as MemoryItem[],
        config.workspaceId,
        { contradictionCount: openContradictions.length },
      ),
    };

    const partial = [searchResults, listRes, overviewRes, contradictionsRes].some(r => r.status === 'rejected');
    const contextMs = Date.now() - startMs;

    return {
      text: JSON.stringify(wrapResponse(brief, config, {
        data_absent: relevantFacts.length === 0 && recentItems.length === 0,
        partial_context: partial,
        contradictions_present: openContradictions.length > 0,
        request_ms: contextMs,
      })),
    };
  }

  if (name === 'velixar_inspect') {
    const id = args.memory_id as string;
    const raw = await api.get<unknown>(`/memory/${id}`, true);
    if (!raw || typeof raw !== 'object') throw new Error(`Memory ${id} not found`);
    const result = raw as Record<string, unknown>;
    if (result.error) throw new Error(String(result.error));
    if (!result.memory || typeof result.memory !== 'object') throw new Error(`Memory ${id} not found`);

    const rawMem = result.memory as Record<string, unknown>;
    const mem = normalizeMemory(toRawMemory(rawMem));
    mem.workspace_id = config.workspaceId;

    // H17: Validate provenance — check derived_from IDs exist
    let provenanceStatus: Array<{ id: string; status: 'exists' | 'deleted' }> | undefined;
    if (mem.provenance.derived_from?.length) {
      const checks = await Promise.allSettled(
        mem.provenance.derived_from.map(refId =>
          api.get<unknown>(`/memory/${refId}`, true),
        ),
      );
      provenanceStatus = mem.provenance.derived_from.map((refId, i) => {
        if (checks[i].status !== 'fulfilled') return { id: refId, status: 'deleted' as const };
        const val = checks[i].status === 'fulfilled' ? (checks[i] as PromiseFulfilledResult<unknown>).value : null;
        const hasMemory = val && typeof val === 'object' && 'memory' in (val as Record<string, unknown>) && (val as Record<string, unknown>).memory;
        return { id: refId, status: hasMemory ? 'exists' as const : 'deleted' as const };
      });
    }

    const justification = justify(
      `Inspection of memory ${id}`,
      'retrieved_fact',
      [mem] as MemoryItem[],
      config.workspaceId,
    );

    return { text: JSON.stringify(wrapResponse({ memory: mem, justification, ...(provenanceStatus ? { provenance_validation: provenanceStatus } : {}) }, config)) };
  }

  throw new Error(`Unknown recall tool: ${name}`);
}
