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

import { loadConfig, ApiClient, log } from './api.js';
import { memoryTools, handleMemoryTool } from './tools/memory.js';
import { systemTools, handleSystemTool } from './tools/system.js';
import { recallTools, handleRecallTool } from './tools/recall.js';
import { graphTools, handleGraphTool } from './tools/graph.js';
import { cognitiveTools, handleCognitiveTool } from './tools/cognitive.js';
import { lifecycleTools, handleLifecycleTool } from './tools/lifecycle.js';
import { fetchRecall, getResourceList, readResource, getResourceUris, refreshIdentity, refreshRelevantMemories, markToolCall, isRelevantStale } from './resources.js';
import { getPromptList, getPrompt, allPrompts } from './prompts.js';

// ── Init ──

const config = loadConfig();
const api = new ApiClient(config);

const allTools = [...memoryTools, ...recallTools, ...graphTools, ...cognitiveTools, ...lifecycleTools, ...systemTools];
const allToolNames = allTools.map(t => t.name);

const toolHandlers: Array<{ names: Set<string>; handler: typeof handleMemoryTool }> = [
  { names: new Set(memoryTools.map(t => t.name)), handler: handleMemoryTool },
  { names: new Set(recallTools.map(t => t.name)), handler: handleRecallTool },
  { names: new Set(graphTools.map(t => t.name)), handler: handleGraphTool },
  { names: new Set(cognitiveTools.map(t => t.name)), handler: handleCognitiveTool },
  { names: new Set(lifecycleTools.map(t => t.name)), handler: handleLifecycleTool },
];
const systemToolNames = new Set(systemTools.map(t => t.name));

// ── Server ──

const server = new Server(
  { name: 'velixar-mcp-server', version: '0.5.0' },
  { capabilities: { tools: {}, resources: {}, prompts: {} } },
);

// ── Resources ──

fetchRecall(api, config); // non-blocking startup

server.setRequestHandler(ListResourcesRequestSchema, async () => getResourceList());
server.setRequestHandler(ReadResourceRequestSchema, async (req) => readResource(req.params.uri));

// ── Prompts ──

server.setRequestHandler(ListPromptsRequestSchema, async () => getPromptList());
server.setRequestHandler(GetPromptRequestSchema, async (req) => getPrompt(req.params.name, (req.params.arguments || {}) as Record<string, string>));

// ── Tools ──

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: allTools }));

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

    // Track tool calls for resource staleness; refresh after mutations
    markToolCall();
    const mutationTools = new Set(['velixar_store', 'velixar_update', 'velixar_delete', 'velixar_distill']);
    if (mutationTools.has(name) || isRelevantStale()) {
      refreshRelevantMemories(api, config); // non-blocking
    }

    return {
      content: [{ type: 'text' as const, text: result.text }],
      ...(result.isError ? { isError: true } : {}),
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log('error', 'tool_error', { tool: name, duration_ms: Date.now() - start, error: msg });
    return {
      content: [{ type: 'text' as const, text: `Error: ${msg}` }],
      isError: true,
    };
  }
});

// ── Start ──

const transport = new StdioServerTransport();
await server.connect(transport);
