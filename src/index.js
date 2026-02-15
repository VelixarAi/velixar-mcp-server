#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const API_KEY = process.env.VELIXAR_API_KEY;
const API_BASE = process.env.VELIXAR_API_URL || "https://t4xrnwgo7f.execute-api.us-east-1.amazonaws.com/v1";
const USER_ID = process.env.VELIXAR_USER_ID || "kiro-cli";

if (!API_KEY) {
  console.error("VELIXAR_API_KEY environment variable required");
  process.exit(1);
}

async function apiRequest(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      "authorization": `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  return res.json();
}

const server = new Server(
  { name: "velixar-mcp-server", version: "0.1.1" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "velixar_store",
      description: "Store a memory for later retrieval. Use for important facts, user preferences, project context, or anything worth remembering.",
      inputSchema: {
        type: "object",
        properties: {
          content: { type: "string", description: "The memory content to store" },
          tags: { type: "array", items: { type: "string" }, description: "Optional tags for categorization" },
          tier: { type: "number", description: "Memory tier: 0=pinned, 1=session, 2=semantic, 3=org" },
        },
        required: ["content"],
      },
    },
    {
      name: "velixar_search",
      description: "Search stored memories by semantic similarity. Use to recall past context, preferences, or facts.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          limit: { type: "number", description: "Max results (default 5)" },
        },
        required: ["query"],
      },
    },
    {
      name: "velixar_delete",
      description: "Delete a memory by ID.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Memory ID to delete" },
        },
        required: ["id"],
      },
    },
    {
      name: "velixar_list",
      description: "List memories with pagination support.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max results (default 10)" },
          cursor: { type: "string", description: "Pagination cursor" },
        },
        required: [],
      },
    },
    {
      name: "velixar_update",
      description: "Update an existing memory.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Memory ID to update" },
          content: { type: "string", description: "New content" },
          tags: { type: "array", items: { type: "string" }, description: "New tags" },
        },
        required: ["id"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === "velixar_store") {
      const result = await apiRequest("/memory", {
        method: "POST",
        body: JSON.stringify({
          content: args.content,
          user_id: USER_ID,
          tier: args.tier || 2,
          tags: args.tags || [],
        }),
      });
      if (result.error) throw new Error(result.error);
      return { content: [{ type: "text", text: `✓ Stored memory` }] };
    }

    if (name === "velixar_search") {
      const params = new URLSearchParams({ q: args.query, user_id: USER_ID });
      if (args.limit) params.set("limit", String(args.limit));
      const result = await apiRequest(`/memory/search?${params}`);
      if (result.error) throw new Error(result.error);
      
      if (!result.memories?.length) {
        return { content: [{ type: "text", text: "No memories found." }] };
      }
      const memories = result.memories.map((m) => `• ${m.content}`).join("\n");
      return { content: [{ type: "text", text: `Found ${result.count} memories:\n${memories}` }] };
    }

    if (name === "velixar_delete") {
      const result = await apiRequest(`/memory/${args.id}`, { method: "DELETE" });
      if (result.error) throw new Error(result.error);
      return { content: [{ type: "text", text: `✓ Deleted memory: ${args.id}` }] };
    }

    if (name === "velixar_list") {
      const params = new URLSearchParams({ user_id: USER_ID });
      if (args.limit) params.set("limit", String(args.limit));
      if (args.cursor) params.set("cursor", args.cursor);
      const result = await apiRequest(`/memory/list?${params}`);
      if (result.error) throw new Error(result.error);
      
      if (!result.memories?.length) {
        return { content: [{ type: "text", text: "No memories found." }] };
      }
      const memories = result.memories.map((m) => `• ${m.id}: ${m.content.substring(0, 100)}...`).join("\n");
      const cursor = result.cursor ? `\nNext cursor: ${result.cursor}` : "";
      return { content: [{ type: "text", text: `Found ${result.count} memories:${cursor}\n${memories}` }] };
    }

    if (name === "velixar_update") {
      const body = { user_id: USER_ID };
      if (args.content) body.content = args.content;
      if (args.tags) body.tags = args.tags;
      const result = await apiRequest(`/memory/${args.id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      if (result.error) throw new Error(result.error);
      return { content: [{ type: "text", text: `✓ Updated memory: ${args.id}` }] };
    }

    return { content: [{ type: "text", text: `Unknown tool: ${name}` }] };
  } catch (error) {
    return { content: [{ type: "text", text: `Error: ${error.message}` }] };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
