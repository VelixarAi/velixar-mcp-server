// The response cache must not outlive a mutation.
//
// It did. The 60s TTL cache in api.ts was only ever written and read — no
// code path invalidated it. Live repro (2026-07-15, session 7efe8099):
// inspect → update → inspect returned the PRE-update content at 1ms;
// inspect after DELETE returned the full deleted row instead of the
// tombstone. The backend was correct both times; the client cache lied.
//
// Contract: any non-GET request (POST/PATCH/PUT/DELETE) clears the response
// cache — on success, and on exhausted retries too (a timed-out mutation may
// still have landed server-side).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiClient } from '../dist/api.js';

const config = {
  apiKey: 'vlx_test',
  apiBase: 'https://api.test.invalid',
  workspaceId: 'ws-test',
  timeoutMs: 1000,
  debug: false,
};

// Serve a version counter so each real fetch returns distinguishable content.
function fakeBackend() {
  const state = { version: 1, calls: [] };
  globalThis.fetch = async (url, opts) => {
    state.calls.push({ url: String(url), method: (opts?.method || 'GET') });
    return new Response(
      JSON.stringify({ memory: { id: 'm1', content: `v${state.version}` } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  };
  return state;
}

test('control: cacheable GET is actually served from cache', async () => {
  const state = fakeBackend();
  const client = new ApiClient(config);
  const a = await client.get('/memory/m1?ctl=1', true);
  state.version = 2;
  const b = await client.get('/memory/m1?ctl=1', true);
  assert.equal(a.memory.content, 'v1');
  // Same content despite the backend moving on — the cache is live. Without
  // this control, the invalidation tests below could pass vacuously if
  // caching were simply removed.
  assert.equal(b.memory.content, 'v1');
  assert.equal(state.calls.length, 1);
});

test('PATCH invalidates cached reads', async () => {
  const state = fakeBackend();
  const client = new ApiClient(config);
  const before = await client.get('/memory/m1?case=patch', true);
  assert.equal(before.memory.content, 'v1');

  state.version = 2;
  await client.patch('/memory/m1?case=patch', { content: 'new' });

  const after = await client.get('/memory/m1?case=patch', true);
  assert.equal(after.memory.content, 'v2',
    'inspect after update must refetch, not serve the pre-update row');
});

test('DELETE invalidates cached reads', async () => {
  const state = fakeBackend();
  const client = new ApiClient(config);
  const before = await client.get('/memory/m1?case=del', true);
  assert.equal(before.memory.content, 'v1');

  state.version = 2; // backend now serves the tombstone shape
  await client.delete('/memory/m1?case=del');

  const after = await client.get('/memory/m1?case=del', true);
  assert.equal(after.memory.content, 'v2',
    'inspect after delete must refetch, not serve the deleted row');
});

test('POST invalidates cached reads (store changes list/search results)', async () => {
  const state = fakeBackend();
  const client = new ApiClient(config);
  const before = await client.get('/memory/list?case=post', true);
  assert.equal(before.memory.content, 'v1');

  state.version = 2;
  await client.post('/memory?case=post', { content: 'brand new row' });

  const after = await client.get('/memory/list?case=post', true);
  assert.equal(after.memory.content, 'v2',
    'list after store must refetch, not serve the pre-store page');
});
