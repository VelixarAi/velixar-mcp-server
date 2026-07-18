// ── System Tools ──
// health, debug, capabilities, security, audit_log

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ApiClient } from '../api.js';
import { wrapResponse } from '../api.js';
import type { ApiConfig } from '../types.js';
import { getTimings, getRetryStats, getCircuitState, getRateLimitInfo } from '../api.js';
import { getErrorRegistry } from '../errors.js';
// Derived from package.json, never typed by hand. This used to be a literal
// '0.5.0' while the package shipped as 1.2.0 and serverInfo claimed 1.1.0.
import { VERSION } from '../version.js';

// H1.4/Chain 8: Track whether backend capabilities have been verified
let _capabilitiesVerified = false;

export function setCapabilitiesVerified(v: boolean): void { _capabilitiesVerified = v; }
export function isCapabilitiesVerified(): boolean { return _capabilitiesVerified; }

// F2v2b: the server-authored entitlement record for THIS key's workspace, fetched at
// startup from GET /v1/entitlements. Drives an HONEST tool schema (the tier enum is
// capped at the workspace's real ceiling, so unentitled options are invisible) and the
// entitlement fields in velixar_capabilities. Schema gating is UX only — the backend's
// per-surface checks stay authoritative. null = not fetched (old backend / offline):
// don't cap, the server still 403s.
export interface Entitlements {
  plan?: string;
  org_memory?: { entitled: boolean; reason?: string | null };
  max_memory_tier?: number;
}
let _entitlements: Entitlements | null = null;

export function setEntitlements(e: Entitlements | null): void { _entitlements = e; }
export function getEntitlements(): Entitlements | null { return _entitlements; }
export function orgMemoryEntitled(): boolean {
  // Unknown (null) = don't cap the schema; only a definite "not entitled" hides tier 3.
  return _entitlements?.org_memory?.entitled !== false;
}

const TIER_DESC_FULL = 'Memory tier: 0=pinned, 1=session, 2=semantic (default), 3=org';
const TIER_DESC_CAPPED =
  'Memory tier: 0=pinned, 1=session, 2=semantic (default). Tier 3 (org) requires an ' +
  'org-memory plan and organization membership — not provisioned for this key.';

/** Rewrite `tier` properties in tool schemas to the workspace's real ceiling.
 *  Returns new tool objects (originals untouched) so a later entitlement change
 *  or re-fetch can re-cap from the pristine definitions. */
export function applyEntitlementCaps<T extends { inputSchema?: unknown }>(tools: T[]): T[] {
  if (orgMemoryEntitled()) return tools;
  return tools.map((tool) => {
    const schema = tool.inputSchema as { properties?: Record<string, { type?: string; description?: string; maximum?: number }> } | undefined;
    const tier = schema?.properties?.tier;
    if (!tier || tier.type !== 'number') return tool;
    return {
      ...tool,
      inputSchema: {
        ...(schema as object),
        properties: {
          ...schema!.properties,
          tier: {
            ...tier,
            maximum: 2,
            description: tier.description === TIER_DESC_FULL || (tier.description || '').includes('3=org')
              ? TIER_DESC_CAPPED
              : `${tier.description || 'Memory tier'} (max 2 — tier 3 requires an org-memory plan)`,
          },
        },
      },
    } as T;
  });
}

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
      'Query recent tool calls made by THIS MCP session (in-process diagnostics, volatile, completed calls only). ' +
      'For the durable, hash-chained provenance trail pass durable:true — that queries the backend audit chain.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max entries to return (default 20)' },
        tool_name: { type: 'string', description: 'Filter by tool name' },
        before: { type: 'string', description: 'ISO timestamp — only entries before this time' },
        after: { type: 'string', description: 'ISO timestamp — only entries after this time' },
        durable: { type: 'boolean', description: 'Query the backend hash-chained audit trail instead of this session buffer' },
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
      const result = await api.get<{ status?: string; qdrant?: boolean; redis?: boolean; search?: boolean; probed?: Record<string, boolean> }>('/health');
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
          // Honest coverage (DX #7): what the backend actually PROBED. A green health
          // does not mean writes work — write_path/embedding are not probed. Read this,
          // not the top-line status, before trusting the write path.
          probed: result.probed ?? { note: 'backend did not report coverage (older build)' },
          latency_ms: latency,
          circuit_breaker: circuit.open ? 'open' : 'closed',
          // capabilities_verified = the MCP initialize handshake succeeded and tools are
          // registered. It does NOT probe the write path — see `probed` for that.
          capabilities_verified: _capabilitiesVerified,
          capabilities_verified_meaning: 'MCP handshake + tool registration only; not a write-path probe',
          // tool_tier = which tier of tools THIS server exposes (0=core … 3=all); a client
          // capability ceiling, unrelated to memory tiers (0=pinned…3=org) on store.
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
        // toolset_tier is WHICH TOOLS this server exposes (env-set, 1/2/3) — a different
        // axis from memory tiers. F2v2 flagged the old bare `tool_tier` as reading like
        // an entitlement ceiling; the memory-tier ceiling is `max_memory_tier` below.
        toolset_tier: parseInt(process.env.VELIXAR_TOOL_TIER || '3', 10),
        tool_tier: parseInt(process.env.VELIXAR_TOOL_TIER || '3', 10),  // deprecated alias of toolset_tier
        tier_info: (() => { const t = parseInt(process.env.VELIXAR_TOOL_TIER || '3', 10); return t === 1 ? 'minimal toolset (9 tools)' : t === 2 ? 'standard toolset (~20 tools)' : 'full toolset (all tools)'; })(),
        plan: getEntitlements()?.plan ?? null,
        org_memory_entitled: getEntitlements()?.org_memory?.entitled ?? null,
        max_memory_tier: getEntitlements()?.max_memory_tier ?? (orgMemoryEntitled() ? 3 : 2),
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

    if (args.durable) {
      // The REAL trail: the backend's hash-chained audit store. The local
      // buffer below is session diagnostics — volatile, this process only,
      // completed calls only — and presenting it as "the audit log" is how
      // it got read as a 7-entry ring buffer undercutting provenance claims.
      const qs = new URLSearchParams({ limit: String(limit) });
      const raw = await api.get<unknown>(`/audit?${qs}`, false);
      const rObj = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {};
      return {
        text: JSON.stringify(wrapResponse({
          source: 'backend hash-chained audit trail',
          ...rObj,
        }, config)),
      };
    }
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
        source: 'this MCP session only — volatile in-process diagnostics; completed calls only (a hung call never lands here). For the durable provenance trail pass durable:true.',
        entries: entries.slice(0, limit),
        count: entries.length,
        total_in_buffer: AUDIT_LOG.length,
      }, config, { data_absent: entries.length === 0 })),
    };
  }

  throw new Error(`Unknown system tool: ${name}`);
}

let currentSecurityMode = 'standard';
