// prepare_context must never claim adequacy it cannot demonstrate.
//
// Verified in prod 2026-07-31, on a 2670-memory workspace where velixar_search returned 10
// hits immediately: prepare_context came back with memories_considered 0 at request_ms 3103,
// data_absent true, coverage_check "unavailable" — and STILL emitted
// "Context appears adequate for synthesis" with explicit_gaps: [].
//
// Three separate defects stacked into that one sentence:
//
//   B1  a 3000ms internal race resolved to [] on timeout. [] does not throw, so the catch
//       never fired and the provenance log recorded `results: 0`. A slow search was
//       indistinguishable from an empty corpus. (3103ms ≈ the 3000ms budget.) Every angle
//       issues a /memory/search and search EMBEDS server-side, so three parallel embedding
//       searches routinely blew a 3s budget.
//
//   B2  the adequacy ternary guarded on `coverageRatio !== null && coverageRatio < 0.7`,
//       so UNKNOWN coverage skipped the "incomplete" branch entirely and fell through to
//       adequate. Unknown read as fine.
//
//   B3  zero memories produce zero gaps — because there is nothing to find gaps IN — so
//       absence of evidence became evidence of adequacy.
//
// The invariant: adequacy must be AFFIRMATIVELY KNOWN, never reached by elimination.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleConstructionTool } from '../dist/tools/construction.js';

const config = {
  apiKey: 'vlx_test',
  apiBase: 'https://api.test.invalid',
  workspaceId: 'ws-test',
  timeoutMs: 1000,
  debug: false,
};

function mem(id, content) {
  return { id, content, tags: [], score: 0.7, tier: 2, created_at: '2026-07-01T00:00:00Z' };
}

/** @param opts {{search?:'ok'|'hang'|'error', memories?:any[], coverage?:'ok'|'unavailable', ratio?:number}} */
function api(opts) {
  return {
    get: async () => {
      if (opts.search === 'hang') await new Promise(r => setTimeout(r, 60_000));
      if (opts.search === 'error') throw new Error('boom');
      return { memories: opts.memories ?? [], count: (opts.memories ?? []).length };
    },
    post: async () => {
      if (opts.coverage === 'unavailable') throw new Error('coverage down');
      return { coverage_ratio: opts.ratio ?? 0.95, gaps: [], suggested_queries: [] };
    },
    patch: async () => ({}),
    delete: async () => ({}),
  };
}

async function prepare(opts) {
  const res = await handleConstructionTool(
    'velixar_prepare_context', { intent: 'velixar company overview and current status' },
    api(opts), config);
  const out = JSON.parse(res.text);
  return { ah: out.data.anti_hallucination, meta: out.meta, data: out.data };
}

test('zero memories NEVER reads as adequate', async () => {
  const { ah } = await prepare({ search: 'ok', memories: [], coverage: 'ok' });
  assert.equal(ah.do_not_assert, true, 'zero evidence must set do_not_assert');
  assert.doesNotMatch(ah.instruction, /adequate/i,
    'absence of evidence became evidence of adequacy — the exact prod defect');
  assert.match(ah.instruction, /NO MEMORIES RETRIEVED/);
});

test('UNKNOWN coverage never reads as adequate', async () => {
  const { ah, meta } = await prepare({
    search: 'ok', memories: [mem('m1', 'velixar is a memory layer')], coverage: 'unavailable',
  });
  assert.equal(ah.coverage_verified, false);
  assert.doesNotMatch(ah.instruction, /adequate/i,
    'unverified coverage skipped the incomplete branch and fell through to adequate');
  assert.match(ah.instruction, /could NOT be verified/);
  assert.equal(meta.partial_context, true, 'unknown coverage is partial context, not full');
});

test('a timed-out retrieval is reported as incomplete, NOT as absence', async () => {
  const { ah, meta } = await prepare({ search: 'hang', coverage: 'ok' });
  assert.equal(ah.retrieval_status, 'timeout');
  assert.equal(ah.do_not_assert, true);
  assert.equal(meta.data_absent, false,
    'a lookup that did not finish tells you NOTHING about whether the data exists');
  assert.equal(meta.absence_reason, 'retrieval_incomplete');
  assert.match(ah.instruction, /NOT an empty corpus/);
});

test('an errored retrieval is also incomplete, not absence', async () => {
  const { ah, meta } = await prepare({ search: 'error', coverage: 'ok' });
  assert.equal(ah.retrieval_status, 'error');
  assert.equal(ah.do_not_assert, true);
  assert.equal(meta.data_absent, false);
});

test('THE POSITIVE CONTROL: real evidence + verified coverage still says adequate', async () => {
  // A tool that never says "adequate" is not safe, it is broken — and it would pass every
  // test above. This is the direction that keeps the fix honest.
  const { ah } = await prepare({
    search: 'ok',
    memories: [mem('m1', 'velixar overview'), mem('m2', 'platform architecture')],
    coverage: 'ok', ratio: 0.95,
  });
  assert.equal(ah.do_not_assert, false);
  assert.equal(ah.coverage_verified, true);
  assert.equal(ah.retrieval_status, 'ok');
  assert.match(ah.instruction, /adequate for synthesis/);
});

test('verified-but-LOW coverage says incomplete, not adequate', async () => {
  const { ah } = await prepare({
    search: 'ok', memories: [mem('m1', 'x')], coverage: 'ok', ratio: 0.4,
  });
  assert.equal(ah.do_not_assert, false, 'low coverage is a qualifier, not a refusal');
  assert.match(ah.instruction, /incomplete/i);
});
