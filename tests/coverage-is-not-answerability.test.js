// A retrieval-completeness number must never be phrased as permission to synthesize.
//
// WHY (2026-08-01). velixar_coverage_check told callers "Coverage is adequate for
// synthesis." whenever coverage_ratio >= 0.7. But coverage_ratio is
//
//     |retrieved ∩ broad_search(topic)| / |broad_search(topic)|
//
// i.e. RETRIEVAL COMPLETENESS. The denominator is how much the corpus has to say about
// the topic, so a topic the corpus knows LITTLE about yields FEWER broad hits, a SMALLER
// denominator, and therefore a HIGHER ratio. The message licensed synthesis precisely
// when the corpus was least able to support it.
//
// Measured on LoCoMo (n=25 per class): mean coverage_ratio 0.536 where the answer was
// ABSENT vs 0.464 where it was PRESENT — inverted. And it cannot be rescued by a
// threshold: top-hit similarity was 0.4563 (absent) vs 0.4446 (present), with the best
// possible single threshold classifying at 52%, i.e. chance. Adversarial questions are
// built to be semantically indistinguishable from answerable ones.
//
// Same defect class as the prepare_context adequacy claim (C1.d) — fixed there, missed
// here, because the two live in different files and nothing connected them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/tools/retrieval.ts', import.meta.url), 'utf8');

test('THE DEFECT: high coverage no longer reads as permission to synthesize', () => {
  assert.ok(!/'Coverage is adequate for synthesis\.'/.test(src),
    'a completeness ratio is again being presented as synthesis adequacy');
});

test('the high-coverage message explicitly disclaims answerability', () => {
  const m = src.match(/coverage_ratio >= 0\.7\s*\?\s*'([^']+)'/);
  assert.ok(m, 'the >= 0.7 branch changed shape — re-verify its wording by hand');
  assert.match(m[1], /does NOT establish|verify each claim/,
    `high-coverage message must disclaim answerability, got: ${m[1]}`);
});

test('confidence_assessment names RETRIEVAL, never bare confidence', () => {
  // A bare "high" under a field called confidence_assessment reads as confidence in the
  // ANSWER. Every value must say which thing it is assessing.
  assert.ok(!/'high — most relevant context retrieved'/.test(src),
    'a bare "high" confidence label is back');
  assert.match(src, /retrieval-complete/,
    'confidence values must name retrieval explicitly');
});

test('POSITIVE CONTROL: the useful half of the signal still works', () => {
  // Warnings that delete the signal are not a fix. LOW coverage genuinely means "fetch
  // more", and that advice must survive.
  assert.match(src, /consider retrieving more context/,
    'the low-coverage guidance was lost');
  assert.match(src, /do not synthesize from memory/,
    'the null-coverage (no relevant memories) guard was lost');
});

test('the reasoning is recorded where the next reader will hit it', () => {
  // The inversion is counterintuitive; without the WHY, someone reinstates the old
  // wording because it reads better.
  assert.match(src, /RETRIEVAL COMPLETENESS/,
    'the explanation of what coverage_ratio measures is missing');
  assert.match(src, /0\.536|ABSENT/,
    'the measurement that proves the inversion is missing');
});
