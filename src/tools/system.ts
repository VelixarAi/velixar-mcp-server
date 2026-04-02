// ── System Tools ──
// health, debug, capabilities, security, audit_log

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ApiClient } from '../api.js';
import { wrapResponse } from '../api.js';
import type { ApiConfig } from '../types.js';
import { getTimings, getRetryStats, getCircuitState, getRateLimitInfo } from '../api.js';
import { getErrorRegistry } from '../errors.js';

const VERSION = '0.5.0';

// Build 7.1: Audit log — in-memory ring buffer of recent tool calls
interface AuditEntry {
  tool: string;
  timestamp: string;
  duration_ms: number;
  params_summary: string;
  success: boolean;
}

const AUDIT_LOG: AuditEntry[] = [];
const MAX_AUDIT_ENTRIES = 200;

export function recordAudit(tool: string, durationMs: number, params: Record<string, unknown>, success: boolean): void {
  // Summarize params — strip content/data to avoid storing sensitive info
  const summary: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (k === 'content' || k === 'data') { summary[k] = `<${typeof v === 'string' ? v.length : '?'} chars>`; }
    else if (Array.isArray(v)) { summary[k] = `[${v.length} items]`; }
    else { summary[k] = v; }
  }
  AUDIT_LOG.push({
    tool,
    timestamp: new Date().toISOString(),
    duration_ms: durationMs,
    params_summary: JSON.stringify(summary).slice(0, 200),
    success,
  });
  if (AUDIT_LOG.length > MAX_AUDIT_ENTRIES) AUDIT_LOG.shift();
}

export const systemTools: Tool[] = [
  {
    name: 'velixar_health',
    description:
      'Check Velixar backend connectivity and health. Returns connection state, workspace, and latency.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'velixar_debug',
    description:
      'Get debug information about the current Velixar MCP server state. ' +
      'Returns workspace config, cache state, API timings, retry counts, circuit breaker state.',
    inputSchema: {
      type: 'object',
      properties: {
        verbose: { type: 'boolean', description: 'Set verbose logging on/off (omit to just get debug info)' },
      },
    },
  },
  {
    name: 'velixar_capabilities',
    description:
      'List all available Velixar tools, resources, prompts, and features. ' +
      'Use to discover what cognitive capabilities are currently enabled.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'velixar_security',
    description:
      'Get or set the security scanning mode for memory content. ' +
      'Modes: "standard" (default), "strict" (PII redaction), "off" (no scanning).',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['standard', 'strict', 'off'], description: 'Security mode to set (omit to get current)' },
      },
    },
  },
  {
    name: 'velixar_audit_log',
    description:
      'Query recent operations performed by Velixar. Returns tool name, timestamp, params summary, and result.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max entries to return (default 20)' },
        tool_name: { type: 'string', description: 'Filter by tool name' },
        before: { type: 'string', description: 'ISO timestamp — only entries before this time' },
        after: { type: 'string', description: 'ISO timestamp — only entries after this time' },
      },
    },
  },
];

export async function handleSystemTool(
  name: string,
  args: Record<string, unknown>,
  api: ApiClient,
  config: ApiConfig,
  toolNames: string[],
  resourceUris: string[],
  promptNames: string[] = [],
): Promise<{ text: string; isError?: boolean }> {
  if (name === 'velixar_health') {
    const start = Date.now();
    try {
      const result = await api.get<{ status?: string; qdrant?: boolean; redis?: boolean; search?: boolean }>('/health');
      const latency = Date.now() - start;
      const circuit = getCircuitState();
      return {
        text: JSON.stringify(wrapResponse({
          connected: true,
          workspace_id: config.workspaceId || '(from API key)',
          backend_reachable: true,
          backend_status: result.status || 'ok',
          qdrant: result.qdrant,
          redis: result.redis,
          search: result.search,
          latency_ms: latency,
          circuit_breaker: circuit.open ? 'open' : 'closed',
          tool_tier: parseInt(process.env.VELIXAR_TOOL_TIER || '3', 10),
          version: VERSION,
        }, config, { request_ms: latency })),
      };
    } catch (e) {
      return {
        text: JSON.stringify(wrapResponse({
          connected: false,
          workspace_id: config.workspaceId || '(from API key)',
          backend_reachable: false,
          error: (e as Error).message,
          circuit_breaker: getCircuitState().open ? 'open' : 'closed',
          tool_tier: parseInt(process.env.VELIXAR_TOOL_TIER || '3', 10),
          version: VERSION,
        }, config)),
        isError: true,
      };
    }
  }

  if (name === 'velixar_debug') {
    if (typeof args.verbose === 'boolean') {
      config.debug = args.verbose;
    }
    const timings = getTimings();
    const stats = getRetryStats();
    const circuit = getCircuitState();
    const timingMap: Record<string, number> = {};
    for (const t of timings) timingMap[t.endpoint] = t.duration_ms;
    return {
      text: JSON.stringify(wrapResponse({
        workspace_id: config.workspaceId || '(from API key)',
        workspace_source: config.workspaceSource,
        debug_mode: config.debug,
        api_base: config.apiBase,
        last_api_timings: timingMap,
        retry_count: stats.retryCount,
        fallback_count: stats.fallbackCount,
        circuit_breaker: circuit,
        rate_limit: getRateLimitInfo(),
        tool_tier: parseInt(process.env.VELIXAR_TOOL_TIER || '3', 10),
        error_registry: getErrorRegistry(),
        version: VERSION,
      }, config)),
    };
  }

  if (name === 'velixar_capabilities') {
    return {
      text: JSON.stringify(wrapResponse({
        tools: toolNames,
        tool_count: toolNames.length,
        tool_tier: parseInt(process.env.VELIXAR_TOOL_TIER || '3', 10),
        tier_info: (() => { const t = parseInt(process.env.VELIXAR_TOOL_TIER || '3', 10); return t === 1 ? 'minimal (9 tools)' : t === 2 ? 'standard (~20 tools)' : 'full (all tools)'; })(),
        resources: resourceUris,
        prompts: promptNames,
        features: {
          workspace_isolation: true,
          identity: true,
          graph: true,
          contradictions: true,
          timeline: true,
          patterns: true,
          distill: true,
          justification: true,
          batch_operations: true,
          session_persistence: true,
          circuit_breaker: true,
          structured_errors: process.env.VELIXAR_STRUCTURED_ERRORS === 'true',
          audit_log: true,
        },
        security_mode: currentSecurityMode,
        version: VERSION,
      }, config)),
    };
  }

  if (name === 'velixar_security') {
    const mode = args.mode as string | undefined;
    if (mode) {
      let verified = false;
      try {
        await api.patch('/settings/security', { mode });
        const readback = await api.get<{ mode?: string }>('/settings/security', true);
        verified = readback.mode === mode;
        currentSecurityMode = readback.mode || mode;
      } catch {
        currentSecurityMode = mode;
        verified = false;
      }
      return { text: JSON.stringify(wrapResponse({ mode: currentSecurityMode, updated: true, verified }, config)) };
    }
    return { text: JSON.stringify(wrapResponse({ mode: currentSecurityMode }, config)) };
  }

  // Build 7.1: Audit log
  if (name === 'velixar_audit_log') {
    const limit = Math.min((args.limit as number) || 20, 100);
    const toolFilter = args.tool_name as string | undefined;
    const before = args.before as string | undefined;
    const after = args.after as string | undefined;

    let entries = [...AUDIT_LOG].reverse(); // most recent first
    if (toolFilter) entries = entries.filter(e => e.tool === toolFilter);
    if (before) {
      const beforeMs = new Date(before).getTime();
      if (!isNaN(beforeMs)) entries = entries.filter(e => new Date(e.timestamp).getTime() < beforeMs);
    }
    if (after) {
      const afterMs = new Date(after).getTime();
      if (!isNaN(afterMs)) entries = entries.filter(e => new Date(e.timestamp).getTime() > afterMs);
    }

    return {
      text: JSON.stringify(wrapResponse({
        entries: entries.slice(0, limit),
        count: entries.length,
        total_in_buffer: AUDIT_LOG.length,
      }, config, { data_absent: entries.length === 0 })),
    };
  }

  throw new Error(`Unknown system tool: ${name}`);
}

let currentSecurityMode = 'standard';
