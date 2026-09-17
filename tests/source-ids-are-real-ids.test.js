// A declared derivation edge names a memory by its FULL id, and a store says what it kept.
//
// 2026-09-02: three executive seats, in one day, passed source_ids built from an 8-hex index
// pointer padded to UUID shape. The backend dropped each edge and returned 200 with
// references_dropped populated; this client returned {id, action:'stored'} and threw the
// accounting away. lifecycle's distill went further and REPORTED derived_from: sourceIds while
// never declaring them at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertMemoryIds, referenceAccounting, MEMORY_ID_RE } from '../dist/api.js';

const A = '22e42f44-a079-4ac9-be92-17a296d806a5';
const B = '3f233468-c2f2-428c-98c1-c94bf724cfd6';

test('THE DEFECT: an 8-hex index pointer is not an id', () => {
  assert.throws(() => assertMemoryIds(['22e42f44']), /not an id|full memory UUIDs/);
});
test('THE LIMIT, stated: a prefix padded to UUID shape PASSES shape validation', () => {
  // This is the exact value a seat fabricated on 2026-09-02. It is a well-formed UUID, so the
  // client cannot reject it — only the backend knows it names nothing. That is the correct
  // layering, and it is why the accounting below is the load-bearing half of this fix, not the
  // regex. A client that "validated" existence would be guessing.
  const padded = '10e33b8f-0000-0000-0000-000000000000';
  assert.deepEqual(assertMemoryIds([padded]), [padded], 'shape check must not pretend to know existence');
  const r = referenceAccounting({ references_declared: 1, references_stored: 0, references_dropped: [padded] }, [padded]);
  assert.match(r.warnings[0], /NOT stored/, 'the fabricated edge must be reported, loudly');
  assert.deepEqual(r.stored_ids, [], 'and it must not appear as derived_from');
});
test('canonical ids pass, any case', () => {
  assert.deepEqual(assertMemoryIds([A, B.toUpperCase()]), [A, B.toUpperCase()]);
  assert.ok(MEMORY_ID_RE.test(A));
});
test('no source_ids is not an error', () => {
  assert.deepEqual(assertMemoryIds(undefined), []);
});
test('a well-formed id the backend does not know is REPORTED, not hidden', () => {
  const r = referenceAccounting({ references_declared: 2, references_stored: 1, references_dropped: [B] }, [A, B]);
  assert.deepEqual(r.accounting, { declared: 2, stored: 1, dropped: [B] });
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /NOT stored/);
  assert.deepEqual(r.stored_ids, [A], 'derived_from must be what was STORED, never what was declared');
});
test('a complete write carries accounting and no warning', () => {
  const r = referenceAccounting({ references_declared: 2, references_stored: 2 }, [A, B]);
  assert.deepEqual(r.accounting, { declared: 2, stored: 2 });
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.stored_ids, [A, B]);
});
test('a backend that reports nothing makes the edges UNVERIFIED, loudly', () => {
  const r = referenceAccounting({ id: 'x', stored: true }, [A]);
  assert.match(r.warnings[0], /UNVERIFIED/);
  assert.deepEqual(r.stored_ids, []);
});
test('truncation is named', () => {
  const r = referenceAccounting({ references_declared: 60, references_stored: 50, references_truncated: 10 }, Array(60).fill(A));
  assert.match(r.warnings[0], /beyond the server limit/);
});
