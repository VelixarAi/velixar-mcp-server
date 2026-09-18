// A declared derivation edge names a memory by its FULL id.
//
// 2026-09-02: three executive seats, in one day, passed source_ids built from an 8-hex index
// pointer padded to UUID shape. The backend dropped each edge and returned 200 with
// references_dropped populated; this client returned {id, action:'stored'} and threw the
// accounting away. The shape check here is the client-side half; the accounting half
// (references {declared, stored, dropped, truncated} + the LINEAGE INCOMPLETE warning) shipped
// in 1.6.7 and is proven by tests/store-reports-dropped-references.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertMemoryIds, MEMORY_ID_RE } from '../dist/api.js';

const A = '22e42f44-a079-4ac9-be92-17a296d806a5';
const B = '3f233468-c2f2-428c-98c1-c94bf724cfd6';

test('THE DEFECT: an 8-hex index pointer is not an id', () => {
  assert.throws(() => assertMemoryIds(['22e42f44']), /not an id|full memory UUIDs/);
});
test('THE LIMIT, stated: a prefix padded to UUID shape PASSES shape validation', () => {
  // This is the exact value a seat fabricated on 2026-09-02. It is a well-formed UUID, so the
  // client cannot reject it — only the backend knows it names nothing. That is the correct
  // layering: the backend's references_dropped is the load-bearing half, not this regex.
  // A client that "validated" existence would be guessing.
  const padded = '10e33b8f-0000-0000-0000-000000000000';
  assert.deepEqual(assertMemoryIds([padded]), [padded], 'shape check must not pretend to know existence');
});
test('canonical ids pass, any case', () => {
  assert.deepEqual(assertMemoryIds([A, B.toUpperCase()]), [A, B.toUpperCase()]);
  assert.ok(MEMORY_ID_RE.test(A));
});
test('no source_ids is not an error', () => {
  assert.deepEqual(assertMemoryIds(undefined), []);
});
test('a non-string entry is rejected, not coerced', () => {
  assert.throws(() => assertMemoryIds([A, 42]), /full memory UUIDs/);
  assert.throws(() => assertMemoryIds([A, null]), /full memory UUIDs/);
});
test('the rejection names the offending value so the caller can find the real id', () => {
  assert.throws(() => assertMemoryIds(['22e42f44']), /22e42f44/);
});
