// A DEGRADED READ IS NOT ABSENCE.
//
// Found in prod 2026-08-04. `velixar_search(after=...)` answered:
//     { count: 0, data_absent: true, absence_reason: "no_data" }
// while the REST payload underneath it said:
//     { memories: [], count: 0, _degraded: true,
//       _degraded_reason: "Qdrant unavailable ('>' not supported between instances of
//                          'str' and 'datetime.datetime'), using KG keyword fallback" }
//
// The backend was HONEST — it declared its own read degraded and named the fault. This
// client discarded `_degraded` and `_degraded_reason`, and every tool then computed
// `data_absent: results.length === 0`, reshaping a failed read into a confident,
// affirmative "we looked and found nothing". Per FIELD_DICTIONARY an agent reads absence
// as evidence, so this did not merely fail — it misinformed. `after=2020-01-01`, a bound
// every memory satisfies, reported the store empty.
//
// Contract:
//   data_absent        -> FALSE. We did not learn the data is missing; we learned we
//                         failed to look.
//   absence_reason     -> 'retrieval_incomplete' (the enum already carried exactly this
//                         definition and nothing ever set it from the backend's signal)
//   retrieval_degraded -> the backend's stated reason, verbatim
//   sufficient_answer  -> FALSE, always. Never early-exit on a read that did not happen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMeta, takeDegradedNotice, _setDegradedNoticeForTest } from '../dist/api.js';

const config = { apiKey: 'vlx_test', apiBase: 'https://api.test.invalid', workspaceId: 'ws-test' };

test('a degraded read never reports data_absent', () => {
  _setDegradedNoticeForTest("Qdrant unavailable ('>' not supported between str and datetime)");
  // The tool asks for exactly what the prod bug produced: "zero rows, so no data".
  const meta = makeMeta(config, { data_absent: true });

  assert.equal(meta.data_absent, false,
    'a failed read must not assert that the data is missing');
  assert.equal(meta.absence_reason, 'retrieval_incomplete');
  assert.match(meta.retrieval_degraded, /not supported between/);
  assert.equal(meta.sufficient_answer, false,
    'an agent must never early-exit on a read that did not happen');
  assert.equal(meta.partial_context, true);
});

test('a degraded read overrides an explicit sufficient_answer:true from a tool', () => {
  // The tool computing this cannot see the degradation, so its `true` is exactly the
  // claim being prevented. Order matters: the override runs AFTER the H30 computation.
  _setDegradedNoticeForTest('backend fell back to KG keyword scan');
  const meta = makeMeta(config, { data_absent: false, sufficient_answer: true });
  assert.equal(meta.sufficient_answer, false);
  assert.equal(meta.absence_reason, 'retrieval_incomplete');
});

test('a degraded response with no stated reason still refuses to claim absence', () => {
  _setDegradedNoticeForTest('the backend reported this read as degraded but gave no reason');
  const meta = makeMeta(config, { data_absent: true });
  assert.equal(meta.data_absent, false);
  assert.equal(meta.absence_reason, 'retrieval_incomplete');
  assert.ok(meta.retrieval_degraded);
});

// ----------------------------------------------------------------- negative controls
test('NEGATIVE CONTROL: a healthy empty read still reports genuine absence', () => {
  // Without this, an implementation that hardcoded data_absent:false would pass every
  // assertion above while destroying the signal the envelope exists to carry.
  _setDegradedNoticeForTest(null);
  const meta = makeMeta(config, { data_absent: true });
  assert.equal(meta.data_absent, true, 'a completed read that found nothing IS absence');
  assert.equal(meta.absence_reason, 'no_data');
  assert.equal(meta.retrieval_degraded, undefined);
  assert.equal(meta.sufficient_answer, false); // absent data is still not sufficient
});

test('NEGATIVE CONTROL: a healthy read WITH data is unaffected', () => {
  _setDegradedNoticeForTest(null);
  const meta = makeMeta(config, { data_absent: false, confidence: 1 });
  assert.equal(meta.data_absent, false);
  assert.equal(meta.absence_reason, undefined);
  assert.equal(meta.retrieval_degraded, undefined);
  assert.equal(meta.sufficient_answer, true);
});

test('the notice is take-once, so it cannot leak into the NEXT tool call', () => {
  // A stale degradation flag would caveat healthy responses forever, and an alert that
  // cries wolf gets ignored — which would cost us the signal a second time.
  _setDegradedNoticeForTest('transient');
  assert.equal(takeDegradedNotice(), 'transient');
  assert.equal(takeDegradedNotice(), null, 'consumed exactly once');

  _setDegradedNoticeForTest('first call degraded');
  const degradedMeta = makeMeta(config, { data_absent: true });
  assert.equal(degradedMeta.absence_reason, 'retrieval_incomplete');

  const nextMeta = makeMeta(config, { data_absent: true });
  assert.equal(nextMeta.data_absent, true, 'the next call must be judged on its own read');
  assert.equal(nextMeta.absence_reason, 'no_data');
  assert.equal(nextMeta.retrieval_degraded, undefined);
});
