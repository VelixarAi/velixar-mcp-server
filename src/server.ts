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
} from '@modelcontextprotocol/sdk/types.js';

import { loadConfig, ApiClient } from './api.js';
import { memoryTools, handleMemoryTool } from './tools/memory.js';
import { systemTools, handleSystemTool } from './tools/system.js';
import { fetchRecall, getResourceList, readResource, getResourceUris } from './resources.js';

// ── Init ──

const config = loadConfig();
const api = new ApiClient(config);

const allTools = [...memoryTools, ...systemTools];
const allToolNames = allTools.map(t => t.name);

const memoryToolNames = new Set(memoryTools.map(t => t.name));
const systemToolNames = new Set(systemTools.map(t => t.name));

// ── Server ──

const server = new Server(
  { name: 'velixar-mcp-server', version: '0.3.0' },
  { capabilities: { tools: {}, resources: {} } },
);

// ── Resources ──

fetchRecall(api, config); // non-blocking startup

server.setRequestHandler(ListResourcesRequestSchema, async () => getResourceList());
server.setRequestHandler(ReadResourceRequestSchema, async (req) => readResource(req.params.uri));

// ── Tools ──

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: allTools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    let result: { text: string; isError?: boolean };

    if (memoryToolNames.has(name)) {
      result = await handleMemoryTool(name, args as Record<string, unknown>, api, config);
    } else if (systemToolNames.has(name)) {
      result = await handleSystemTool(name, args as Record<string, unknown>, api, config, allToolNames, getResourceUris());
    } else {
      return {
        content: [{
          type: 'text' as const,
          text: `Unknown tool: ${name}\n\nNote: Velixar MCP tools are only available in the primary agent context. If you're seeing this in a subagent, memory operations must be handled by the primary agent.`,
        }],
        isError: true,
      };
    }

    return {
      content: [{ type: 'text' as const, text: result.text }],
      ...(result.isError ? { isError: true } : {}),
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: 'text' as const, text: `Error: ${msg}` }],
      isError: true,
    };
  }
});

// ── Start ──

const transport = new StdioServerTransport();
await server.connect(transport);
