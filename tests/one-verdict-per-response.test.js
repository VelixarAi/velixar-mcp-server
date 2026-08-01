// A response may carry ONE confidence verdict, not two that disagree.
//
// Observed in prod 2026-07-31, inside a SINGLE velixar_context payload:
//
//     meta.sufficient_answer:            false
//     justification.presentation_mode:  "confident_summary"
//
// The envelope said insufficient; the payload said confident. An FIR §3.5 violation
// (confidence must survive every boundary hop) — and the dangerous half is which one a
// model reads. Given two signals, a model asserting an answer will take the confident one.
//
// They disagreed because they are computed independently and never meet: makeMeta derives
// sufficient_answer from data_absent/partial_context/contradictions/confidence, while
// resolvePresentation derives the mode from claim type + confidence profile. wrapResponse is
// the one place both exist at once, so that is where they are reconciled — envelope
// authoritative, payload CAPPED (never raised), and the cap made visible.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wrapResponse } from '../dist/api.js';

const config = { apiKey: 'k', apiBase: 'https://x.invalid', workspaceId: 'ws', timeoutMs: 1000, debug: false };
const withMode = (mode) => ({ justification: { presentation_mode: mode, claim: 'x' } });

test('THE PROD CASE: sufficient_answer=false can no longer carry confident_summary', () => {
  const out = wrapResponse(withMode('confident_summary'), config, { confidence: 0.4 });
  assert.equal(out.meta.sufficient_answer, false);
  assert.notEqual(out.data.justification.presentation_mode, 'confident_summary',
    'the envelope says insufficient and the payload still claims confidence — the exact prod defect');
  assert.equal(out.data.justification.presentation_mode, 'tentative_synthesis');
});

test('a cap is never silent', () => {
  const out = wrapResponse(withMode('assertive'), config, { confidence: 0.2 });
  assert.equal(out.data.justification.presentation_capped_from, 'assertive');
  assert.match(out.data.justification.presentation_capped_reason, /sufficient_answer=false/);
});

test('data_absent is absolute — nothing to be confident ABOUT', () => {
  const out = wrapResponse(withMode('assertive'), config, { data_absent: true });
  assert.equal(out.data.justification.presentation_mode, 'do_not_assert');
  assert.match(out.data.justification.presentation_capped_reason, /data_absent/);
});

test('THE POSITIVE CONTROL: a genuinely sufficient answer keeps its confidence', () => {
  // A reconciler that always downgrades is not safe, it is broken — and it would pass every
  // test above. This is the direction that keeps the fix honest.
  const out = wrapResponse(withMode('assertive'), config, { confidence: 0.95 });
  assert.equal(out.meta.sufficient_answer, true);
  assert.equal(out.data.justification.presentation_mode, 'assertive');
  assert.equal(out.data.justification.presentation_capped_from, undefined);
});

test('the cap LOWERS, never raises', () => {
  // an already-cautious payload must not be promoted to meet a confident envelope
  const out = wrapResponse(withMode('cautious'), config, { confidence: 0.99 });
  assert.equal(out.data.justification.presentation_mode, 'cautious');
  assert.equal(out.data.justification.presentation_capped_from, undefined);
});

test('every mode is ranked — an unranked mode would silently bypass the cap', () => {
  for (const m of ['assertive', 'confident_summary', 'tentative_synthesis', 'cautious', 'exploratory', 'do_not_assert']) {
    const out = wrapResponse(withMode(m), config, { data_absent: true });
    assert.equal(out.data.justification.presentation_mode, 'do_not_assert',
      `mode ${m} escaped the data_absent ceiling`);
  }
});

test('payloads without a justification are untouched', () => {
  const out = wrapResponse({ items: [1, 2, 3] }, config, { data_absent: true });
  assert.deepEqual(out.data, { items: [1, 2, 3] });
});
