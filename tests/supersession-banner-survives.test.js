// The supersession banner survives every layer, and is never fabricated.
//
// The backend (v60+) stamps superseded rows with superseded_by / supersession_status /
// superseded_reason. This client has three places a field can silently die — the
// validator's whitelist (which previously ate source_class, references and origin), the
// toRawMemory projection, and normalizeMemory — and a banner that dies in any of them
// reproduces the exact failure this feature exists to end: retired text presented bare,
// with the reader given no sign that governance already replaced it. The server's READ-
// side exclusion flag is gated on this client rendering the banner, so these tests are
// the flag's precondition, not decoration.
//
// The other direction matters equally: an UNSTAMPED row must carry NO `superseded` key
// at all. Absence means "not superseded" — a null-shaped banner on every row would train
// consumers to ignore the field.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMemory, toRawMemory } from '../dist/api.js';
import { validateSearchResponse } from '../dist/validate.js';

const STAMPED = {
  id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  content: 'an old belief, preserved as history',
  superseded_by: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  supersession_status: 'ratified',
  superseded_reason: 'refuted by measurement',
};

test('the banner survives the search validator', () => {
  const validated = validateSearchResponse({ memories: [STAMPED], count: 1 }, '/memory/search');
  const m = validated.memories[0];
  assert.equal(m.superseded_by, STAMPED.superseded_by);
  assert.equal(m.supersession_status, 'ratified');
  assert.equal(m.superseded_reason, 'refuted by measurement');
});

test('the banner survives toRawMemory (the GET/inspect projection)', () => {
  const raw = toRawMemory(STAMPED);
  assert.equal(raw.superseded_by, STAMPED.superseded_by);
  assert.equal(raw.supersession_status, 'ratified');
});

test('normalizeMemory emits the banner the consuming model reads', () => {
  const mem = normalizeMemory(toRawMemory(STAMPED));
  assert.ok(mem.superseded, 'stamped row must carry a superseded block');
  assert.equal(mem.superseded.by, STAMPED.superseded_by);
  assert.equal(mem.superseded.status, 'ratified');
  assert.equal(mem.superseded.reason, 'refuted by measurement');
});

test('an unstamped row carries NO superseded key — absence is the truthful shape', () => {
  const mem = normalizeMemory(toRawMemory({ id: STAMPED.id, content: 'live memory' }));
  assert.equal('superseded' in mem, false);
});

test('backend nulls (unstamped REST rows) do not manufacture a banner', () => {
  const mem = normalizeMemory(toRawMemory({
    id: STAMPED.id, content: 'live memory',
    superseded_by: null, supersession_status: null, superseded_reason: null,
  }));
  assert.equal('superseded' in mem, false);
});

test('a proposed stamp surfaces as proposed, never upgraded', () => {
  const mem = normalizeMemory(toRawMemory({ ...STAMPED, supersession_status: 'proposed' }));
  assert.equal(mem.superseded.status, 'proposed');
});
