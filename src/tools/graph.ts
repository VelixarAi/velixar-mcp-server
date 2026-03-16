// ── Graph Tools ──
// velixar_graph_traverse — walk entity relationships

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ApiClient } from '../api.js';
import { wrapResponse } from '../api.js';
import type { ApiConfig } from '../types.js';
import { validateGraphResponse } from '../validate.js';

// M13: Graph traverse usage telemetry
let _graphTraverseCount = 0;
let _graphTraverseNoEntity = 0;
export function getGraphTelemetry() {
  return { total_calls: _graphTraverseCount, no_entity_calls: _graphTraverseNoEntity, listing_pct: _graphTraverseCount > 0 ? Math.round((_graphTraverseNoEntity / _graphTraverseCount) * 100) : 0 };
}

export const graphTools: Tool[] = [
  {
    name: 'velixar_graph_traverse',
    description:
      'Walk relationships from an entity — "what connects to X?" ' +
      'Use when the question is about relationships, dependencies, or connections from a known focal entity. ' +
      'Prefer after velixar_context has identified a focal entity. ' +
      'Do NOT use for broad topic briefing with no focal entity (use velixar_context). ' +
      'Do NOT use for content search (use velixar_search).',
    inputSchema: {
      type: 'object',
      properties: {
        entity: { type: 'string', description: 'Entity name to traverse from' },
        depth: { type: 'number', description: 'Max traversal depth / hops (default 2, max 10)' },
      },
      required: ['entity'],
    },
  },
];

export async function handleGraphTool(
  name: string,
  args: Record<string, unknown>,
  api: ApiClient,
  config: ApiConfig,
): Promise<{ text: string; isError?: boolean }> {
  if (name === 'velixar_graph_traverse') {
    // M13: Usage telemetry — track query patterns
    _graphTraverseCount++;
    if (!args.entity) _graphTraverseNoEntity++;

    try {
      const raw = await api.post<unknown>('/graph/traverse', {
        entity: args.entity,
        max_hops: Math.min((args.depth as number) || 2, 10),
      });
      const result = validateGraphResponse(raw, '/graph/traverse');

      const nodes = result.nodes.map(n => ({
        id: n.id,
        entity_type: n.entity_type || 'unknown',
        label: n.label,
        properties: n.properties,
        relevance: n.relevance,
      }));
      const relations = result.edges.map(e => ({
        source: e.source,
        target: e.target,
        relationship: e.relationship || 'related',
        direction: 'outbound' as const,
        relevance: e.relevance,
      }));
      const root = nodes[0] || { id: args.entity, entity_type: 'unknown', label: args.entity as string };

      // H12: Cross-memory relationship inference — find memories mentioning connected entities
      // that might reveal implicit relationships not captured by per-memory extraction
      let implicitConnections: Array<{ entity: string; memory_count: number }> = [];
      if (nodes.length > 1) {
        const entityLabels = nodes.slice(1, 4).map(n => n.label); // check top 3 connected
        try {
          const crossSearch = await Promise.allSettled(
            entityLabels.map(label => {
              const p = new URLSearchParams({ q: `${args.entity} ${label}`, limit: '3' });
              return api.get<{ memories?: Array<Record<string, unknown>> }>(`/memory/search?${p}`, true);
            }),
          );
          implicitConnections = crossSearch
            .map((r, i) => ({
              entity: entityLabels[i],
              memory_count: r.status === 'fulfilled' ? (r.value.memories || []).length : 0,
            }))
            .filter(c => c.memory_count > 0);
        } catch { /* non-blocking */ }
      }

      return {
        text: JSON.stringify(wrapResponse({
          root,
          relations,
          connected_entities: nodes.slice(1),
          depth_reached: result.hops ?? 0,
          // H12: Implicit connections found via cross-memory search
          ...(implicitConnections.length ? { implicit_connections: implicitConnections } : {}),
        }, config, {
          data_absent: nodes.length === 0,
        })),
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('404') || msg.includes('not found')) {
        return {
          text: JSON.stringify(wrapResponse(
            { nodes: [], edges: [], hops: 0, entity: args.entity, message: 'Entity not found in knowledge graph' },
            config,
            { data_absent: true },
          )),
        };
      }
      throw e;
    }
  }

  throw new Error(`Unknown graph tool: ${name}`);
}
