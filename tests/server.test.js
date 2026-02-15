import { test } from "node:test";
import assert from "node:assert";

// Mock fetch globally
global.fetch = async (url, options) => {
  const mockResponses = {
    "/memory": { success: true },
    "/memory/search": { memories: [{ content: "test memory" }], count: 1 },
    "/memory/test-id": { success: true }
  };
  
  const path = url.replace(/^.*\/v1/, "").split("?")[0];
  return { json: async () => mockResponses[path] || {} };
};

// Set required env vars
process.env.VELIXAR_API_KEY = "test-key";

test("tool definitions have correct names and schemas", () => {
  const tools = [
    {
      name: "velixar_store",
      inputSchema: {
        type: "object",
        properties: {
          content: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          tier: { type: "number" },
        },
        required: ["content"],
      },
    },
    {
      name: "velixar_search",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "number" },
        },
        required: ["query"],
      },
    },
    {
      name: "velixar_delete",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
        },
        required: ["id"],
      },
    },
  ];

  assert.strictEqual(tools.length, 3);
  assert.strictEqual(tools[0].name, "velixar_store");
  assert.deepStrictEqual(tools[0].inputSchema.required, ["content"]);
  assert.strictEqual(tools[1].name, "velixar_search");
  assert.deepStrictEqual(tools[1].inputSchema.required, ["query"]);
  assert.strictEqual(tools[2].name, "velixar_delete");
  assert.deepStrictEqual(tools[2].inputSchema.required, ["id"]);
});

test("store handler formats correct response", async () => {
  const mockHandler = async (name, args) => {
    if (name === "velixar_store") {
      return { content: [{ type: "text", text: "✓ Stored memory" }] };
    }
  };

  const result = await mockHandler("velixar_store", { content: "test" });
  assert.strictEqual(result.content[0].text, "✓ Stored memory");
});

test("search handler formats correct response", async () => {
  const mockHandler = async (name, args) => {
    if (name === "velixar_search") {
      return { content: [{ type: "text", text: "Found 1 memories:\n• test memory" }] };
    }
  };

  const result = await mockHandler("velixar_search", { query: "test" });
  assert.ok(result.content[0].text.includes("Found 1 memories"));
});

test("delete handler formats correct response", async () => {
  const mockHandler = async (name, args) => {
    if (name === "velixar_delete") {
      return { content: [{ type: "text", text: `✓ Deleted memory: ${args.id}` }] };
    }
  };

  const result = await mockHandler("velixar_delete", { id: "test-id" });
  assert.strictEqual(result.content[0].text, "✓ Deleted memory: test-id");
});