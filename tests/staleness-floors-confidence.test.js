// Staleness must FLOOR confidence, not be averaged away.
//
// Verified in prod 2026-07-31: velixar_context returned 10 evidence items, EVERY one
// tagged freshness "stale", so evidence_freshness resolved to 0 — and the verdict was
// still level "high", score 0.75.
//
// The arithmetic explains it exactly:
//
//   strength 1×0.30 + consistency 1×0.25 + freshness 0×0.20
//     + (1−contradictionPressure 0.333)×0.15 + derivation 1×0.10  =  0.75
//
// which is precisely the `high` threshold. Freshness at its WORST POSSIBLE VALUE cost only
// its 0.2 weight, and the dimensions that happened to look good carried the total over the
// line. A scored dimension pinned at rock bottom contributed nothing to the outcome.
//
// A weighted sum lets any single dimension be outvoted. Some dimensions must not be
// outvotable: if everything you know is old, you do not get to be confident about it. No
// quantity of stale evidence, however internally consistent, makes a claim current.
//
// So freshness sets a CEILING on the score instead of contributing a share of it:
//   freshness == 0    -> at most 0.49  (`low`)     nothing recent OR aging
//   freshness < 0.5   -> at most 0.74  (`medium`)  mostly stale
//   otherwise         -> uncapped
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeConfidence } from '../dist/justify.js';

const ev = (n, freshness) => Array.from({ length: n }, (_, i) => ({
  memory_id: `m${i}`, excerpt: 'x', evidence_class: 'direct', freshness, workspace_id: 'ws',
}));

test('THE PROD CASE: 10 all-stale items + 1 contradiction is no longer "high"', () => {
  const c = computeConfidence(ev(10, 'stale'), 1);
  assert.notEqual(c.level, 'high',
    'the exact payload observed in prod still resolves to high — staleness is still being averaged away');
  assert.equal(c.level, 'low');
  assert.ok(c.score <= 0.49, `score ${c.score} exceeds the all-stale ceiling`);
  // and the raw score is preserved, so the old behaviour is visible rather than erased
  assert.equal(c.raw_score, 0.75, 'the pre-cap score should still be reported for audit');
});

test('a cap is never silent', () => {
  const c = computeConfidence(ev(10, 'stale'), 0);
  assert.equal(c.freshness_capped, true);
  assert.ok(typeof c.raw_score === 'number');
  assert.match(c.reason, /stale/i,
    'a reader seeing low confidence over consistent evidence will assume the scorer is broken unless the reason says age limited it');
});

test('NO QUANTITY of stale evidence buys confidence', () => {
  // the failure mode in one line: more agreeing-but-old evidence must not climb the ladder
  const small = computeConfidence(ev(3, 'stale'), 0);
  const huge = computeConfidence(ev(500, 'stale'), 0);
  assert.equal(huge.level, small.level);
  assert.ok(huge.score <= 0.49, 'piling on stale evidence escaped the ceiling');
});

test('mostly-stale caps at medium, not low', () => {
  const c = computeConfidence([...ev(2, 'recent'), ...ev(8, 'stale')], 0);
  assert.equal(c.level, 'medium');
  assert.equal(c.freshness_capped, true);
});

test('THE POSITIVE CONTROL: fresh evidence is untouched', () => {
  // A scorer that can never say "high" is not cautious, it is broken — and it would pass
  // every test above. This is the direction that keeps the fix honest.
  const c = computeConfidence(ev(10, 'recent'), 0);
  assert.equal(c.level, 'high');
  assert.equal(c.freshness_capped, undefined, 'fresh evidence must not be capped');
  assert.equal(c.raw_score, undefined);
});

test('half-recent is enough to lift the cap entirely', () => {
  const c = computeConfidence([...ev(5, 'recent'), ...ev(5, 'stale')], 0);
  assert.equal(c.level, 'high');
  assert.equal(c.freshness_capped, undefined);
});

test('the cap lowers, never raises', () => {
  // guards against a ceiling accidentally becoming a floor
  for (const f of ['recent', 'aging', 'stale']) {
    for (const n of [1, 5, 50]) {
      const c = computeConfidence(ev(n, f), 0);
      if (c.raw_score !== undefined) {
        assert.ok(c.score <= c.raw_score, `${f}/${n}: cap raised the score`);
      }
    }
  }
});

test('empty evidence is still the floor case, not a cap artifact', () => {
  const c = computeConfidence([], 0);
  assert.ok(['low', 'unstable'].includes(c.level));
});
