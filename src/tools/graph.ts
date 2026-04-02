// ── Graph Tools ──
// velixar_graph_traverse, velixar_graph_search, velixar_graph_stats
// Phase 3: KG expansion — search, stats, filtered traversal.
// All responses pass through graph_sanitizer.ts (H4.6).

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ApiClient } from '../api.js';
import { wrapResponse } from '../api.js';
import type { ApiConfig } from '../types.js';
import { validateGraphResponse } from '../validate.js';
import { sanitizeGraph, type SanitizeMode } from './graph_sanitizer.js';

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
      'Supports fuzzy entity matching, relationship and entity type filtering.',
    inputSchema: {
      type: 'object',
      properties: {
        entity: { type: 'string', description: 'Entity name to traverse from' },
        depth: { type: 'number', description: 'Max traversal depth / hops (default 2, max 10)' },
        relationship_type: { type: 'string', description: 'Filter edges by relationship type' },
        entity_type: { type: 'string', description: 'Filter target nodes by entity type' },
      },
      required: ['entity'],
    },
  },
  {
    name: 'velixar_graph_search',
    description:
      'Fuzzy entity search by name or type. Use to find entities without knowing exact names.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Entity name to search for (fuzzy)' },
        entity_type: { type: 'string', description: 'Filter by entity type' },
        limit: { type: 'number', description: 'Max results (default 10)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'velixar_graph_stats',
    description:
      'KG overview — entity count, relationship count, top entity types. Workspace-scoped.',
    inputSchema: {
      type: 'object',
      properties: {},
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
    _graphTraverseCount++;
    if (!args.entity) _graphTraverseNoEntity++;

    const relationshipType = args.relationship_type as string | undefined;
    const entityType = args.entity_type as string | undefined;

    try {
      const raw = await api.post<unknown>('/graph/traverse', {
        entity: args.entity,
        max_hops: Math.min((args.depth as number) || 2, 10),
      });
      const result = validateGraphResponse(raw, '/graph/traverse');

      // H4.6: Sanitize through graph_sanitizer
      const sanitized = sanitizeGraph(
        result.nodes.map(n => n as unknown as Record<string, unknown>),
        result.edges.map(e => e as unknown as Record<string, unknown>),
      );

      // Build 3.3: Apply relationship_type and entity_type filters
      let filteredEdges = sanitized.edges;
      if (relationshipType) {
        filteredEdges = filteredEdges.filter(e => e.relationship === relationshipType);
      }

      let filteredNodes = sanitized.nodes;
      if (entityType) {
        const root = filteredNodes[0];
        filteredNodes = filteredNodes.filter((n, i) => i === 0 || n.entity_type === entityType);
      }

      // If filtering edges, also filter nodes to only connected ones
      if (relationshipType) {
        const connectedIds = new Set<string>();
        connectedIds.add(String(args.entity));
        for (const e of filteredEdges) { connectedIds.add(e.source); connectedIds.add(e.target); }
        filteredNodes = filteredNodes.filter(n => connectedIds.has(n.id) || connectedIds.has(n.label));
      }

      const root = filteredNodes[0] || { id: args.entity, entity_type: 'unknown', label: args.entity as string };

      // H12: Cross-memory relationship inference
      let implicitConnections: Array<{ entity: string; memory_count: number }> = [];
      if (filteredNodes.length > 1) {
        const entityLabels = filteredNodes.slice(1, 4).map(n => n.label);
        try {
          const crossSearch = await Promise.allSettled(
            entityLabels.map(label => {
              const p = new URLSearchParams({ q: `${args.entity} ${label}`, limit: '3' });
              return api.get<unknown>(`/memory/search?${p}`, true);
            }),
          );
          implicitConnections = crossSearch
            .map((r, i) => {
              if (r.status !== 'fulfilled') return { entity: entityLabels[i], memory_count: 0 };
              const rObj = (r.value && typeof r.value === 'object') ? r.value as Record<string, unknown> : {};
              const mems = Array.isArray(rObj.memories) ? rObj.memories : [];
              return { entity: entityLabels[i], memory_count: mems.length };
            })
            .filter(c => c.memory_count > 0);
        } catch { /* non-blocking */ }
      }

      return {
        text: JSON.stringify(wrapResponse({
          root,
          relations: filteredEdges,
          connected_entities: filteredNodes.slice(1),
          depth_reached: result.hops ?? 0,
          ...(relationshipType ? { relationship_filter: relationshipType } : {}),
          ...(entityType ? { entity_type_filter: entityType } : {}),
          ...(implicitConnections.length ? { implicit_connections: implicitConnections } : {}),
        }, config, {
          data_absent: filteredNodes.length === 0,
        })),
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('404') || msg.includes('not found')) {
        // Build 3.3: Fuzzy entity matching — search for closest match
        try {
          const fuzzyRaw = await api.post<unknown>('/graph/search', {
            query: args.entity, limit: 1,
          });
          const fObj = (fuzzyRaw && typeof fuzzyRaw === 'object') ? fuzzyRaw as Record<string, unknown> : {};
          const fEntities = Array.isArray(fObj.entities) ? fObj.entities : [];
          if (fEntities.length > 0) {
            const match = fEntities[0] as Record<string, unknown>;
            const matchName = String(match.name || match.label || '');
            if (matchName) {
              // Retry traverse with fuzzy match
              const retryRaw = await api.post<unknown>('/graph/traverse', {
                entity: matchName,
                max_hops: Math.min((args.depth as number) || 2, 10),
              });
              const retryResult = validateGraphResponse(retryRaw, '/graph/traverse');
              const sanitized = sanitizeGraph(
                retryResult.nodes.map(n => n as unknown as Record<string, unknown>),
                retryResult.edges.map(e => e as unknown as Record<string, unknown>),
              );
              const root = sanitized.nodes[0] || { id: matchName, entity_type: 'unknown', label: matchName };
              return {
                text: JSON.stringify(wrapResponse({
                  root,
                  relations: sanitized.edges,
                  connected_entities: sanitized.nodes.slice(1),
                  depth_reached: retryResult.hops ?? 0,
                  fuzzy_match: { requested: args.entity, matched: matchName },
                }, config)),
              };
            }
          }
        } catch { /* fuzzy search unavailable */ }

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

  // Build 3.1: velixar_graph_search
  if (name === 'velixar_graph_search') {
    const query = args.query as string;
    const entityType = args.entity_type as string | undefined;
    const limit = Math.min((args.limit as number) || 10, 50);

    try {
      const raw = await api.post<unknown>('/graph/search', {
        query, entity_type: entityType, limit,
      });
      const rObj = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {};
      const rawEntities = Array.isArray(rObj.entities) ? rObj.entities : [];

      const entities = rawEntities.map((e: unknown) => {
        if (!e || typeof e !== 'object') return null;
        const ent = e as Record<string, unknown>;
        return sanitizeGraph([ent], []).nodes[0];
      }).filter((e): e is NonNullable<typeof e> => e !== null).slice(0, limit);

      return {
        text: JSON.stringify(wrapResponse({
          entities,
          count: entities.length,
          query,
          ...(entityType ? { entity_type_filter: entityType } : {}),
        }, config, {
          data_absent: entities.length === 0,
        })),
      };
    } catch (e) {
      // Fallback: use traverse with depth 0 as a search proxy
      try {
        const raw = await api.post<unknown>('/graph/traverse', { entity: query, max_hops: 1 });
        const result = validateGraphResponse(raw, '/graph/traverse');
        const sanitized = sanitizeGraph(
          result.nodes.map(n => n as unknown as Record<string, unknown>),
          result.edges.map(e => e as unknown as Record<string, unknown>),
        );
        return {
          text: JSON.stringify(wrapResponse({
            entities: sanitized.nodes,
            count: sanitized.nodes.length,
            query,
            _fallback: true,
          }, config, {
            data_absent: sanitized.nodes.length === 0,
          })),
        };
      } catch {
        return {
          text: JSON.stringify(wrapResponse(
            { entities: [], count: 0, query, message: 'No entities found' },
            config,
            { data_absent: true },
          )),
        };
      }
    }
  }

  // Build 3.2: velixar_graph_stats
  if (name === 'velixar_graph_stats') {
    try {
      const raw = await api.get<unknown>('/graph/stats', true);
      const rObj = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {};

      return {
        text: JSON.stringify(wrapResponse({
          entity_count: typeof rObj.entity_count === 'number' ? rObj.entity_count : 0,
          relationship_count: typeof rObj.relationship_count === 'number' ? rObj.relationship_count : 0,
          top_entity_types: Array.isArray(rObj.top_entity_types) ? rObj.top_entity_types : [],
          density: typeof rObj.density === 'number' ? rObj.density : undefined,
        }, config)),
      };
    } catch {
      // Fallback: derive stats from a broad traverse
      try {
        const raw = await api.post<unknown>('/graph/traverse', { entity: '*', max_hops: 1 });
        const result = validateGraphResponse(raw, '/graph/traverse');
        const typeCount: Record<string, number> = {};
        for (const n of result.nodes) {
          const t = n.entity_type || 'unknown';
          typeCount[t] = (typeCount[t] || 0) + 1;
        }
        const topTypes = Object.entries(typeCount)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10)
          .map(([type, count]) => ({ type, count }));

        return {
          text: JSON.stringify(wrapResponse({
            entity_count: result.nodes.length,
            relationship_count: result.edges.length,
            top_entity_types: topTypes,
            _fallback: true,
          }, config)),
        };
      } catch {
        return {
          text: JSON.stringify(wrapResponse(
            { entity_count: 0, relationship_count: 0, top_entity_types: [], message: 'Graph stats unavailable' },
            config,
            { data_absent: true },
          )),
        };
      }
    }
  }

  throw new Error(`Unknown graph tool: ${name}`);
}
