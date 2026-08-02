// The capability list must describe STATE, not intent.
//
// WHY (2026-08-01). Every entry in `velixar_capabilities.features` was the literal `true`.
// Nothing measured any of them, so the list was a CLAIM presented as a report — and it
// stayed `true` while capabilities were dead. Verified against prod that day:
//   identity  true, while snapshot_count/thought_trace_count were 0 (its only writer lived
//             in an SQS Lambda; the platform had moved off AWS, so it never ran).
//   patterns  true, while velixar_patterns ITSELF returns not_implemented. The capability
//             list contradicted the tool in the same process.
// A flag that cannot be false is not a report.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/tools/system.ts', import.meta.url), 'utf8');
const block = src.slice(src.indexOf('features: {'), src.indexOf('features_note'));

test('patterns is NOT advertised while the tool declares not_implemented', () => {
  assert.match(block, /patterns:\s*false/,
    'velixar_patterns returns not_implemented; advertising it as true is a contradiction');
});

test('capabilities that cannot be proven do not claim a bare true', () => {
  for (const [name, expected] of [['identity', /'opt_in'/], ['timeline', /'org_memories_only'/],
                                  ['contradictions', /'detection_only'/]]) {
    const line = block.split('\n').find(l => l.trim().startsWith(`${name}:`));
    assert.ok(line, `${name} missing from the features block`);
    assert.match(line, expected, `${name} must name its limitation, not claim true`);
  }
});

test('POSITIVE CONTROL: verified capabilities still report true', () => {
  // A list that says false to everything is not honest, it is useless.
  for (const name of ['graph', 'justification', 'audit_log', 'workspace_isolation']) {
    const line = block.split('\n').find(l => l.trim().startsWith(`${name}:`));
    assert.match(line, /true/, `${name} is verified in prod and must still report true`);
  }
});

test('the semantics are stated in the payload, not only in a comment', () => {
  assert.match(src, /features_note/);
  assert.match(src, /verified to produce output/);
});
