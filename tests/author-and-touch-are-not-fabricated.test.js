// The author is DERIVED from the backend, never assumed. Touch times are REPORTED, never invented.
//
// normalizeMemory used to read:
//     author: { type: 'user' },
//     updated_at: raw.updated_at || raw.created_at || '',
//     last_touched: raw.created_at || '',
//
// Three fabrications in one object literal, on the read path every consuming model sees:
//
//  1. `author` was a HARDCODED LITERAL. Every memory the server returned — written by
//     agents, connectors, uploads, background workers — was reported as authored by a
//     human. The backend refuses to make that guess on purpose: its provenance module
//     states that "a human-vouched label is the one thing a provenance product must never
//     fabricate", and it ships `source_class` computed from the write path and its
//     principal. That field arrived on EVERY row and the validator DROPPED it, so the
//     client had thrown away the answer and then guessed at the question.
//
//  2. `last_touched` was `created_at` under a second name, asserting an access that never
//     happened. No REST projection emits a touch time at all.
//
//  3. `updated_at` fell back to `created_at`, manufacturing an update event for memories
//     that were never updated.
//
// Absence is a value here, not a gap — the same rule that makes `references: []` mean
// "learned fresh" rather than "missing".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMemory } from '../dist/api.js';

const base = { id: 'm1', content: 'hello', created_at: '2026-08-04T10:00:00Z' };

test('author is derived from source_class, not assumed to be a person', () => {
  assert.equal(normalizeMemory({ ...base, source_class: 'agent' }).author.type, 'agent');
  assert.equal(normalizeMemory({ ...base, source_class: 'session' }).author.type, 'agent');
  // machinery is machinery
  for (const c of ['connected', 'external', 'converged', 'upload']) {
    assert.equal(normalizeMemory({ ...base, source_class: c }).author.type, 'pipeline',
      `source_class=${c} must not be reported as a person`);
  }
});

test('an unclassified memory is UNKNOWN, never "user"', () => {
  // The old code returned { type: 'user' } for every one of these.
  assert.equal(normalizeMemory({ ...base }).author.type, 'unknown');
  assert.equal(normalizeMemory({ ...base, source_class: undefined }).author.type, 'unknown');
  assert.equal(normalizeMemory({ ...base, source_class: 'wat' }).author.type, 'unknown');
  // `unattributed` is the backend's DEFECT MARKER — it must not be laundered into a label.
  assert.equal(normalizeMemory({ ...base, source_class: 'unattributed' }).author.type, 'unknown');
});

test('POSITIVE CONTROL: it still says "user" when the backend actually says so', () => {
  // A fix that can only ever answer "unknown" would pass the tests above while destroying
  // the field's usefulness. This is the assertion that stops that.
  assert.equal(normalizeMemory({ ...base, source_class: 'user' }).author.type, 'user');
});

test('last_touched is absent unless the backend reports one', () => {
  const m = normalizeMemory({ ...base });
  assert.equal(m.provenance.last_touched, undefined,
    'last_touched must not be created_at wearing a second name');
  assert.notEqual(m.provenance.last_touched, base.created_at);
});

test('last_touched passes through when a projection does emit it', () => {
  const m = normalizeMemory({ ...base, last_touched: '2026-08-04T12:00:00Z' });
  assert.equal(m.provenance.last_touched, '2026-08-04T12:00:00Z');
});

test('updated_at is absent for a memory that was never updated', () => {
  const m = normalizeMemory({ ...base });
  assert.equal(m.provenance.updated_at, undefined,
    'updated_at must not fall back to created_at — that manufactures an update event');
});

test('updated_at passes through when the backend sends one', () => {
  const m = normalizeMemory({ ...base, updated_at: '2026-08-04T11:00:00Z' });
  assert.equal(m.provenance.updated_at, '2026-08-04T11:00:00Z');
});

test('created_at is still populated — this fix removes claims, it does not remove data', () => {
  assert.equal(normalizeMemory({ ...base }).provenance.created_at, base.created_at);
});

test('source_type does not default to "user" either — same defect, one function down', () => {
  assert.equal(normalizeMemory({ ...base }).source_type, 'unknown');
  assert.equal(normalizeMemory({ ...base, source_class: 'agent' }).source_type, 'unknown');
  assert.equal(normalizeMemory({ ...base, source_class: 'user' }).source_type, 'user');
  // existing detection must survive
  assert.equal(normalizeMemory({ ...base, type: 'distill' }).source_type, 'distill');
  assert.equal(normalizeMemory({ ...base, type: 'inferred' }).source_type, 'inferred');
});
