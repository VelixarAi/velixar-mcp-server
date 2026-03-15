// ── Graph Tools ──
// velixar_graph_traverse — walk entity relationships

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ApiClient } from '../api.js';
import { wrapResponse } from '../api.js';
import type { ApiConfig } from '../types.js';

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
    try {
      const result = await api.post<Record<string, unknown>>('/graph/traverse', {
        entity: args.entity,
        max_hops: Math.min((args.depth as number) || 2, 10),
      });
      if ((result as any).error) throw new Error((result as any).error);

      // Normalize to GraphEntity schema
      const nodes = ((result as any).nodes || []).map((n: any) => ({
        id: n.id || n.address || n.name,
        entity_type: n.type || n.entity_type || 'unknown',
        label: n.name || n.label || n.id,
        properties: { description: n.description, salience: n.salience },
        relevance: n.salience ?? n.relevance,
        confidence: n.confidence,
      }));
      const relations = ((result as any).edges || []).map((e: any) => ({
        source: e.source,
        target: e.target,
        relationship: e.relationship || e.type || 'related',
        direction: 'outbound' as const,
        relevance: e.weight ?? e.relevance,
        confidence: e.confidence,
      }));
      const root = nodes[0] || { id: args.entity, entity_type: 'unknown', label: args.entity as string };

      return {
        text: JSON.stringify(wrapResponse({
          root,
          relations,
          connected_entities: nodes.slice(1),
          depth_reached: (result as any).hops ?? 0,
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
