// ── System Tools ──
// health, debug, capabilities

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ApiClient } from '../api.js';
import type { ApiConfig } from '../types.js';
import { getTimings, getRetryStats } from '../api.js';

const VERSION = '0.3.0';

export const systemTools: Tool[] = [
  {
    name: 'velixar_health',
    description:
      'Check Velixar backend connectivity and health. Returns connection state, workspace, and latency. ' +
      'Use when you suspect the backend may be unreachable or slow.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'velixar_debug',
    description:
      'Get debug information about the current Velixar MCP server state. Returns workspace config, ' +
      'cache state, recent API timings, retry/fallback counts. Use to diagnose unexpected behavior.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'velixar_capabilities',
    description:
      'List all available Velixar tools, resources, and features. Use to discover what cognitive ' +
      'capabilities are currently enabled in this workspace.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
];

export async function handleSystemTool(
  name: string,
  _args: Record<string, unknown>,
  api: ApiClient,
  config: ApiConfig,
  toolNames: string[],
  resourceUris: string[],
): Promise<{ text: string; isError?: boolean }> {
  if (name === 'velixar_health') {
    const start = Date.now();
    try {
      const result = await api.get<{ status?: string }>('/health');
      const latency = Date.now() - start;
      return {
        text: JSON.stringify({
          connected: true,
          workspace_id: config.workspaceId || '(from API key)',
          workspace_source: config.workspaceSource,
          backend_reachable: true,
          backend_status: result.status || 'ok',
          latency_ms: latency,
          version: VERSION,
        }, null, 2),
      };
    } catch (e) {
      return {
        text: JSON.stringify({
          connected: false,
          workspace_id: config.workspaceId || '(from API key)',
          workspace_source: config.workspaceSource,
          backend_reachable: false,
          error: (e as Error).message,
          version: VERSION,
        }, null, 2),
      };
    }
  }

  if (name === 'velixar_debug') {
    const timings = getTimings();
    const stats = getRetryStats();
    const timingMap: Record<string, number> = {};
    for (const t of timings) {
      timingMap[t.endpoint] = t.duration_ms;
    }
    return {
      text: JSON.stringify({
        workspace_id: config.workspaceId || '(from API key)',
        workspace_source: config.workspaceSource,
        debug_mode: config.debug,
        api_base: config.apiBase,
        last_api_timings: timingMap,
        retry_count: stats.retryCount,
        fallback_count: stats.fallbackCount,
        version: VERSION,
      }, null, 2),
    };
  }

  if (name === 'velixar_capabilities') {
    return {
      text: JSON.stringify({
        tools: toolNames,
        resources: resourceUris,
        prompts: [],
        features: {
          workspace_isolation: true,
          identity: false,       // Phase 2
          graph: false,          // Phase 2
          contradictions: false, // Phase 2
          timeline: false,       // Phase 2
          patterns: false,       // Phase 2
          distill: false,        // Phase 2
          justification: false,  // Phase 2
        },
        version: VERSION,
      }, null, 2),
    };
  }

  throw new Error(`Unknown system tool: ${name}`);
}
