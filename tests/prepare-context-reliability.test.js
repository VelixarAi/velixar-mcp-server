// prepare_context reliability fixes (2026-09-30), found by using the tool on a live Foundry stream:
//  R1 one slow angle discarded every angle (all-or-nothing race) -> per-angle deadlines, 'partial'
//  R2 identical content under two ids was included twice -> content dedupe, newest kept
//  R3 key_decisions repeated memories already in current_state -> no repeats
//  R4 weak matches rode into the package -> relevance floor relative to the best match
//  R5 the first section could exceed the token budget -> budget-respecting assembly
//  R6 a coverage timeout left no provenance entry -> every outcome logged
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleConstructionTool } from '../dist/tools/construction.js';
const config = { apiKey: 'vlx_test', apiBase: 'https://api.test.invalid', workspaceId: 'ws-test', timeoutMs: 1000, debug: false };
const mem = (id, content, score = 0.8, created = '2026-09-01T00:00:00Z') => ({ id, content, tags: [], score, tier: 2, created_at: created });
function api({ byQuery = {}, hang = [], coverage = 'ok' }) {
  return {
    get: async (path) => {
      const q = decodeURIComponent((path.match(/[?&]q=([^&]*)/) || [])[1] || '').replace(/\+/g, ' ');
      if (hang.includes(q)) await new Promise(r => setTimeout(r, 30_000));
      const ms = byQuery[q] ?? [];
      return { memories: ms, count: ms.length };
    },
    post: async () => {
      if (coverage === 'hang') await new Promise(r => setTimeout(r, 30_000));
      if (coverage === 'down') throw new Error('coverage down');
      return { coverage_ratio: 0.9, gaps: [], suggested_queries: [] };
    },
    patch: async () => ({}), delete: async () => ({}),
  };
}
async function prepare(a, args) {
  const r = await handleConstructionTool('velixar_prepare_context', { intent: 'fixture add-on round under the CISO conditions', ...args }, api(a), config);
  return JSON.parse(r.text);
}
const body = (o) => o.data ?? o;

test('R1 a slow angle does not discard the angles that answered', { timeout: 40_000 }, async () => {
  const o = body(await prepare({ byQuery: { a: [mem('m1', 'alpha fact')], b: [mem('m2', 'beta fact')] }, hang: ['c'] }, { queries: ['a', 'b', 'c'] }));
  assert.equal(o.anti_hallucination.retrieval_status, 'partial');
  assert.equal(o.retrieval_metadata.memories_included, 2);
  assert.match(o.anti_hallucination.instruction, /PARTIAL RETRIEVAL/);
  const step = o.provenance.steps.find(s => s.step === 'multi_search');
  // the intent is always searched too, so four angles: intent, a, b (ok) and c (timeout)
  assert.deepEqual(step.angles.map(x => x.status).sort(), ['ok', 'ok', 'ok', 'timeout']);
});
test('R1 every angle timing out is still a timeout, never empty', { timeout: 40_000 }, async () => {
  const o = body(await prepare({ hang: ['a', 'b', 'fixture add-on round under the CISO conditions'] }, { queries: ['a', 'b'] }));
  assert.equal(o.anti_hallucination.retrieval_status, 'timeout'); assert.equal(o.anti_hallucination.do_not_assert, true);
});
test('R2 identical content under two ids is included once, newest kept', async () => {
  const o = body(await prepare({ byQuery: { a: [mem('old', 'same checkpoint text', 0.8, '2026-09-01T00:00:00Z'), mem('new', 'same  checkpoint text ', 0.8, '2026-09-02T00:00:00Z'), mem('m3', 'other fact')] } }, { queries: ['a'] }));
  const ids = o.context_package.sections.flatMap(s => s.memory_ids);
  assert.ok(ids.includes('new') && !ids.includes('old'));
  assert.equal(o.retrieval_metadata.duplicates_removed, 1);
});
test('R3 key_decisions never repeats a memory already in current_state', async () => {
  const o = body(await prepare({ byQuery: { a: [mem('d1', 'The founder decided X'), mem('d2', 'We decided Y')] } }, { queries: ['a'] }));
  const cur = o.context_package.sections.find(s => s.label === 'current_state')?.memory_ids ?? [];
  const dec = o.context_package.sections.find(s => s.label === 'key_decisions')?.memory_ids ?? [];
  assert.equal(cur.filter(id => dec.includes(id)).length, 0);
});
test('R4 weak matches fall below the relevance floor; forced includes survive it', async () => {
  const o = body(await prepare({ byQuery: { a: [mem('strong', 'on-topic', 0.9), mem('weak', 'unrelated review', 0.2), mem('forced', 'weak but required', 0.1)] } }, { queries: ['a'], include_ids: ['forced'] }));
  const ids = o.context_package.sections.flatMap(s => s.memory_ids);
  assert.ok(ids.includes('strong') && !ids.includes('weak') && ids.includes('forced'));
  assert.equal(o.retrieval_metadata.below_relevance_floor, 1);
});
test('R5 the package respects its token budget', async () => {
  const big = Array.from({ length: 8 }, (_, i) => mem(`b${i}`, `record ${i} `.repeat(600), 0.8));
  const o = body(await prepare({ byQuery: { a: big } }, { queries: ['a'], token_budget: 1500 }));
  assert.ok(o.context_package.token_count <= 1500, `token_count ${o.context_package.token_count}`);
  assert.ok(o.context_package.sections[0].truncated);
});
test('R6 a coverage timeout is recorded in provenance', { timeout: 40_000 }, async () => {
  const o = body(await prepare({ byQuery: { a: [mem('m1', 'x')] }, coverage: 'hang' }, { queries: ['a'] }));
  const step = o.provenance.steps.find(s => s.step === 'coverage_check');
  assert.equal(step?.status, 'timeout'); assert.equal(o.anti_hallucination.coverage_verified, false);
});

test('R7 the intent itself is always searched, and unused budget is filled with next-ranked memories', async () => {
  const intent = 'fixture add-on round under the CISO conditions';
  const many = Array.from({ length: 14 }, (_, i) => mem(`r${i}`, `relevant record ${i} ` + 'x'.repeat(200), 0.8 - i * 0.01));
  const o = body(await prepare({ byQuery: { [intent]: many } }, { queries: ['unmatched keyword'] }));
  const ids = o.context_package.sections.flatMap(s => s.memory_ids);
  assert.ok(ids.length > 8, `only ${ids.length} memories included with budget left`);
  assert.ok(o.context_package.sections.some(s => s.label === 'related'));
});
test('R8 the unknowns line counts against the hard budget', async () => {
  const big = Array.from({ length: 12 }, (_, i) => mem(`u${i}`, `record ${i} `.repeat(500), 0.8));
  const o = body(await prepare({ byQuery: { a: big } }, { queries: ['a'], token_budget: 2000 }));
  assert.ok(o.context_package.token_count <= 2000, `token_count ${o.context_package.token_count}`);
});
