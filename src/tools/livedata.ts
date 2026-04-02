// ── Live Data Tools ──
// velixar_discover_data — KG-powered "where does X live?" queries
// velixar_list_sources — show customer's connected data sources
// velixar_query_source — direct live data query through Marco Polo
//
// These tools give the AI agent direct access to live enterprise data
// via Marco Polo's MCP runtime. Ground truth, zero hallucination.

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ApiClient } from '../api.js';
import { wrapResponse } from '../api.js';
import type { ApiConfig } from '../types.js';

export const liveDataTools: Tool[] = [
  {
    name: 'velixar_discover_data',
    description:
      'Find which data sources contain information about a topic via knowledge graph. ' +
      'Returns source names, tables, and related insights.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'Business concept to find data sources for (e.g., "customer churn", "revenue")' },
        depth: { type: 'number', description: 'KG traversal depth (default 3, max 5)' },
        include_schema: { type: 'boolean', description: 'Return column-level detail for matched tables (default: false)' },
      },
      required: ['topic'],
    },
  },
  {
    name: 'velixar_list_sources',
    description:
      'List all connected data sources for the current customer. Supports filtering by type and status.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'Filter by source type (e.g., "relational", "saas", "file")' },
        status: { type: 'string', enum: ['connected', 'stale', 'error'], description: 'Filter by connection status' },
      },
    },
  },
  {
    name: 'velixar_query_source',
    description:
      'Query a live data source through Marco Polo. Returns real-time data (ground truth). ' +
      'Natural language query is translated to SQL/API call. Always tag results as [LIVE DATA].',
    inputSchema: {
      type: 'object',
      properties: {
        datasource: { type: 'string', description: 'Name of the data source to query (from velixar_list_sources)' },
        query: { type: 'string', description: 'Natural language query (e.g., "show me churn rate by quarter for the last year")' },
        limit: { type: 'number', description: 'Max rows to return (default 10, max 100)' },
        show_query: { type: 'boolean', description: 'Return the generated SQL alongside results (default: false)' },
        cursor: { type: 'string', description: 'Pagination cursor for results beyond the limit' },
      },
      required: ['datasource', 'query'],
    },
  },
];

export async function handleLiveDataTool(
  name: string,
  args: Record<string, unknown>,
  api: ApiClient,
  config: ApiConfig,
): Promise<{ text: string; isError?: boolean }> {

  if (name === 'velixar_discover_data') {
    const topic = args.topic as string;
    const depth = Math.min((args.depth as number) || 3, 5);
    const includeSchema = args.include_schema as boolean;

    // Two-pronged discovery: KG traversal + memory search for the topic
    const [graphRes, searchRes] = await Promise.allSettled([
      api.post<Record<string, unknown>>('/graph/traverse', {
        entity: topic,
        max_hops: depth,
      }),
      api.get<unknown>(
        `/memory/search?q=${encodeURIComponent(`data source for ${topic}`)}&limit=5`,
        true,
      ),
    ]);

    // Extract data source entities from graph
    const sources: Array<{ name: string; type: string; tables: string[]; relationship: string; schema?: Record<string, unknown>[] }> = [];
    if (graphRes.status === 'fulfilled') {
      const gObj = (graphRes.value && typeof graphRes.value === 'object') ? graphRes.value as Record<string, unknown> : {};
      const nodes = Array.isArray(gObj.nodes) ? gObj.nodes : [];
      const edges = Array.isArray(gObj.edges) ? gObj.edges : [];

      for (const node of nodes) {
        if (node.entity_type === 'data_source') {
          const tables = nodes
            .filter((n: any) =>
              n.entity_type === 'table' &&
              edges.some((e: any) =>
                e.source === n.id && e.target === node.id && e.relationship === 'hosted_on'
              )
            )
            .map((n: any) => n.label || n.id);

          // Build 8.3: include_schema — column-level detail
          let schema: Record<string, unknown>[] | undefined;
          if (includeSchema && tables.length > 0) {
            schema = nodes
              .filter((n: any) =>
                n.entity_type === 'column' &&
                tables.some((t: string) =>
                  edges.some((e: any) => e.source === n.id && e.target === t)
                )
              )
              .map((n: any) => ({
                column: n.label || n.id,
                table: n.properties?.table || 'unknown',
                type: n.properties?.data_type || 'unknown',
              }));
          }

          sources.push({
            name: node.label || node.id,
            type: node.properties?.source_type || 'unknown',
            tables,
            relationship: 'hosts data related to ' + topic,
            ...(schema?.length ? { schema } : {}),
          });
        }
      }
    }

    // Extract mentions from memory search
    const relatedInsights: Array<{ content: string; data_sources?: string[] }> = [];
    if (searchRes.status === 'fulfilled') {
      const rObj = (searchRes.value && typeof searchRes.value === 'object') ? searchRes.value as Record<string, unknown> : {};
      const mems = Array.isArray(rObj.memories) ? rObj.memories : [];
      for (const mem of mems.slice(0, 3)) {
        const m = mem as Record<string, unknown>;
        relatedInsights.push({
          content: (typeof m.content === 'string' ? m.content : '').substring(0, 200),
          data_sources: Array.isArray(m.data_sources) ? m.data_sources as string[] : [],
        });
      }
    }

    return {
      text: JSON.stringify(wrapResponse({
        topic,
        sources,
        related_insights: relatedInsights,
        discovery_depth: depth,
        message: sources.length > 0
          ? `Found ${sources.length} data source(s) related to "${topic}".`
          : `No data sources mapped to "${topic}" yet. Try querying available sources — the knowledge graph learns from usage.`,
      }, config, {
        data_absent: sources.length === 0 && relatedInsights.length === 0,
      })),
    };
  }

  if (name === 'velixar_list_sources') {
    const filterType = args.type as string | undefined;
    const filterStatus = args.status as string | undefined;
    try {
      const raw = await api.get<unknown>('/partner/sources', true);
      const rObj = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {};
      let sources = Array.isArray(raw) ? raw : (Array.isArray(rObj.datasources) ? rObj.datasources : []);

      let mapped = sources.map((s: any) => ({
        name: s.name,
        type: s.type || 'unknown',
        status: s.status || 'connected',
        last_queried: s.last_queried || null,
      }));
      if (filterType) mapped = mapped.filter((s: any) => s.type === filterType);
      if (filterStatus) mapped = mapped.filter((s: any) => s.status === filterStatus);

      return {
        text: JSON.stringify(wrapResponse({
          sources: mapped,
          count: mapped.length,
        }, config, { data_absent: mapped.length === 0 })),
      };
    } catch (e) {
      return {
        text: JSON.stringify(wrapResponse({
          sources: [],
          count: 0,
          message: 'Live data sources not available. This workspace may not have a partner integration configured.',
        }, config, { data_absent: true })),
      };
    }
  }

  if (name === 'velixar_query_source') {
    const datasource = args.datasource as string;
    const query = args.query as string;
    const limit = Math.min((args.limit as number) || 10, 100);
    const showQuery = args.show_query as boolean;
    const cursor = args.cursor as string | undefined;

    try {
      const raw = await api.post<Record<string, unknown>>('/partner/query', {
        datasource_name: datasource,
        query_string: query,
        limit,
        ...(cursor ? { cursor } : {}),
        ...(showQuery ? { show_query: true } : {}),
      });

      const rObj = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {};
      const results = Array.isArray(rObj.results) ? rObj.results : [];
      const truncated = rObj.truncated === true;
      const metadata = {
        datasource,
        tables_touched: Array.isArray(rObj.tables) ? rObj.tables : [],
        columns_referenced: Array.isArray(rObj.columns) ? rObj.columns : [],
        row_count: (typeof rObj.row_count === 'number' ? rObj.row_count : results.length),
        executed_at: (typeof rObj.executed_at === 'string' ? rObj.executed_at : new Date().toISOString()),
      };

      // Format results with [LIVE DATA] tag
      const formatted = results.slice(0, limit).map((row: any) => {
        if (typeof row === 'string') return row;
        if (typeof row === 'object') {
          return Object.entries(row).map(([k, v]) => `${k}: ${v}`).join(', ');
        }
        return String(row);
      });

      return {
        text: JSON.stringify(wrapResponse({
          source: `[LIVE DATA] ${datasource}`,
          results: formatted,
          metadata,
          truncated,
          ...(showQuery && typeof rObj.generated_query === 'string' ? { generated_query: rObj.generated_query } : {}),
          ...(typeof rObj.next_cursor === 'string' ? { next_cursor: rObj.next_cursor } : {}),
          message: truncated
            ? `[LIVE DATA - PARTIAL] Returned ${formatted.length} of ${metadata.row_count} rows from ${datasource}. Results may be incomplete.`
            : `[LIVE DATA] ${formatted.length} rows from ${datasource} (queried ${metadata.executed_at}).`,
        }, config)),
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        text: JSON.stringify(wrapResponse({
          source: datasource,
          results: [],
          error: msg,
          message: `Failed to query ${datasource}: ${msg}. The data source may be unavailable or you may not have access.`,
        }, config, { data_absent: true })),
        isError: true,
      };
    }
  }

  throw new Error(`Unknown live data tool: ${name}`);
}
