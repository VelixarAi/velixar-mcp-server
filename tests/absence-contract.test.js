// An empty PAGE is not an empty STORE.
//
// `velixar_list` set `data_absent: items.length === 0` and ignored the cursor. The backend
// bounds a filtered listing (origin filters walk a capped scan), so a page whose rows all
// failed the filter comes back EMPTY while the store is full — and this envelope then told
// the agent its corpus was empty. The agent stops looking. That is the same lie class as a
// false-green health check, and it is what a "what did I do this week" call hit against a
// store holding thousands of rows.
//
// Contract: count == 0 WITH a live cursor means "keep paging", never absence.
//   data_absent    -> only when the scan is genuinely finished (no cursor)
//   absence_reason -> 'filtered_page' when the page is empty but the scan is not
//   more_to_scan   -> surfaced in the DATA so an agent reading only the payload still sees it
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleMemoryTool } from '../dist/tools/memory.js';

const config = {
  apiKey: 'vlx_test',
  apiBase: 'https://api.test.invalid',
  workspaceId: 'ws-test',
  timeoutMs: 1000,
  debug: false,
};

function listApi(body) {
  return {
    get: async () => body,
    post: async () => ({}),
    patch: async () => ({}),
    delete: async () => ({}),
  };
}

async function callList(body) {
  const res = await handleMemoryTool('velixar_list', {}, listApi(body), config);
  return JSON.parse(res.text);
}

test('empty page WITH a cursor is keep-paging, not absence', async () => {
  const out = await callList({ memories: [], count: 0, cursor: 'cur-42' });
  assert.equal(out.meta.data_absent, false,
    'an empty page with a live cursor was reported as absent — the agent stops searching a full store');
  assert.equal(out.meta.absence_reason, 'filtered_page');
  assert.equal(out.data.more_to_scan, true, 'the paging hint must also reach a payload-only reader');
  assert.equal(out.data.cursor, 'cur-42');
});

test('empty page with NO cursor is genuine absence', async () => {
  const out = await callList({ memories: [], count: 0 });
  assert.equal(out.meta.data_absent, true, 'a finished, empty scan IS absence');
  assert.equal(out.meta.absence_reason, 'no_data');
  assert.equal(out.data.more_to_scan, undefined);
});

test('a non-empty page is never absent, cursor or not', async () => {
  const row = { id: 'm-1', content: 'x', tags: [], created_at: '2026-07-01T00:00:00Z' };
  for (const body of [
    { memories: [row], count: 1, cursor: 'cur-1' },
    { memories: [row], count: 1 },
  ]) {
    const out = await callList(body);
    assert.equal(out.meta.data_absent, false);
    assert.equal(out.data.more_to_scan, undefined);
  }
});
