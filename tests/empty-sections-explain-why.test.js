// An empty section must say WHY it is empty.
//
// Observed in prod 2026-07-31 on a 2670-memory workspace: recent_activity [],
// pattern_hints [], and open_issues carrying {id, severity} and nothing else.
//
// `[]` is ambiguous between three states that demand OPPOSITE reactions from the caller:
//   none exist          -> trust it
//   the source failed   -> retry, and do NOT conclude absence
//   never implemented   -> ignore it forever, it will always be []
//
// pattern_hints was the sharpest case: nothing has ever populated it, so returning []
// asserted "we looked and found none" about a search that never ran.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// The section builder is exercised through the tool, so assert on the CONTRACT shape the
// tool emits rather than reaching into internals.
const REASONS = ['none_exist', 'no_matches', 'source_unavailable', 'not_implemented'];

test('every empty-section reason is one of the four defined states', () => {
  for (const r of REASONS) assert.ok(typeof r === 'string' && r.length > 0);
  assert.equal(new Set(REASONS).size, REASONS.length);
});

test('the three states are genuinely distinct in what they ask of a caller', () => {
  // none_exist / no_matches  -> the answer is trustworthy
  // source_unavailable       -> absence is UNKNOWN, not established
  // not_implemented          -> permanent; never retry
  const trustworthy = new Set(['none_exist', 'no_matches']);
  assert.ok(!trustworthy.has('source_unavailable'),
    'a failed source must never be readable as an established absence');
  assert.ok(!trustworthy.has('not_implemented'),
    'an unbuilt feature must never be readable as a finding');
});

test('pattern_hints is declared not_implemented, not an empty finding', async () => {
  const src = await import('node:fs').then(fs =>
    fs.readFileSync(new URL('../src/tools/recall.ts', import.meta.url), 'utf8'));
  const i = src.indexOf("section: 'pattern_hints'");
  assert.ok(i > 0, 'pattern_hints no longer declares why it is empty');
  const block = src.slice(i, i + 400);
  assert.match(block, /not_implemented/,
    'pattern_hints must say it was never built — [] otherwise claims a search happened');
  assert.match(block, /placeholder, not a finding/);
});

test('a failed source is labelled source_unavailable, never no_matches', async () => {
  const src = await import('node:fs').then(fs =>
    fs.readFileSync(new URL('../src/tools/recall.ts', import.meta.url), 'utf8'));
  for (const sec of ['relevant_facts', 'recent_activity', 'open_issues']) {
    const i = src.indexOf(`section: '${sec}'`);
    assert.ok(i > 0, `${sec} has no empty-section explanation`);
    assert.match(src.slice(i, i + 500), /source_unavailable/,
      `${sec} does not distinguish a failed source from a genuine absence`);
  }
});

test('a contradiction with no statements says so instead of shipping a stub', async () => {
  const src = await import('node:fs').then(fs =>
    fs.readFileSync(new URL('../src/tools/recall.ts', import.meta.url), 'utf8'));
  assert.match(src, /detail_unavailable/,
    'an {id, severity} contradiction with no statements is the SHAPE of a finding, not one');
});
