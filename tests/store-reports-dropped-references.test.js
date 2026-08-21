// A store that lost half its lineage must not look like a clean one.
//
// `velixar_store` built its response from scratch as { id, action: 'stored' } no matter what
// the backend returned, and `validateStoreResponse` returned `{ id }` and discarded the rest.
// Two strip points, one line apart, neither guarded by a test.
//
// The backend (v74+) reports exactly which declared references it could not resolve and how
// many it truncated past the server cap. That accounting died at this client, so an agent
// storing through MCP was told "stored" while its derivation graph was quietly wrong.
//
// This is not hypothetical and it is not rare: BOTH production instances were MCP writes,
// ten minutes apart, by an author who was at that moment writing records ABOUT this defect.
//   997cc582 — 4 declared, 3 stored (a short id padded into UUID shape)
//   1b24f1bb — 3 declared, 2 stored (the record written to CORRECT the first, same mistake)
// Neither was noticed at the call site. Both were found only by re-reading the stored row
// and counting. That is what this file exists to make unnecessary.
//
// Contract:
//   caller declared nothing        -> response shape is UNCHANGED (additive only)
//   declared, all stored           -> counts reported, NO warning (must not cry wolf)
//   declared, some lost            -> counts + the ids + a prose warning naming the loss
//   backend silent (old/dedup path)-> report NOTHING; absence means UNKNOWN, never "clean"
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

const REAL = '11111111-1111-4111-8111-111111111111';
const GHOST = '00000000-0000-0000-0000-000000000000';

function storeApi(postBody) {
  return {
    get: async () => ({ memories: [], count: 0 }),   // similarity probe: nothing similar
    post: async () => postBody,
    patch: async () => ({}),
    delete: async () => ({}),
  };
}

async function callStore(args, postBody) {
  const res = await handleMemoryTool('velixar_store', args, storeApi(postBody), config);
  return JSON.parse(res.text);
}

test('a dropped reference is NAMED in the response, not just logged server-side', async () => {
  const out = await callStore(
    { content: 'B was built on A', source_ids: [REAL, GHOST] },
    { id: 'new-1', stored: true, references_declared: 2, references_stored: 1,
      references_dropped: [GHOST] },
  );
  assert.equal(out.data.id, 'new-1');
  assert.equal(out.data.references.declared, 2);
  assert.equal(out.data.references.stored, 1);
  assert.deepEqual(out.data.references.dropped, [GHOST],
    'the caller cannot distinguish 2-of-2 from 1-of-2 without re-reading the row it wrote');
  assert.match(out.data.warning, /LINEAGE INCOMPLETE/,
    'a field an agent can skim past is not a signal — losses must be stated in prose');
  assert.match(out.data.warning, new RegExp(GHOST), 'the warning must name WHICH edge was lost');
});

test('truncation past the server cap is reported', async () => {
  const out = await callStore(
    { content: 'a rollup with many sources', source_ids: [REAL] },
    { id: 'new-2', stored: true, references_declared: 171, references_stored: 50,
      references_truncated: 121 },
  );
  assert.equal(out.data.references.truncated, 121);
  assert.match(out.data.warning, /121 beyond the server cap/);
});

test('POSITIVE CONTROL: a clean store reports counts and does NOT cry wolf', async () => {
  const out = await callStore(
    { content: 'x', source_ids: [REAL] },
    { id: 'new-3', stored: true, references_declared: 1, references_stored: 1 },
  );
  assert.equal(out.data.references.stored, 1);
  assert.equal(out.data.references.dropped, undefined);
  assert.equal(out.data.warning, undefined,
    'warning on a complete write would train agents to ignore it');
});

test('a store declaring NO lineage keeps its exact previous shape', async () => {
  const out = await callStore({ content: 'no lineage' }, { id: 'new-4', stored: true });
  assert.equal(out.data.action, 'stored');
  assert.equal(out.data.references, undefined, 'additive only — an ordinary store is untouched');
  assert.equal(out.data.warning, undefined);
});

test('a SILENT backend reports nothing — absence is UNKNOWN, never "nothing dropped"', async () => {
  // Pre-v74 backend, or the dedup early-return path, which omits the keys entirely.
  // Inventing "0 dropped" here would be the same lie one layer up.
  const out = await callStore(
    { content: 'x', source_ids: [REAL, GHOST] },
    { id: 'new-5', stored: true },
  );
  assert.equal(out.data.references, undefined,
    'the client must not manufacture an accounting the backend did not provide');
  assert.equal(out.data.warning, undefined);
});

test('counts come from the BACKEND, never recomputed from source_ids.length', async () => {
  // The caller declared 2. The backend says it stored 1. If the client recomputed `stored`
  // from what was SENT it would report 2 — asserting success from the attempt, which is the
  // defect this whole chain is about.
  const out = await callStore(
    { content: 'x', source_ids: [REAL, GHOST] },
    { id: 'new-6', stored: true, references_declared: 2, references_stored: 1,
      references_dropped: [GHOST] },
  );
  assert.equal(out.data.references.stored, 1,
    'reported stored-count must be the backend’s, not the length of what was sent');
});
