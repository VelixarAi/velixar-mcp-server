// A list row must say when its `content` is only part of the memory.
//
// THE DEFECT (measured 2026-09-05 against the live store, on the review-template records):
// `/memory/list` keeps one row per memory by returning the HEAD CHUNK and does not
// reassemble; `velixar_inspect` (GET by id) does. So the two tools return different text
// for the same memory. This client then dropped `is_chunked` and `total_chunks` in
// normalizeMemory's whitelist, so by the time a row reached an agent there was NO signal
// at all — a well-formed record that simply stopped, mid-sentence, with no ellipsis.
//
// Part 4/7 of the template came back as 1,096 of ~2,900 chars. Parts 2 and 7 came back
// WHOLE (they are unchunked), so sampling the surface CONFIRMS it is faithful. Quoting
// from it silently dropped the MEMORY WRITE GATE and cross-volume contamination 3.10.
//
// The verdict is DERIVED here, not merely forwarded, because this client talks to
// whatever backend is deployed — a signal that needs a rollout first stays silent in
// exactly the window where someone is already quoting truncated records.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMemory, contentPartialOf } from '../dist/api.js';

const raw = (o) => ({ id: 'm1', content: 'head chunk only', ...o });

test('THE DEFECT: a chunked row used to reach the agent with no signal', () => {
  const m = normalizeMemory(raw({ total_chunks: 7, is_chunked: true }));
  assert.ok(m.content_partial, 'a partial row must carry the verdict');
  assert.deepEqual(m.content_partial.reason, ['chunking']);
  assert.equal(m.content_partial.chunks_returned, 1);
  assert.equal(m.content_partial.total_chunks, 7);
  assert.match(m.content_partial.full_content_via, /velixar_inspect/);
  assert.match(m.content_partial.full_content_via, /m1/,
    'the pointer must name THIS memory — a generic instruction is one more thing to skim past');
});

test('works against a backend that has not shipped the explicit field yet', () => {
  // No content_truncated in the payload — only total_chunks, which every backend that
  // ever chunked has reported. The verdict must still be reached.
  const p = contentPartialOf(raw({ total_chunks: 3 }));
  assert.ok(p, 'derivation must not depend on a backend rollout');
  assert.deepEqual(p.reason, ['chunking']);
});

test('honours the backend when it DOES state it, including both mechanisms', () => {
  const p = contentPartialOf(raw({
    total_chunks: 4, content_truncated: true,
    content_truncated_by: ['chunking', 'content_max'], content_chunks_returned: 1,
  }));
  assert.deepEqual(p.reason, ['chunking', 'content_max'],
    'a clip the caller asked for must stay distinguishable from one it did not');
});

test('a caller-requested clip on an UNCHUNKED memory names only itself', () => {
  const p = contentPartialOf(raw({ content_truncated: true, content_truncated_by: ['content_max'] }));
  assert.deepEqual(p.reason, ['content_max']);
  assert.equal(p.total_chunks, undefined, 'no chunk count may be invented for an unchunked row');
});

test('NO FALSE ALARMS: a whole memory carries nothing', () => {
  // A control that fires on healthy rows is one readers learn to ignore — which is how
  // the real signal gets lost. Absent, not `false`: a present key always means "there is
  // more", the reading that fails safe.
  assert.equal(contentPartialOf(raw({})), undefined);
  assert.equal(contentPartialOf(raw({ total_chunks: 1 })), undefined, 'one chunk is a whole memory');
  assert.equal(contentPartialOf(raw({ total_chunks: null })), undefined);
  assert.equal(normalizeMemory(raw({})).content_partial, undefined);
});

test('a reassembled search hit is NOT flagged', () => {
  // The search path stitches chunks and then zeroes the markers (routes/memory.py:1373-1375:
  // is_chunked=False, total_chunks=None). Flagging those rows would cry wolf on the one
  // surface that already does the right thing.
  assert.equal(contentPartialOf(raw({ is_chunked: false, total_chunks: null, reassembled: true })), undefined);
});
