#!/usr/bin/env node
// ── Velixar MCP Server ──
// Persistent cognitive context infrastructure for LLMs.
// See ~/MCP-SERVER-STRATEGY.md for design rationale.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { loadConfig, ApiClient, log, setClientRoots, validateWorkspace } from './api.js';
import { memoryTools, handleMemoryTool } from './tools/memory.js';
import { systemTools, handleSystemTool, recordAudit } from './tools/system.js';
import { recallTools, handleRecallTool } from './tools/recall.js';
import { graphTools, handleGraphTool } from './tools/graph.js';
import { cognitiveTools, handleCognitiveTool, trackToolCallForIdentity } from './tools/cognitive.js';
import { lifecycleTools, handleLifecycleTool } from './tools/lifecycle.js';
import { liveDataTools, handleLiveDataTool } from './tools/livedata.js';
import { retrievalTools, handleRetrievalTool } from './tools/retrieval.js';
import { constructionTools, handleConstructionTool } from './tools/construction.js';
import { fetchRecall, getResourceList, readResource, getResourceUris, refreshIdentity, refreshRelevantMemories, markToolCall, isRelevantStale, getConstitutionFallback } from './resources.js';
import { getPromptList, getPrompt, allPrompts } from './prompts.js';

// ── AH-5: Anti-pattern detection ──
const REINFORCE_INTERVAL = parseInt(process.env.VELIXAR_CONSTITUTION_REINFORCE_INTERVAL || '10', 10);
let _toolCallCount = 0;
let _recentToolCalls: string[] = []; // last 5 tool names for pattern detection
let _promptReadCount = 0;

// Search-like tools — any of these count as "did a search" for anti-pattern purposes
const SEARCH_TOOLS = new Set([
  'velixar_search', 'velixar_batch_search', 'velixar_multi_search',
  'velixar_context', 'velixar_prepare_context', 'velixar_coverage_check',
]);

function detectAntiPattern(toolName: string): string | null {
  const recent = _recentToolCalls;
  const last = recent.length >= 1 ? recent[recent.length - 1] : null;

  // Sequential single searches that should be batched or use multi_search
  if (toolName === 'velixar_search' && last === 'velixar_search') {
    return 'Tip: use velixar_multi_search for merged results with deduplication, or merge:false for per-query results.';
  }
  // Single search right after context — context already searched
  if (toolName === 'velixar_search' && last === 'velixar_context') {
    return 'Note: velixar_context already includes KG-boosted search results. Only use velixar_search if you need a different query.';
  }
  // Store without prior search (check last 3 calls)
  if (toolName === 'velixar_store' && !recent.slice(-3).some(t => SEARCH_TOOLS.has(t))) {
    return 'Warning: search before storing to avoid duplicates.';
  }
  return null;
}

function trackToolCall(toolName: string): void {
  _toolCallCount++;
  _recentToolCalls.push(toolName);
  if (_recentToolCalls.length > 5) _recentToolCalls.shift();
}

// ── Init ──

const config = loadConfig();
const api = new ApiClient(config);

// M19: MCP host detection — infer host from transport/environment signals
const detectedHost = process.env.CURSOR_SESSION_ID ? 'cursor'
  : process.env.CONTINUE_SESSION_ID ? 'continue'
  : process.env.VSCODE_PID ? 'vscode'
  : process.env.WINDSURF_SESSION ? 'windsurf'
  : process.env.KIRO_SESSION ? 'kiro'
  : 'unknown';
if (detectedHost !== 'unknown') log('info', 'host_detected', { host: detectedHost });

const allTools = [...memoryTools, ...recallTools, ...graphTools, ...cognitiveTools, ...lifecycleTools, ...liveDataTools, ...retrievalTools, ...constructionTools, ...systemTools];
const allToolNames = allTools.map(t => t.name);

// ── Build 7.2: Tool Tier System ──
// H5.1: Tier 2 is default. H5.2: capabilities always included. H5.3: Tier 1 = 9 core tools.
// Static at startup only (dynamic tiers deferred per 7 Whys Round 2 Chain 13).
const TOOL_TIERS: Record<number, Set<string>> = {
  1: new Set([
    'velixar_context', 'velixar_search', 'velixar_store', 'velixar_list',
    'velixar_update', 'velixar_delete', 'velixar_session_resume', 'velixar_health', 'velixar_capabilities',
  ]),
  2: new Set([
    // Tier 1 + these
    'velixar_context', 'velixar_search', 'velixar_store', 'velixar_list',
    'velixar_update', 'velixar_delete', 'velixar_session_resume', 'velixar_health', 'velixar_capabilities',
    'velixar_multi_search', 'velixar_prepare_context', 'velixar_distill', 'velixar_timeline',
    'velixar_contradictions', 'velixar_patterns', 'velixar_graph_traverse', 'velixar_session_save',
    'velixar_session_recall', 'velixar_coverage_check', 'velixar_export', 'velixar_import', 'velixar_identity',
  ]),
  // Tier 3 = all tools (no filtering)
};

const toolTier = parseInt(process.env.VELIXAR_TOOL_TIER || '3', 10);
const tierFilter = TOOL_TIERS[toolTier];
const exposedTools = tierFilter ? allTools.filter(t => tierFilter.has(t.name)) : allTools;
if (tierFilter) log('info', 'tool_tier_active', { tier: toolTier, exposed: exposedTools.length, total: allTools.length });

const toolHandlers: Array<{ names: Set<string>; handler: typeof handleMemoryTool }> = [
  { names: new Set(memoryTools.map(t => t.name)), handler: handleMemoryTool },
  { names: new Set(recallTools.map(t => t.name)), handler: handleRecallTool },
  { names: new Set(graphTools.map(t => t.name)), handler: handleGraphTool },
  { names: new Set(cognitiveTools.map(t => t.name)), handler: handleCognitiveTool },
  { names: new Set(lifecycleTools.map(t => t.name)), handler: handleLifecycleTool },
  { names: new Set(liveDataTools.map(t => t.name)), handler: handleLiveDataTool },
  { names: new Set(retrievalTools.map(t => t.name).concat('velixar_batch_search')), handler: handleRetrievalTool },
  { names: new Set(constructionTools.map(t => t.name)), handler: handleConstructionTool },
];
const systemToolNames = new Set(systemTools.map(t => t.name));

// ── Server ──
// H7.5: Server name configurable for white-label partners
const serverName = process.env.VELIXAR_MCP_SERVER_NAME || 'velixar-mcp-server';

const server = new Server(
  { name: serverName, version: '1.1.0' },
  { capabilities: { tools: {}, resources: {}, prompts: {} } },
);

// ── Resources ──

fetchRecall(api, config); // non-blocking startup

// Capture client roots for workspace cross-validation
server.oninitialized = async () => {
  try {
    const rootsResult = await server.listRoots();
    if (rootsResult?.roots?.length) {
      setClientRoots(rootsResult.roots);
      const warning = validateWorkspace(config);
      if (warning) log('warn', 'workspace_mismatch', { warning, workspace: config.workspaceId, roots: rootsResult.roots.map(r => r.uri) });
    }
  } catch { /* host doesn't support roots — that's fine */ }
};

server.setRequestHandler(ListResourcesRequestSchema, async () => getResourceList());
server.setRequestHandler(ReadResourceRequestSchema, async (req) => readResource(req.params.uri, api));

// ── Prompts ──

server.setRequestHandler(ListPromptsRequestSchema, async () => getPromptList());
server.setRequestHandler(GetPromptRequestSchema, async (req) => {
  // AH-6: Log prompt reads for observability
  _promptReadCount++;
  log('info', 'prompt_read', { prompt: req.params.name, host: detectedHost, total_reads: _promptReadCount });
  return getPrompt(req.params.name, (req.params.arguments || {}) as Record<string, string>);
});

// ── Tools ──

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: exposedTools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  const start = Date.now();

  try {
    let result: { text: string; isError?: boolean };

    if (systemToolNames.has(name)) {
      result = await handleSystemTool(name, args as Record<string, unknown>, api, config, allToolNames, getResourceUris(), allPrompts.map(p => p.name));
    } else {
      const entry = toolHandlers.find(h => h.names.has(name));
      if (!entry) {
        return {
          content: [{
            type: 'text' as const,
            text: `Unknown tool: ${name}\n\nNote: Velixar MCP tools are only available in the primary agent context. If you're seeing this in a subagent, memory operations must be handled by the primary agent.`,
          }],
          isError: true,
        };
      }
      result = await entry.handler(name, args as Record<string, unknown>, api, config);
    }

    log('info', 'tool_call', { tool: name, duration_ms: Date.now() - start, error: false });

    // Build 7.1: Record audit entry
    recordAudit(name, Date.now() - start, args as Record<string, unknown>, !result.isError);

    // AH-5: Track tool call sequence for anti-pattern detection
    trackToolCall(name);

    // Workspace cross-validation warning
    const wsWarning = validateWorkspace(config);
    let responseText = result.text;
    if (wsWarning) {
      try {
        const parsed = JSON.parse(responseText);
        parsed._workspace_warning = wsWarning;
        responseText = JSON.stringify(parsed);
      } catch { /* non-JSON response, skip */ }
    }

    // H1: Constitution fallback — inject compact constitution if host never read the resource
    const constitutionFallback = getConstitutionFallback();
    if (constitutionFallback) {
      try {
        const parsed = JSON.parse(responseText);
        parsed._constitution = constitutionFallback;
        responseText = JSON.stringify(parsed);
      } catch { /* non-JSON response, skip */ }
    }

    // AH-5: Constitution reinforcement every N calls (if host never reads prompts)
    if (_promptReadCount === 0 && _toolCallCount > 1 && _toolCallCount % REINFORCE_INTERVAL === 0) {
      try {
        const parsed = JSON.parse(responseText);
        parsed._constitution_reminder = 'Orient first (velixar_context), then narrow with one specialized tool. Batch independent ops. Never fabricate data.';
        responseText = JSON.stringify(parsed);
      } catch { /* non-JSON response, skip */ }
    }

    // AH-5: Anti-pattern hint injection
    const antiPatternHint = detectAntiPattern(name);
    if (antiPatternHint) {
      log('info', 'anti_pattern_detected', { tool: name, hint: antiPatternHint });
      try {
        const parsed = JSON.parse(responseText);
        parsed._hint = antiPatternHint;
        responseText = JSON.stringify(parsed);
      } catch { /* non-JSON response, skip */ }
    }

    // Track tool calls for resource staleness; refresh after mutations
    markToolCall();
    trackToolCallForIdentity();
    const mutationTools = new Set([
      'velixar_store', 'velixar_update', 'velixar_delete', 'velixar_distill',
      'velixar_batch_store', 'velixar_import', 'velixar_consolidate', 'velixar_retag',
    ]);
    if (mutationTools.has(name) || isRelevantStale()) {
      refreshRelevantMemories(api, config); // non-blocking
    }

    return {
      content: [{ type: 'text' as const, text: responseText }],
      ...(result.isError ? { isError: true } : {}),
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log('error', 'tool_error', { tool: name, duration_ms: Date.now() - start, error: msg });
    // Build 7.1: Record failed audit
    recordAudit(name, Date.now() - start, args as Record<string, unknown>, false);
    // Alert-level for critical failures — any tool that writes memory state
    const criticalWriteTools = new Set([
      'velixar_store', 'velixar_batch_store', 'velixar_import', 'velixar_upload',
      'velixar_consolidate', 'velixar_distill', 'velixar_update', 'velixar_delete',
    ]);
    if (criticalWriteTools.has(name)) {
      log('error', 'alert:memory_store_failure', { tool: name, error: msg });
    }
    return {
      content: [{ type: 'text' as const, text: `Error: ${msg}` }],
      isError: true,
    };
  }
});

// ── Health Check HTTP Server (optional, standalone mode) ──

const healthPort = process.env.VELIXAR_HEALTH_PORT ? parseInt(process.env.VELIXAR_HEALTH_PORT, 10) : 0;
if (healthPort > 0) {
  const { createServer } = await import('node:http');
  createServer(async (_req, res) => {
    try {
      const health = await api.get<Record<string, unknown>>('/health', true);
      const circuit = (await import('./api.js')).getCircuitState();
      const status = circuit.open ? 503 : 200;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: circuit.open ? 'degraded' : 'ok', circuit, api: health }));
    } catch {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'error' }));
    }
  }).listen(healthPort, () => log('info', 'health_server_started', { port: healthPort }));
}

// ── Start: HTTP or Stdio transport ──

const httpPort = process.env.VELIXAR_MCP_HTTP_PORT ? parseInt(process.env.VELIXAR_MCP_HTTP_PORT, 10) : 0;

if (httpPort > 0) {
  // ── Streamable HTTP transport (for Marco Polo / remote MCP clients) ──
  const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
  const { createServer, IncomingMessage, ServerResponse } = await import('node:http');
  const { randomUUID } = await import('node:crypto');

  // Per-session transports (stateful mode)
  const sessions = new Map<string, InstanceType<typeof StreamableHTTPServerTransport>>();

  const CORS_HEADERS: Record<string, string> = {
    'Access-Control-Allow-Origin': process.env.VELIXAR_MCP_CORS_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id',
    'Access-Control-Expose-Headers': 'Mcp-Session-Id',
  };

  const httpServer = createServer(async (req: InstanceType<typeof IncomingMessage>, res: InstanceType<typeof ServerResponse>) => {
    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }

    // Apply CORS to all responses
    for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v);

    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    // Health endpoint
    if (url.pathname === '/health' && req.method === 'GET') {
      try {
        const health = await api.get<Record<string, unknown>>('/health', true);
        const circuit = (await import('./api.js')).getCircuitState();
        res.writeHead(circuit.open ? 503 : 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: circuit.open ? 'degraded' : 'ok', transport: 'http', sessions: sessions.size, circuit, api: health }));
      } catch {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'error', transport: 'http' }));
      }
      return;
    }

    // MCP endpoint
    if (url.pathname === '/mcp') {
      // Check for existing session
      const sessionId = req.headers['mcp-session-id'] as string | undefined;

      if (req.method === 'POST') {
        // Check if this is an initialize request (new session)
        if (!sessionId) {
          // New session — create transport
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            enableJsonResponse: true,
          });

          // Wire up the server to this transport
          transport.onclose = () => {
            const sid = (transport as any).sessionId;
            if (sid) sessions.delete(sid);
            log('info', 'http_session_closed', { session_id: sid });
          };

          await server.connect(transport);

          // Handle the request — this will set the session ID
          await transport.handleRequest(req, res);

          // Store the transport by session ID
          const sid = res.getHeader('mcp-session-id') as string;
          if (sid) {
            sessions.set(sid, transport);
            log('info', 'http_session_created', { session_id: sid });
          }
          return;
        }

        // Existing session
        const existingTransport = sessions.get(sessionId);
        if (!existingTransport) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Session not found', code: 'SESSION_NOT_FOUND' }));
          return;
        }
        await existingTransport.handleRequest(req, res);
        return;
      }

      if (req.method === 'GET') {
        // SSE stream for server-initiated messages
        if (sessionId && sessions.has(sessionId)) {
          await sessions.get(sessionId)!.handleRequest(req, res);
          return;
        }
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Session ID required for GET' }));
        return;
      }

      if (req.method === 'DELETE') {
        // Session termination
        if (sessionId && sessions.has(sessionId)) {
          const t = sessions.get(sessionId)!;
          await t.handleRequest(req, res);
          sessions.delete(sessionId);
          log('info', 'http_session_terminated', { session_id: sessionId });
          return;
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Session not found' }));
        return;
      }
    }

    // 404 for everything else
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found', endpoints: ['/mcp', '/health'] }));
  });

  httpServer.listen(httpPort, () => {
    log('info', 'http_transport_started', { port: httpPort, endpoint: `/mcp` });
    console.error(`Velixar MCP Server (HTTP) listening on http://localhost:${httpPort}/mcp`);
  });

} else {
  // ── Stdio transport (default, for local MCP clients) ──
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
