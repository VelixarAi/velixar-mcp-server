// The contradictions surface reads the TABLE's column names, not this tool's vocabulary.
//
// `/exocortex/contradictions` serves `select("*")`, so the writer's columns arrive verbatim
// and nothing in the backend ever renamed them. The mapping read `memory_a_id` /
// `explanation` — names no writer has ever produced — so every substantive field came back
// `''` while `confidence` and `detected_at`, which happen to share a name, came through
// populated. The tool reported that a contradiction existed and could say nothing about it.
//
// The row below is RECORDED FROM THE REAL WRITER (contradiction_detector.py:190 inserts
// exactly workspace_id / left_memory_id / right_memory_id / reason / confidence / status)
// and from a live prod call. It is a fixture with provenance, not an invented shape — a
// fixture recorded from our own mock would round-trip the client against itself.
//
// Note what is DELIBERATELY ABSENT: `severity`. The column exists and no producer writes it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleCognitiveTool } from '../dist/tools/cognitive.js';

const config = {
  apiKey: 'vlx_test',
  apiBase: 'https://api.test.invalid',
  workspaceId: 'ws-test',
  timeoutMs: 1000,
  debug: false,
};

const REAL_ROW = {
  id: 'eaf6cea2-59c3-4d69-ac9a-904b6196ab00',
  workspace_id: 'ws-test',
  left_memory_id: 'mem-tampa',
  right_memory_id: 'mem-reno',
  reason: 'mutually exclusive locations for the same single property',
  confidence: 0.9,
  status: 'open',
  detected_at: '2026-07-24T19:00:39.571952+00:00',
};

function apiWith(rows) {
  return {
    get: async () => ({ contradictions: rows }),
    post: async () => ({}),
    patch: async () => ({}),
    delete: async () => ({}),
  };
}

async function listWith(rows, args = {}) {
  const res = await handleCognitiveTool('velixar_contradictions', args, apiWith(rows), config);
  return JSON.parse(res.text).data;
}

test('the detector reason reaches the caller as explanation', async () => {
  const data = await listWith([REAL_ROW]);
  const [item] = data.evidence;
  assert.equal(item.explanation, 'mutually exclusive locations for the same single property');
});

test('both memory ids resolve, so velixar_inspect chaining actually works', async () => {
  // The tool's own next_step has always said "use velixar_inspect on linked memory IDs".
  // It was unfollowable: both ids were ''.
  const [item] = (await listWith([REAL_ROW])).evidence;
  assert.equal(item.memory_id_a, 'mem-tampa');
  assert.equal(item.memory_id_b, 'mem-reno');
});

test('statements are OMITTED, never emitted as empty strings', async () => {
  // No statement text exists anywhere in the pipeline — the detector stores two ids and a
  // reason, never the sentences. '' would assert "the statement is empty"; absence says
  // "we are not supplying this".
  const [item] = (await listWith([REAL_ROW])).evidence;
  assert.equal(item.statement_a, undefined);
  assert.equal(item.statement_b, undefined);
  assert.ok(!('statement_a' in item), 'the key must be absent, not present-and-empty');
});

test('severity is derived from confidence and SAYS that it was derived', async () => {
  const [item] = (await listWith([REAL_ROW])).evidence;
  assert.equal(item.severity, 'high', '0.9 confidence is not "medium"');
  assert.equal(item.severity_derived_from, 'confidence');
});

test('a STORED severity wins over a derived one', async () => {
  // NEGATIVE CONTROL for the test above: an implementation that always derived would pass
  // it while discarding a human judgement the number cannot express.
  const [item] = (await listWith([{ ...REAL_ROW, severity: 'low' }])).evidence;
  assert.equal(item.severity, 'low');
  assert.equal(item.severity_derived_from, undefined);
});

// ------------------------------------------------------------------ THE FALSIFIER
test('severity_min=0.75 RETURNS a 0.9-confidence contradiction', async () => {
  // This is the defect with a consequence. `severity` was defaulted to 'medium' when
  // absent, and severity_min filtered on that fabrication: medium -> 0.5, so a real
  // 0.9-confidence contradiction was dropped by severity_min=0.75 on the strength of a
  // severity nobody assigned — while `confidence`, the number that would have answered
  // correctly, sat in the same row being shadowed by it.
  const data = await listWith([REAL_ROW], { severity_min: 0.75 });
  assert.equal(data.evidence.length, 1, 'a high-confidence conflict must survive its own threshold');
  assert.equal(data.evidence[0].id, REAL_ROW.id);
});

test('NEGATIVE CONTROL: severity_min still excludes a genuinely weak row', async () => {
  // Without this, a filter that returned everything would satisfy the falsifier above.
  const weak = { ...REAL_ROW, id: 'weak', confidence: 0.3 };
  const data = await listWith([weak], { severity_min: 0.75 });
  assert.equal(data.evidence.length, 0);
});

test('a row carrying neither severity nor confidence is KEPT, not silently dropped', async () => {
  // A filter must not use absence as grounds for exclusion — that is the same move as
  // reading an empty result as a measured negative.
  const bare = { id: 'bare', left_memory_id: 'a', right_memory_id: 'b', reason: 'x',
                 detected_at: REAL_ROW.detected_at, status: 'open' };
  const data = await listWith([bare], { severity_min: 0.9 });
  assert.equal(data.evidence.length, 1);
});

// ------------------------------------------------------------------ topic filtering
test('topic matches against the reason text', async () => {
  // topic searched statement_a/statement_b/explanation — all three ALWAYS EMPTY under the
  // old mapping — so it could never match and reported the miss as a clean empty result.
  const data = await listWith([REAL_ROW], { topic: 'locations' });
  assert.equal(data.evidence.length, 1);
});

test('NEGATIVE CONTROL: a topic that genuinely does not match returns nothing', async () => {
  const data = await listWith([REAL_ROW], { topic: 'quarterly revenue forecast' });
  assert.equal(data.evidence.length, 0);
});

// ------------------------------------------------------------------ the class guard
test('no mapping reads a column the writer does not produce', async () => {
  // The producer's INSERT is the contract. Any field this client reads off a raw row must
  // be one the writer actually writes, or an explicitly-documented fallback. This is the
  // narrow form of the generator named in FIR-2026-08-03-contradictions-contract; it pins
  // THIS instance while the generated mapping remains outstanding.
  const WRITER_COLUMNS = new Set([
    'id', 'workspace_id', 'left_memory_id', 'right_memory_id', 'reason',
    'confidence', 'status', 'detected_at', 'severity', 'resolution',
  ]);
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/tools/cognitive.ts', import.meta.url), 'utf-8');
  const block = src.slice(src.indexOf('THE FIELD NAMES COME FROM THE TABLE'),
                          src.indexOf('const activeContradictions'));
  const reads = [...block.matchAll(/\bc\.([a-z_]+)/g)].map(m => m[1]);
  const unknown = [...new Set(reads)].filter(f => !WRITER_COLUMNS.has(f)
    // documented legacy fallbacks, kept deliberately and harmlessly
    && !['memory_a_id', 'memory_b_id', 'explanation', 'description', 'created_at'].includes(f));
  assert.deepEqual(unknown, [], `reads columns no writer produces: ${unknown}`);
});
