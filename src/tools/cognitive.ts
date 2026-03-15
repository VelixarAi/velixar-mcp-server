// ── Cognitive Tools ──
// velixar_identity, velixar_contradictions, velixar_timeline, velixar_patterns

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ApiClient } from '../api.js';
import { normalizeMemory, wrapResponse } from '../api.js';
import type { ApiConfig, MemoryItem } from '../types.js';
import { justify } from '../justify.js';

export const cognitiveTools: Tool[] = [
  {
    name: 'velixar_identity',
    description:
      'User profile — preferences, expertise, communication style, recurring goals, stable constraints. ' +
      'Use when you need to understand who the user is, personalize responses, or check stable preferences. ' +
      'Do NOT use for project facts (use velixar_search). Do NOT use for broad orientation (use velixar_context). ' +
      'Identity is workspace-scoped — each project can have different user context.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'velixar_contradictions',
    description:
      'Surface conflicting beliefs, preferences, or facts in the workspace. ' +
      'Use when conflict is suspected or surfaced by another tool. Not a first move for ordinary recall. ' +
      'Do NOT use for general search (use velixar_search). ' +
      'Returns pairs of contradicting statements with severity and linked memory IDs.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['open', 'resolved', 'all'], description: 'Filter by status (default: open)' },
      },
    },
  },
  {
    name: 'velixar_timeline',
    description:
      'Show how a topic, entity, or belief evolved over time. ' +
      'Use when sequence or historical change matters — "how did X evolve?" ' +
      'Do NOT use for broad context with no temporal question (use velixar_context). ' +
      'Operates primarily on episodic memories following temporal chains.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'Topic or entity to trace' },
        memory_id: { type: 'string', description: 'Starting memory ID (alternative to topic)' },
        limit: { type: 'number', description: 'Max entries (default 10)' },
      },
    },
  },
  {
    name: 'velixar_patterns',
    description:
      'Surface recurring problem/solution motifs from memory. ' +
      'Use when the current problem may match prior patterns. Not for first-pass orientation (use velixar_context). ' +
      'Patterns are always inferred and require repeated support — confidence reflects observation count.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'Topic to find patterns for' },
        limit: { type: 'number', description: 'Max results (default 5)' },
      },
      required: ['topic'],
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
    const result = await api.get<Record<string, unknown>>('/memory/identity', true);
    const identity = (result as any).identity || {};
    const profile = {
      preferences: identity.preferences || {},
      expertise: identity.expertise || [],
      communication_style: identity.communication_style,
      recurring_goals: identity.recurring_goals || [],
      stable_constraints: identity.stable_constraints || [],
      shifts: ((result as any).shifts || []).map((s: any) => ({
        field: s.field || s.key,
        from: s.from || s.old_value,
        to: s.to || s.new_value,
        timestamp: s.timestamp || s.detected_at,
      })),
      contradictions: ((result as any).contradictions || []).map((c: any) => ({
        existing: c.existing || c.old,
        new: c.new || c.current,
        severity: c.severity,
      })),
      snapshot_count: (result as any).snapshot_count || 0,
      justification: justify(
        'User identity profile synthesized from stored preferences and behavioral patterns',
        Object.keys(identity).length > 0 ? 'synthesized_summary' : 'hypothesis',
        [],  // identity endpoint doesn't return raw memories
        config.workspaceId,
        { contradictionCount: ((result as any).contradictions || []).length },
      ),
    };

    return {
      text: JSON.stringify(wrapResponse(profile, config, {
        data_absent: Object.keys(identity).length === 0,
      })),
    };
  }

  if (name === 'velixar_contradictions') {
    const status = (args.status as string) || 'open';
    const result = await api.get<{ contradictions?: Array<Record<string, unknown>> }>(
      `/exocortex/contradictions?status=${status}`,
      true,
    );

    const items = (result.contradictions || []).map((c: any) => ({
      id: c.id,
      statement_a: c.statement_a || c.memory_a_content || '',
      statement_b: c.statement_b || c.memory_b_content || '',
      memory_id_a: c.memory_a_id,
      memory_id_b: c.memory_b_id,
      severity: c.severity || 'medium',
      confidence: c.confidence ?? 0.5,
      explanation: c.explanation || c.description,
      workspace_id: config.workspaceId,
      detected_at: c.detected_at || c.created_at || '',
    }));

    return {
      text: JSON.stringify(wrapResponse(
        {
          contradictions: items,
          count: items.length,
          justification: justify(
            `${items.length} contradiction${items.length !== 1 ? 's' : ''} detected in workspace`,
            items.length > 0 ? 'retrieved_fact' : 'synthesized_summary',
            [],
            config.workspaceId,
            { contradictionCount: items.length },
          ),
        },
        config,
        { data_absent: items.length === 0, contradictions_present: items.length > 0 },
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
      const params = new URLSearchParams({ q: topic, user_id: config.userId, limit: String(limit) });
      const result = await api.get<{ memories?: Array<Record<string, unknown>> }>(`/memory/search?${params}`, true);

      const entries = (result.memories || [])
        .map(m => {
          const mem = normalizeMemory(m as any);
          mem.workspace_id = config.workspaceId;
          return {
            id: mem.id,
            content: mem.content,
            summary: mem.content.slice(0, 120),
            timestamp: mem.provenance.created_at,
            memory_type: mem.memory_type,
            chain_position: 0,
            tags: mem.tags,
            previous_memory_id: (m as any).previous_memory_id || null,
          };
        })
        .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

      return {
        text: JSON.stringify(wrapResponse(
          { entries, count: entries.length },
          config,
          { data_absent: entries.length === 0 },
        )),
      };
    }

    // Start from a specific memory and follow chain links
    const mem = await api.get<{ memory?: Record<string, unknown> }>(`/memory/${memoryId}`, true);
    if (!mem.memory) throw new Error(`Memory ${memoryId} not found`);

    const normalized = normalizeMemory(mem.memory as any);
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
    const params = new URLSearchParams({ q: args.topic as string });
    if (args.limit) params.set('limit', String(args.limit));
    const result = await api.get<{ patterns?: Array<Record<string, unknown>> }>(
      `/patterns/suggest?${params}`,
      true,
    );

    const patterns = (result.patterns || []).map((p: any) => ({
      name: p.name || p.id,
      problem_signature: p.problem || p.context || '',
      prior_solution: p.solution || '',
      confidence: p.confidence ?? 0.5,
      supporting_memories: p.supporting_memories || [],
      occurrence_count: p.occurrence_count || p.frequency || 0,
    }));

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
