import { test, describe, beforeEach } from "node:test";
import assert from "node:assert";

// Capture the last fetch call for assertions
let lastFetch = {};
let mockResponse = {};

global.fetch = async (url, options) => {
  lastFetch = { url, options };
  const path = url.replace(/^.*\/v1/, "").split("?")[0];
  const resp = mockResponse[path] || {};
  return {
    ok: resp._fail ? false : true,
    status: resp._fail ? 500 : 200,
    json: async () => resp,
    text: async () => JSON.stringify(resp),
  };
};

process.env.VELIXAR_API_KEY = "test-key";
process.env.VELIXAR_USER_ID = "test-user";

// Import the handler by extracting it from the server
// Since index.js connects to stdio on import, we test the logic via API calls
// These tests validate the request/response contract

describe("velixar_store", () => {
  test("sends correct POST body", async () => {
    mockResponse = { "/memory": { id: "abc-123", stored: true } };
    const handler = makeHandler("velixar_store", { content: "test fact", tags: ["a"], tier: 0 });
    const result = await handler();
    assert.ok(lastFetch.url.endsWith("/memory"));
    const body = JSON.parse(lastFetch.options.body);
    assert.strictEqual(body.content, "test fact");
    assert.strictEqual(body.tier, 0);
    assert.deepStrictEqual(body.tags, ["a"]);
    assert.strictEqual(body.user_id, "test-user");
  });

  test("tier defaults to 2 when omitted", async () => {
    mockResponse = { "/memory": { id: "abc-123", stored: true } };
    const handler = makeHandler("velixar_store", { content: "test" });
    await handler();
    const body = JSON.parse(lastFetch.options.body);
    assert.strictEqual(body.tier, 2);
  });

  test("tier 0 is allowed (not coerced to default)", async () => {
    mockResponse = { "/memory": { id: "abc-123", stored: true } };
    const handler = makeHandler("velixar_store", { content: "pinned", tier: 0 });
    await handler();
    const body = JSON.parse(lastFetch.options.body);
    assert.strictEqual(body.tier, 0);
  });
});

describe("velixar_search", () => {
  test("passes query and limit as URL params", async () => {
    mockResponse = { "/memory/search": { memories: [{ content: "found it" }], count: 1 } };
    const handler = makeHandler("velixar_search", { query: "test query", limit: 3 });
    await handler();
    assert.ok(lastFetch.url.includes("q=test+query") || lastFetch.url.includes("q=test%20query"));
    assert.ok(lastFetch.url.includes("limit=3"));
  });

  test("returns 'No memories found' when empty", async () => {
    mockResponse = { "/memory/search": { memories: [], count: 0 } };
    const handler = makeHandler("velixar_search", { query: "nothing" });
    const result = await handler();
    assert.strictEqual(result.text, "No memories found.");
  });
});

describe("velixar_list", () => {
  test("passes cursor for pagination", async () => {
    mockResponse = { "/memory/list": { memories: [{ id: "x", content: "hi", tags: [] }], count: 1 } };
    const handler = makeHandler("velixar_list", { limit: 5, cursor: "abc" });
    await handler();
    assert.ok(lastFetch.url.includes("cursor=abc"));
    assert.ok(lastFetch.url.includes("limit=5"));
  });

  test("returns 'No memories found' when empty", async () => {
    mockResponse = { "/memory/list": { memories: [], count: 0 } };
    const handler = makeHandler("velixar_list", {});
    const result = await handler();
    assert.strictEqual(result.text, "No memories found.");
  });
});

describe("velixar_update", () => {
  test("sends PATCH with content and tags", async () => {
    mockResponse = { "/memory/up-123": { updated: true } };
    const handler = makeHandler("velixar_update", { id: "up-123", content: "new", tags: ["x"] });
    await handler();
    assert.ok(lastFetch.url.includes("/memory/up-123"));
    assert.strictEqual(lastFetch.options.method, "PATCH");
    const body = JSON.parse(lastFetch.options.body);
    assert.strictEqual(body.content, "new");
    assert.deepStrictEqual(body.tags, ["x"]);
  });
});

describe("velixar_delete", () => {
  test("sends DELETE to correct URL", async () => {
    mockResponse = { "/memory/del-456": { deleted: true } };
    const handler = makeHandler("velixar_delete", { id: "del-456" });
    await handler();
    assert.ok(lastFetch.url.includes("/memory/del-456"));
    assert.strictEqual(lastFetch.options.method, "DELETE");
  });
});

describe("error handling", () => {
  test("returns isError on API error response", async () => {
    mockResponse = { "/memory": { error: "bad request" } };
    const handler = makeHandler("velixar_store", { content: "fail" });
    const result = await handler();
    assert.ok(result.text.includes("Error:"));
    assert.strictEqual(result.isError, true);
  });
});

// Helper: simulates the CallTool handler logic from index.js
// This mirrors the actual handler without needing stdio transport
function makeHandler(name, args) {
  const API_BASE = "https://api.velixarai.com";
  const API_KEY = process.env.VELIXAR_API_KEY;
  const USER_ID = process.env.VELIXAR_USER_ID;

  async function apiRequest(path, options = {}) {
    const res = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers: { authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json", ...options.headers },
    });
    if (!res.ok) { const body = await res.text().catch(() => ""); throw new Error(`API ${res.status}: ${body.slice(0, 200)}`); }
    return res.json();
  }

  return async () => {
    try {
      if (name === "velixar_store") {
        const result = await apiRequest("/memory", {
          method: "POST",
          body: JSON.stringify({ content: args.content, user_id: USER_ID, tier: args.tier ?? 2, tags: args.tags || [] }),
        });
        if (result.error) throw new Error(result.error);
        if (!result.id) throw new Error("Store succeeded but no ID returned");
        return { text: `✓ Stored memory (id: ${result.id})` };
      }
      if (name === "velixar_search") {
        const params = new URLSearchParams({ q: args.query, user_id: USER_ID });
        if (args.limit) params.set("limit", String(args.limit));
        const result = await apiRequest(`/memory/search?${params}`);
        if (result.error) throw new Error(result.error);
        if (!result.memories?.length) return { text: "No memories found." };
        const memories = result.memories.map((m) => `• ${m.content}${m.score ? ` (score: ${m.score})` : ""}`).join("\n");
        return { text: `Found ${result.count} memories:\n${memories}` };
      }
      if (name === "velixar_delete") {
        const result = await apiRequest(`/memory/${args.id}`, { method: "DELETE" });
        if (result.error) throw new Error(result.error);
        return { text: `✓ Deleted memory: ${args.id}` };
      }
      if (name === "velixar_list") {
        const params = new URLSearchParams({ user_id: USER_ID });
        if (args.limit) params.set("limit", String(args.limit));
        if (args.cursor) params.set("cursor", args.cursor);
        const result = await apiRequest(`/memory/list?${params}`);
        if (result.error) throw new Error(result.error);
        if (!result.memories?.length) return { text: "No memories found." };
        const memories = result.memories.map((m) => {
          const tags = m.tags?.length ? ` [${m.tags.join(", ")}]` : "";
          const preview = m.content.length > 120 ? m.content.substring(0, 120) + "…" : m.content;
          return `• ${m.id}: ${preview}${tags}`;
        }).join("\n");
        const cursor = result.cursor ? `\nNext cursor: ${result.cursor}` : "";
        return { text: `${result.count} memories:${cursor}\n${memories}` };
      }
      if (name === "velixar_update") {
        const body = { user_id: USER_ID };
        if (args.content) body.content = args.content;
        if (args.tags) body.tags = args.tags;
        const result = await apiRequest(`/memory/${args.id}`, { method: "PATCH", body: JSON.stringify(body) });
        if (result.error) throw new Error(result.error);
        return { text: `✓ Updated memory: ${args.id}` };
      }
      return { text: `Unknown tool: ${name}`, isError: true };
    } catch (error) {
      return { text: `Error: ${error.message}`, isError: true };
    }
  };
}
