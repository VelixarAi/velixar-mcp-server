// A CAVEAT THAT DOES NOT TRAVEL WITH ITS NUMBER IS NOT A CAVEAT.
//
// `GET /graph/stats` returns `relationship_count` as a WARM-CACHE LOWER BOUND — a cold
// process reports 0 — and ships `relationship_count_note` plus `edges_in_store` alongside
// it precisely so the number cannot be misread. The backend comment says why: someone had
// already read "3,741 entities, 8 relationships" as "relationship extraction is dead"
// while Cosmos held 10k+ edges.
//
// This client's projection dropped both fields. On 2026-08-26 that produced a fresh
// instance of the same misreading — "4,309 entities, 155 relationships, arithmetically
// inconsistent with the write path" — which was escalated as a commercial finding about a
// paid feature before anyone found the note sitting in the API response.
//
// Contract:
//   note/edges_in_store present upstream -> MUST appear downstream
//   absent upstream                      -> MUST stay absent; never synthesised
//   wrong type                           -> dropped, never crashes
//   fallback path                        -> carries its own client-asserted provenance
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleGraphTool } from '../dist/tools/graph.js';

const config = {
  apiKey: 'vlx_test',
  apiBase: 'https://api.test.invalid',
  workspaceId: 'ws-test',
  timeoutMs: 1000,
  debug: false,
};

function apiWithStats(stats, { failStats = false } = {}) {
  return {
    get: async (path) => {
      if (String(path).includes('/graph/stats')) {
        if (failStats) throw new Error('stats unavailable');
        return stats;
      }
      return {};
    },
    post: async () => ({ nodes: [{ entity_type: 'person' }], edges: [{}, {}] }),
    patch: async () => ({}),
    delete: async () => ({}),
  };
}

async function stats(api) {
  const res = await handleGraphTool('velixar_graph_stats', {}, api, config);
  const text = typeof res === 'string' ? res : (res?.text ?? JSON.stringify(res));
  return JSON.parse(text);
}

const FULL = {
  entity_count: 4309,
  relationship_count: 155,
  top_entity_types: [{ type: 'entity', count: 1673 }],
  relationship_count_note: 'warm-cache lower bound for THIS workspace; cold process = 0',
  edges_in_store: 10432,
};

test('the note travels with the number it qualifies', async () => {
  const out = await stats(apiWithStats(FULL));
  const d = out.data ?? out;
  assert.equal(d.relationship_count, 155);
  assert.equal(
    d.relationship_count_note,
    'warm-cache lower bound for THIS workspace; cold process = 0',
    'the caveat was stripped — this is the defect this test exists for',
  );
});

test('edges_in_store — the real persistent total — is passed through', async () => {
  const d = (await stats(apiWithStats(FULL))).data ?? (await stats(apiWithStats(FULL)));
  assert.equal(d.edges_in_store, 10432);
  // The whole point: 155 and 10,432 are different quantities and BOTH must be visible,
  // or the smaller one reads as the graph.
  assert.notEqual(d.edges_in_store, d.relationship_count);
});

test('an absent note is absent, never synthesised', async () => {
  const out = await stats(apiWithStats({
    entity_count: 10, relationship_count: 3, top_entity_types: [],
  }));
  const d = out.data ?? out;
  assert.equal(d.relationship_count, 3);
  assert.equal('relationship_count_note' in d, false,
    'a client must not invent a caveat the server did not send');
  assert.equal('edges_in_store' in d, false);
});

test('a wrong-typed note is dropped rather than propagated or crashing', async () => {
  const out = await stats(apiWithStats({
    entity_count: 1, relationship_count: 1, top_entity_types: [],
    relationship_count_note: { not: 'a string' },
    edges_in_store: 'not a number',
  }));
  const d = out.data ?? out;
  assert.equal('relationship_count_note' in d, false);
  assert.equal('edges_in_store' in d, false);
  assert.equal(d.entity_count, 1);
});

test('the fallback path declares that it measured a different thing', async () => {
  const out = await stats(apiWithStats(null, { failStats: true }));
  const d = out.data ?? out;
  assert.equal(d._fallback, true);
  assert.match(String(d._fallback_note), /1-hop|traverse/i,
    'the fallback counts reachable nodes/edges — a THIRD quantity — and must say so');
  // _fallback said the PATH differed. It never said the MEANING differed.
  assert.notEqual(d._fallback_note, undefined);
});
