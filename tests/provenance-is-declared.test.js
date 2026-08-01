// Provenance is DECLARED, never inferred.
//
// normalizeMemory used to read:
//     derived_from: raw.previous_memory_id ? [raw.previous_memory_id] : undefined
//
// which manufactured a derivation edge out of the TEMPORAL CHAIN. "Stored after" is not
// "reasoned from". Every memory with a predecessor was reported as derived from it — a
// provenance claim no author ever made — while the backend's real author-declared field
// (`references`) was DROPPED by the validator and never surfaced at all.
//
// That is why `inspect` and `lineage` disagreed: lineage walks the real edges; inspect
// showed the invented ones.
//
// Luke caught this exact previous/parent/derived conflation on the WRITE path (source_ids
// collapsed into previous_memory_id[0]). It survived on the read path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMemory } from '../dist/api.js';
import { detectChains } from '../dist/temporal_merge.js';

const raw = (o) => ({ id: 'm1', content: 'c', ...o });

test('THE DEFECT: a temporal predecessor is NOT a derivation', () => {
  const m = normalizeMemory(raw({ previous_memory_id: 'older-memory' }));
  assert.equal(m.provenance.derived_from, undefined,
    'a chain link was reported as declared provenance — the exact fabrication');
  assert.equal(m.provenance.previous_memory_id, 'older-memory',
    'the temporal link must still be available, just not disguised as derivation');
});

test('derived_from comes from the AUTHOR-DECLARED field', () => {
  const m = normalizeMemory(raw({ references: ['a', 'b'], previous_memory_id: 'older' }));
  assert.deepEqual(m.provenance.derived_from, ['a', 'b']);
  assert.equal(m.provenance.previous_memory_id, 'older');
  assert.ok(!m.provenance.derived_from.includes('older'),
    'the temporal predecessor leaked into the derivation set');
});

test('empty references is an auditable ORIGIN state, not a gap', () => {
  const m = normalizeMemory(raw({ references: [] }));
  assert.equal(m.provenance.is_origin, true, 'learned-fresh must be first-class, per the lineage design');
  assert.equal(m.provenance.derived_from, undefined);
});

test('a backend that does not send references makes NO claim either way', () => {
  const m = normalizeMemory(raw({ previous_memory_id: 'x' }));
  assert.equal(m.provenance.is_origin, undefined,
    'absence of the field must not be asserted as is_origin=true — unknown is not a finding');
});

test('BEHAVIOUR PRESERVED: chain detection still works off the temporal link', () => {
  // The provenance fix must not silently change what prepare_context includes. detectChains
  // used to ride the fabricated derived_from; it now reads previous_memory_id directly and
  // must produce the SAME supersession result.
  const mems = [
    normalizeMemory(raw({ id: 'old', created_at: '2026-01-01T00:00:00Z' })),
    normalizeMemory(raw({ id: 'new', previous_memory_id: 'old', created_at: '2026-02-01T00:00:00Z' })),
  ];
  const { supersededBy } = detectChains(mems);
  assert.equal(supersededBy.get('old'), 'new',
    'chain detection broke — the provenance fix silently changed retrieval');
});

test('a DECLARED derivation does not fabricate supersession', () => {
  // Two memories where B cites A as a source but is not a chain successor: citing something
  // is not superseding it.
  const mems = [
    normalizeMemory(raw({ id: 'source', created_at: '2026-01-01T00:00:00Z' })),
    normalizeMemory(raw({ id: 'cites', references: ['source'], created_at: '2026-02-01T00:00:00Z' })),
  ];
  const { supersededBy } = detectChains(mems);
  assert.equal(supersededBy.get('source'), undefined,
    'citing a memory marked it superseded — derivation is not supersession');
});
