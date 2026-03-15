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

      return {
        text: JSON.stringify(wrapResponse(result, config, {
          data_absent: !result || Object.keys(result).length === 0,
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
