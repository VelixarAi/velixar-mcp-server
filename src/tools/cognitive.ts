// ── Cognitive Tools ──
// velixar_identity, velixar_contradictions, velixar_timeline, velixar_patterns

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ApiClient } from '../api.js';
import { normalizeMemory, wrapResponse } from '../api.js';
import type { ApiConfig, MemoryItem } from '../types.js';
import { justify } from '../justify.js';
import { validateIdentityResponse, validateSearchResponse } from '../validate.js';

// H10/H11: Track identity freshness
let _lastIdentityUpdate = 0;
let _toolCallsSinceIdentityUpdate = 0;
const IDENTITY_STALE_CALLS = 20; // suggest refresh after this many tool calls

export function trackToolCallForIdentity(): void { _toolCallsSinceIdentityUpdate++; }

export const cognitiveTools: Tool[] = [
  {
    name: 'velixar_identity',
    description:
      'User profile — preferences, expertise, communication style, recurring goals, stable constraints. ' +
      'Supports get (default), store, update, delete, list, and history actions. Workspace-scoped.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get', 'store', 'update', 'delete', 'list', 'history'], description: 'Action (default: get)' },
        field: { type: 'string', description: 'Identity field to store/update/delete/history (e.g. "expertise", "communication_style")' },
        value: { description: 'Value to store/update (string or array of strings)' },
      },
    },
  },
  {
    name: 'velixar_contradictions',
    description:
      'Surface conflicting beliefs, preferences, or facts. Supports resolve action to mark contradictions as resolved. ' +
      'Returns pairs of contradicting statements with severity and linked memory IDs.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['open', 'resolved', 'all'], description: 'Filter by status (default: open)' },
        topic: { type: 'string', description: 'Filter contradictions by topic (semantic relevance)' },
        severity_min: { type: 'number', description: 'Minimum severity threshold (0-1)' },
        action: { type: 'string', enum: ['list', 'resolve'], description: 'Action (default: list)' },
        contradiction_id: { type: 'string', description: 'Contradiction ID to resolve (required for resolve action)' },
        resolution: { type: 'string', description: 'Resolution note (required for resolve action)' },
      },
    },
  },
  {
    name: 'velixar_timeline',
    description:
      'Show how a topic, entity, or belief evolved over time. ' +
      'Supports date range filtering and summary mode for long histories.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'Topic or entity to trace' },
        memory_id: { type: 'string', description: 'Starting memory ID (alternative to topic)' },
        limit: { type: 'number', description: 'Max entries (default 10)' },
        before: { type: 'string', description: 'ISO timestamp — only return entries before this time' },
        after: { type: 'string', description: 'ISO timestamp — only return entries after this time' },
      },
    },
  },
  {
    name: 'velixar_patterns',
    description:
      'Surface recurring problem/solution motifs from memory. ' +
      'Omit topic to return all detected patterns. Supports dismiss action.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'Topic to find patterns for (optional — omit for all patterns)' },
        limit: { type: 'number', description: 'Max results (default 5)' },
        min_confidence: { type: 'number', description: 'Minimum confidence threshold (0-1)' },
        evidence: { type: 'boolean', description: 'Include supporting memory IDs (default false)' },
        action: { type: 'string', enum: ['list', 'dismiss'], description: 'Action (default: list)' },
        pattern_id: { type: 'string', description: 'Pattern ID to dismiss (required for dismiss action)' },
      },
    },
  },
];

export async function handleCognitiveTool(
  name: string,
  args: Record<string, unknown>,
  api: ApiClient,
  config: ApiConfig,
): Promise<{ text: string; isError?: boolean }> {
  if (name === 'velixar_identity') {
    const action = (args.action as string) || 'get';

    // Build 4.1: delete — remove an identity field
    if (action === 'delete') {
      const field = args.field as string;
      if (!field) throw new Error('field required for delete');
      // Search for identity memories with this field tag, then delete them
      const params = new URLSearchParams({ q: `[identity:${field}]`, user_id: config.userId, limit: '10' });
      const raw = await api.get<unknown>(`/memory/search?${params}`, true);
      const validated = validateSearchResponse(raw, '/memory/search');
      const toDelete = validated.memories.filter(m =>
        m.tags?.includes(`identity:${field}`),
      );
      for (const m of toDelete) {
        await api.delete(`/memory/${m.id}`).catch(() => {});
      }
      return {
        text: JSON.stringify(wrapResponse(
          { action: 'delete', field, deleted_count: toDelete.length, message: `Identity field "${field}" deleted (${toDelete.length} memories removed)` },
          config,
        )),
      };
    }

    // Build 4.1: list — return all stored identity field names
    if (action === 'list') {
      const params = new URLSearchParams({ q: '[identity:', user_id: config.userId, limit: '50' });
      const raw = await api.get<unknown>(`/memory/search?${params}`, true);
      const validated = validateSearchResponse(raw, '/memory/search');
      const fields = new Set<string>();
      for (const m of validated.memories) {
        for (const tag of (m.tags || [])) {
          if (tag.startsWith('identity:')) fields.add(tag.slice(9));
        }
      }
      return {
        text: JSON.stringify(wrapResponse(
          { action: 'list', fields: [...fields], count: fields.size },
          config,
          { data_absent: fields.size === 0 },
        )),
      };
    }

    // Build 4.1: history — return evolution of a specific field over time
    if (action === 'history') {
      const field = args.field as string;
      if (!field) throw new Error('field required for history');
      const params = new URLSearchParams({ q: `[identity:${field}]`, user_id: config.userId, limit: '20' });
      const raw = await api.get<unknown>(`/memory/search?${params}`, true);
      const validated = validateSearchResponse(raw, '/memory/search');
      const history = validated.memories
        .filter(m => m.tags?.includes(`identity:${field}`))
        .map(m => ({
          id: m.id,
          value: m.content.replace(`[identity:${field}] `, ''),
          timestamp: m.created_at || '',
        }))
        .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      return {
        text: JSON.stringify(wrapResponse(
          { action: 'history', field, entries: history, count: history.length },
          config,
          { data_absent: history.length === 0 },
        )),
      };
    }

    // Store or update: persist identity facet as a tagged memory
    if (action === 'store' || action === 'update') {
      const field = args.field as string;
      const value = args.value;
      if (!field || value === undefined) throw new Error('field and value required for store/update');

      // Store as semantic memory tagged with identity field
      const content = `[identity:${field}] ${typeof value === 'string' ? value : JSON.stringify(value)}`;
      await api.post('/memory', {
        content,
        user_id: config.userId,
        tier: 0, // pinned — identity is durable
        tags: ['identity', `identity:${field}`],
        author: { type: 'user' },
      });

      // H10: Track identity update
      _lastIdentityUpdate = Date.now();
      _toolCallsSinceIdentityUpdate = 0;

      return {
        text: JSON.stringify(wrapResponse(
          { action, field, value, message: `Identity field "${field}" ${action}d` },
          config,
        )),
      };
    }

    // Get: fetch synthesized identity profile
    const raw = await api.get<unknown>('/memory/identity', true);
    const result = validateIdentityResponse(raw, '/memory/identity');
    const identity = result.identity || {};
    const profile = {
      preferences: (identity as Record<string, unknown>).preferences || {},
      expertise: (identity as Record<string, unknown>).expertise || [],
      communication_style: (identity as Record<string, unknown>).communication_style,
      recurring_goals: (identity as Record<string, unknown>).recurring_goals || [],
      stable_constraints: (identity as Record<string, unknown>).stable_constraints || [],
      shifts: (result.shifts || []).map(s => ({
        field: s.field,
        from: s.from,
        to: s.to,
        timestamp: s.timestamp,
      })),
      contradictions: (result.contradictions || []).map(c => ({
        existing: c.existing,
        new: c.new,
        severity: c.severity,
      })),
      snapshot_count: result.snapshot_count || 0,
      workspace_scope: 'workspace_local',
      // H10: Identity staleness detection
      stale_identity: _lastIdentityUpdate > 0 && _toolCallsSinceIdentityUpdate > IDENTITY_STALE_CALLS,
      // H11: Refresh hint
      ...(_toolCallsSinceIdentityUpdate > IDENTITY_STALE_CALLS
        ? { refresh_hint: 'Identity has not been updated recently. Consider storing new preferences or expertise if they have changed.' }
        : {}),
      justification: justify(
        'User identity profile synthesized from stored preferences and behavioral patterns',
        Object.keys(identity).length > 0 ? 'synthesized_summary' : 'hypothesis',
        [],
        config.workspaceId,
        { contradictionCount: (result.contradictions || []).length },
      ),
    };

    return {
      text: JSON.stringify(wrapResponse(profile, config, {
        data_absent: Object.keys(identity).length === 0,
      })),
    };
  }

  if (name === 'velixar_contradictions') {
    const action = (args.action as string) || 'list';

    // Build 4.2: resolve action
    if (action === 'resolve') {
      const contradictionId = args.contradiction_id as string;
      const resolution = args.resolution as string;
      if (!contradictionId || !resolution) throw new Error('contradiction_id and resolution required for resolve action');

      try {
        await api.post(`/exocortex/contradictions/${contradictionId}`, {
          resolution,
          status: 'resolved',
        });
        return {
          text: JSON.stringify(wrapResponse(
            { action: 'resolve', contradiction_id: contradictionId, resolution, message: 'Contradiction resolved' },
            config,
          )),
        };
      } catch {
        // Fallback: store resolution as a memory linking the contradiction
        await api.post('/memory', {
          content: `[contradiction-resolved:${contradictionId}] ${resolution}`,
          user_id: config.userId,
          tags: ['contradiction-resolution', `contradiction:${contradictionId}`],
          author: { type: 'user' },
        });
        return {
          text: JSON.stringify(wrapResponse(
            { action: 'resolve', contradiction_id: contradictionId, resolution, message: 'Resolution stored as memory (backend resolve endpoint unavailable)', _fallback: true },
            config,
          )),
        };
      }
    }

    const status = (args.status as string) || 'open';
    const raw = await api.get<unknown>(
      `/exocortex/contradictions?status=${status}`,
      true,
    );
    const rObj = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {};
    const rawContradictions = Array.isArray(rObj.contradictions) ? rObj.contradictions : [];

    // Temporal supersession threshold: if two conflicting memories are >7 days apart,
    // classify as "superseded" (temporal update) rather than "contradiction"
    const SUPERSESSION_DAYS = 7;

    const items = rawContradictions.map((c: Record<string, unknown>) => {
      const detectedA = String(c.memory_a_created_at || c.created_at_a || '');
      const detectedB = String(c.memory_b_created_at || c.created_at_b || '');
      let classification: 'contradiction' | 'superseded' = 'contradiction';

      if (detectedA && detectedB) {
        const timeA = new Date(detectedA).getTime();
        const timeB = new Date(detectedB).getTime();
        if (!isNaN(timeA) && !isNaN(timeB)) {
          const daysDiff = Math.abs(timeB - timeA) / (1000 * 60 * 60 * 24);
          if (daysDiff > SUPERSESSION_DAYS) classification = 'superseded';
        }
      }

      return {
        id: String(c.id || ''),
        statement_a: String(c.statement_a || c.memory_a_content || ''),
        statement_b: String(c.statement_b || c.memory_b_content || ''),
        memory_id_a: String(c.memory_a_id || ''),
        memory_id_b: String(c.memory_b_id || ''),
        severity: String(c.severity || 'medium'),
        confidence: typeof c.confidence === 'number' ? c.confidence : 0.5,
        explanation: String(c.explanation || c.description || ''),
        workspace_id: config.workspaceId,
        detected_at: String(c.detected_at || c.created_at || ''),
        classification,
      };
    });

    const activeContradictions = items.filter(i => i.classification === 'contradiction');
    const superseded = items.filter(i => i.classification === 'superseded');

    // Phase 0 filters: topic and severity
    let filtered = activeContradictions;
    if (args.topic) {
      const topicLower = (args.topic as string).toLowerCase();
      filtered = filtered.filter(i =>
        i.statement_a.toLowerCase().includes(topicLower) ||
        i.statement_b.toLowerCase().includes(topicLower) ||
        i.explanation.toLowerCase().includes(topicLower),
      );
    }
    if (args.severity_min !== undefined) {
      const severityMap: Record<string, number> = { low: 0.25, medium: 0.5, high: 0.75, critical: 1.0 };
      const minSev = args.severity_min as number;
      filtered = filtered.filter(i => (severityMap[i.severity] ?? i.confidence) >= minSev);
    }

    return {
      text: JSON.stringify(wrapResponse(
        {
          conflict_summary: `${filtered.length} active contradiction${filtered.length !== 1 ? 's' : ''}, ${superseded.length} superseded (temporal updates)`,
          evidence: filtered,
          superseded,
          likely_interpretation: filtered.length > 0
            ? `${filtered.filter(i => i.severity === 'high').length} high-severity conflicts require attention`
            : 'No active contradictions — beliefs are consistent',
          next_step: filtered.length > 0
            ? 'Use velixar_inspect on linked memory IDs to understand each side, then velixar_timeline to trace belief evolution'
            : null,
          count: filtered.length,
          superseded_count: superseded.length,
          justification: justify(
            `${filtered.length} contradiction${filtered.length !== 1 ? 's' : ''} detected, ${superseded.length} classified as temporal supersession`,
            filtered.length > 0 ? 'retrieved_fact' : 'synthesized_summary',
            [],
            config.workspaceId,
            { contradictionCount: filtered.length },
          ),
        },
        config,
        { data_absent: items.length === 0, contradictions_present: filtered.length > 0 },
      )),
    };
  }

  if (name === 'velixar_timeline') {
    const topic = args.topic as string;
    const memoryId = args.memory_id as string;
    const limit = Math.min((args.limit as number) || 10, 50);

    if (!topic && !memoryId) throw new Error('Either topic or memory_id required');

    // Use search to find temporally-related memories, sorted by time
    if (topic) {
      // H14: Synonym expansion — query graph for entity aliases to broaden search
      let expandedTerms: string[] = [topic];
      try {
        const graphResult = await api.post<unknown>('/graph/traverse', { entity: topic, max_hops: 1 });
        const gObj = (graphResult && typeof graphResult === 'object') ? graphResult as Record<string, unknown> : {};
        const gNodes = Array.isArray(gObj.nodes) ? gObj.nodes : [];
        if (gNodes.length) {
          const aliases = gNodes
            .filter((n: any) => String(n.relationship || '').match(/alias|also_known_as|synonym/i))
            .map((n: any) => String(n.label || ''))
            .filter(Boolean);
          if (aliases.length) expandedTerms.push(...aliases.slice(0, 3));
        }
      } catch { /* graph unavailable — proceed with original term */ }

      // H13: Search with expanded terms for better recall
      const searchQuery = expandedTerms.join(' OR ');
      const params = new URLSearchParams({ q: searchQuery, user_id: config.userId, limit: String(limit) });
      const raw = await api.get<unknown>(`/memory/search?${params}`, true);

      // H13: Also fetch graph relationships for the entity
      let relatedEntities: Array<{ label: string; relationship: string }> = [];
      try {
        const graphResult = await api.post<unknown>('/graph/traverse', { entity: topic, max_hops: 1 });
        const gObj = (graphResult && typeof graphResult === 'object') ? graphResult as Record<string, unknown> : {};
        const gEdges = Array.isArray(gObj.edges) ? gObj.edges : [];
        relatedEntities = gEdges.map((e: any) => ({
          label: String(e.target || ''),
          relationship: String(e.relationship || 'related'),
        })).slice(0, 10);
      } catch { /* graph unavailable */ }
      const result = validateSearchResponse(raw, '/memory/search');

      const entries = result.memories
        .map(m => {
          const mem = normalizeMemory(m);
          mem.workspace_id = config.workspaceId;
          return {
            id: mem.id,
            content: mem.content,
            summary: mem.content.slice(0, 120),
            timestamp: mem.provenance.created_at,
            memory_type: mem.memory_type,
            chain_position: 0,
            tags: mem.tags,
            previous_memory_id: m.previous_memory_id || null,
          };
        })
        // Prefer episodic memories (event-specific), then sort by time
        .sort((a, b) => {
          if (a.memory_type === 'episodic' && b.memory_type !== 'episodic') return -1;
          if (a.memory_type !== 'episodic' && b.memory_type === 'episodic') return 1;
          return a.timestamp.localeCompare(b.timestamp);
        });

      // Timeline output form per strategy memo
      const changePoints = entries.filter((e, i) =>
        i > 0 && e.tags.some(t => entries[i - 1].tags.indexOf(t) === -1),
      );

      return {
        text: JSON.stringify(wrapResponse(
          {
            phases: entries,
            key_change_points: changePoints.map(e => ({ id: e.id, summary: e.summary, timestamp: e.timestamp })),
            current_state: entries.length > 0 ? entries[entries.length - 1].summary : null,
            uncertainty: entries.length < 3 ? 'Limited data — timeline may be incomplete' : null,
            count: entries.length,
            // H13: Related entities from knowledge graph
            ...(relatedEntities.length ? { related_entities: relatedEntities } : {}),
            // H14: Search terms used (including synonyms)
            ...(expandedTerms.length > 1 ? { search_expanded: expandedTerms } : {}),
          },
          config,
          { data_absent: entries.length === 0 },
        )),
      };
    }

    // Start from a specific memory and follow chain links
    const memResult = await api.get<unknown>(`/memory/${memoryId}`, true);
    if (!memResult || typeof memResult !== 'object' || !(memResult as Record<string, unknown>).memory) throw new Error(`Memory ${memoryId} not found`);
    const rawMem = (memResult as Record<string, unknown>).memory as Record<string, unknown>;

    const normalized = normalizeMemory({
      id: String(rawMem.id || ''),
      content: String(rawMem.content || ''),
      score: typeof rawMem.score === 'number' ? rawMem.score : undefined,
      tier: typeof rawMem.tier === 'number' ? rawMem.tier : undefined,
      type: typeof rawMem.type === 'string' ? rawMem.type : null,
      tags: Array.isArray(rawMem.tags) ? rawMem.tags.filter((t): t is string => typeof t === 'string') : [],
      salience: typeof rawMem.salience === 'number' ? rawMem.salience : undefined,
      created_at: typeof rawMem.created_at === 'string' ? rawMem.created_at : undefined,
      updated_at: typeof rawMem.updated_at === 'string' ? rawMem.updated_at : undefined,
      previous_memory_id: typeof rawMem.previous_memory_id === 'string' ? rawMem.previous_memory_id : null,
    });
    normalized.workspace_id = config.workspaceId;

    return {
      text: JSON.stringify(wrapResponse({
        entries: [{
          id: normalized.id,
          content: normalized.content,
          summary: normalized.content.slice(0, 120),
          timestamp: normalized.provenance.created_at,
          memory_type: normalized.memory_type,
          chain_position: 0,
          tags: normalized.tags,
        }],
        count: 1,
      }, config)),
    };
  }

  if (name === 'velixar_patterns') {
    const action = (args.action as string) || 'list';

    // Build 4.3: dismiss action
    if (action === 'dismiss') {
      const patternId = args.pattern_id as string;
      if (!patternId) throw new Error('pattern_id required for dismiss action');
      try {
        await api.post('/patterns/dismiss', { pattern_id: patternId });
      } catch {
        // Fallback: store dismissal as memory
        await api.post('/memory', {
          content: `[pattern-dismissed:${patternId}]`,
          user_id: config.userId,
          tags: ['pattern-dismissed', `pattern:${patternId}`],
          author: { type: 'user' },
        });
      }
      return {
        text: JSON.stringify(wrapResponse(
          { action: 'dismiss', pattern_id: patternId, message: 'Pattern dismissed' },
          config,
        )),
      };
    }

    const includeEvidence = args.evidence === true;
    const params = new URLSearchParams({ q: args.topic as string });
    if (args.limit) params.set('limit', String(args.limit));
    const raw = await api.get<unknown>(
      `/patterns/suggest?${params}`,
      true,
    );
    const rObj = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {};
    const rawPatterns = Array.isArray(rObj.patterns) ? rObj.patterns : [];

    const patterns = rawPatterns.map((p: any) => {
      const occurrences = p.occurrence_count || p.frequency || 0;
      const memoryIds: string[] = p.supporting_memories || [];
      const rawConfidence = p.confidence ?? 0.5;

      // H18: Confidence decay — fewer supporting memories or old patterns get reduced confidence
      let adjustedConfidence = rawConfidence;
      if (occurrences < 3) adjustedConfidence *= 0.7; // weak support
      if (occurrences < 2) adjustedConfidence *= 0.5; // very weak

      // H19: Causal indicator — check if supporting memories have temporal ordering
      const patternType: 'temporal' | 'co-occurrence' = (p.temporal_order || p.ordered) ? 'temporal' : 'co-occurrence';

      return {
        name: p.name || p.id,
        problem_signature: p.problem || p.context || '',
        prior_solution: p.solution || '',
        confidence: Math.round(adjustedConfidence * 100) / 100,
        confidence_raw: rawConfidence,
        // Build 4.3: conditionally include evidence
        ...(includeEvidence ? { supporting_memories: memoryIds } : {}),
        occurrence_count: occurrences,
        pattern_type: patternType, // H19
        ...(adjustedConfidence < rawConfidence ? { confidence_decay_reason: `Only ${occurrences} supporting observation${occurrences !== 1 ? 's' : ''}` } : {}),
      };
    });

    return {
      text: JSON.stringify(wrapResponse(
        {
          patterns,
          count: patterns.length,
          justification: justify(
            `${patterns.length} recurring pattern${patterns.length !== 1 ? 's' : ''} identified`,
            patterns.length > 0 ? 'pattern_inference' : 'hypothesis',
            [],
            config.workspaceId,
          ),
        },
        config,
        { data_absent: patterns.length === 0 },
      )),
    };
  }

  throw new Error(`Unknown cognitive tool: ${name}`);
}
