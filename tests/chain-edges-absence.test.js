// A COUNT NOBODY MEASURED IS NOT ZERO — and a client may not invent why.
//
// `velixar_context` rendered `overview.temporal_chains || 0` and, whenever that was falsy,
// emitted an empty_sections entry asserting a MECHANISM: "supersession/previous_memory_id
// edges are not being written, so temporal ordering is unavailable". Two failures stacked:
//
//   1. `|| 0` merged "the backend did not report this" with "there are none". `0` is a
//      meaningful value for this metric, so the distinction was unrecoverable downstream.
//   2. The detail asserted a CAUSE the client cannot observe — and it was false. The write
//      path (memory_store_pipeline.py:208) populates previous_memory_id, the atomic chain
//      head was verified live under concurrency, and the very memories returned in the same
//      response carried predecessors. Every agent reading the brief was told temporal
//      ordering was dead while it was live, and that claim propagated into stored reasoning.
//
// Contract, matching the backend's honest shape (FIR-2026-08-18):
//   number (incl. 0) -> report it; a real zero is a FINDING
//   null/absent      -> say "not measured"; never a number, never a cause
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleRecallTool } from '../dist/tools/recall.js';

const config = {
  apiKey: 'vlx_test',
  apiBase: 'https://api.test.invalid',
  workspaceId: 'ws-test',
  timeoutMs: 1000,
  debug: false,
};

function apiWithOverview(overview) {
  return {
    get: async (path) => {
      if (String(path).includes('/exocortex/overview')) return overview;
      if (String(path).includes('contradiction')) return { contradictions: [] };
      return { memories: [], results: [] };
    },
    post: async () => ({ results: [] }),
    patch: async () => ({}),
    delete: async () => ({}),
  };
}

async function brief(overview) {
  const res = await handleRecallTool('velixar_context', {}, apiWithOverview(overview), config);
  // The tool wraps its payload as { text: "<json>" }; the brief is INSIDE that string.
  const text = typeof res === 'string' ? res : (res?.text ?? JSON.stringify(res));
  return { text, parsed: JSON.parse(text) };
}

function emptySections(parsed) {
  const d = parsed?.data ?? parsed;
  return d?.empty_sections ?? [];
}

test('an unmeasured chain count is reported as unknown, not as zero', async () => {
  const { text, parsed } = await brief({ total_memories: 10, cortex_nodes: 5 });

  assert.ok(!/\b0 chain/.test(text),
    'an absent count was rendered as a number — the || 0 collapse is back');

  const s = emptySections(parsed).find((e) => e.section === 'chain_edges');
  assert.ok(s, 'an unmeasured count produced no empty_sections entry at all');
  assert.equal(s.reason, 'not_measured');
});

test('the client never asserts a cause it cannot observe', async () => {
  const { parsed } = await brief({ total_memories: 10 });
  const s = emptySections(parsed).find((e) => e.section === 'chain_edges');

  assert.ok(!/are not being written/i.test(s.detail),
    'the fabricated write-path claim is back');
  assert.ok(/unknown|not\s+report/i.test(s.detail),
    'the reason must state what was OBSERVED (nothing was reported), not why the world is so');
});

test('a genuine zero is reported as a finding, not laundered into unknown', async () => {
  const { parsed } = await brief({ total_memories: 10, chain_edges: 0 });
  assert.equal(emptySections(parsed).find((e) => e.section === 'chain_edges'), undefined,
    'a measured 0 was reported as "not measured" — the fix traded one indistinguishable pair for another');
});

test('a real count is rendered verbatim', async () => {
  const { text } = await brief({ total_memories: 10, chain_edges: 42 });
  assert.match(text, /42 chain edges/);
});

test('the deprecated alias still satisfies the reader while pinned backends serve it', async () => {
  const { text, parsed } = await brief({ total_memories: 10, temporal_chains: 7 });
  assert.match(text, /7 chain edges/);
  assert.equal(emptySections(parsed).find((e) => e.section === 'chain_edges'), undefined);
});
