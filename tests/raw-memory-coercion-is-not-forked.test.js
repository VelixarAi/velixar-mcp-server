// The raw→RawMemory field list lives in ONE place.
//
// 1.6.4 fixed `author` in normalizeMemory and shipped with the fix reaching only ONE of the
// surfaces that use it. `velixar_search` returned `author: "agent"` correctly while
// `velixar_inspect` returned `"unknown"` for the same memory — because inspect did not pass
// the server's row to normalizeMemory. It hand-rolled a whitelist of fields first, and that
// whitelist omitted `source_class`. So the normalizer was handed nothing to derive from.
//
// Three call sites (recall/inspect, cognitive/timeline, construction) each maintained their
// own copy of that list, and all three omitted the SAME four fields: source_class,
// references, is_origin, origin. Consequences beyond the author:
//   * declared provenance was dropped, so `derived_from` was always empty on those surfaces
//   * which meant inspect's H17 `derived_from` validation could never fire at all
//
// The unit suite was 116/116 green through every version of this. Only an end-to-end call
// against production caught it, because the defect was in which fields a caller CHOSE to
// forward — invisible to any test that starts downstream of that choice.
//
// A field list maintained in four places drifts in four directions. These tests pin it to one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { toRawMemory, normalizeMemory } from '../dist/api.js';

test('toRawMemory forwards the four fields every hand-rolled list forgot', () => {
  const raw = {
    id: 'm1', content: 'x', created_at: '2026-08-05T00:00:00Z',
    source_class: 'agent',
    references: ['parent-1'],
    is_origin: false,
    origin: { client: 'claude_code', channel: 'mcp', stamped: true },
  };
  const r = toRawMemory(raw);
  assert.equal(r.source_class, 'agent', 'source_class must survive — the author derives from it');
  assert.deepEqual(r.references, ['parent-1'], 'declared provenance must survive');
  assert.equal(r.is_origin, false);
  assert.deepEqual(r.origin, { client: 'claude_code', channel: 'mcp', stamped: true });
});

test('a coerced row yields the DERIVED author, not unknown — the 1.6.4 inspect gap', () => {
  const m = normalizeMemory(toRawMemory({
    id: 'm1', content: 'x', created_at: '2026-08-05T00:00:00Z', source_class: 'agent',
  }));
  assert.equal(m.author.type, 'agent',
    'inspect returned "unknown" here in 1.6.4 while search returned "agent" for the same row');
});

test('declared derived_from survives coercion, so H17 validation can actually fire', () => {
  const m = normalizeMemory(toRawMemory({
    id: 'm1', content: 'x', created_at: '2026-08-05T00:00:00Z', references: ['p1', 'p2'],
  }));
  assert.deepEqual(m.provenance.derived_from, ['p1', 'p2']);
});

test('coercion does not resurrect the fabrications', () => {
  const m = normalizeMemory(toRawMemory({ id: 'm1', content: 'x', created_at: '2026-08-05T00:00:00Z' }));
  assert.equal(m.author.type, 'unknown');
  assert.equal(m.provenance.last_touched, undefined);
  assert.equal(m.provenance.updated_at, undefined);
});

// ── RATCHET ──────────────────────────────────────────────────────────────────────
// The shared function is only worth having if nobody forks it again. A reviewer will not
// notice a fourth whitelist; this will.
test('RATCHET: no caller hand-rolls a field list into normalizeMemory', () => {
  const dir = 'src/tools';
  const offenders = [];
  for (const f of readdirSync(dir).filter(f => f.endsWith('.ts'))) {
    const src = readFileSync(join(dir, f), 'utf8');
    // normalizeMemory({  → an object literal, i.e. a hand-rolled list.
    // normalizeMemory(toRawMemory(x)) and normalizeMemory(x) are both fine.
    if (/normalizeMemory\(\s*\{/.test(src)) offenders.push(f);
  }
  assert.deepEqual(offenders, [],
    `these files build their own RawMemory instead of using toRawMemory(): ${offenders.join(', ')}. ` +
    'That is how source_class, references, is_origin and origin were silently dropped on three surfaces.');
});
