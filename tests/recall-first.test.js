// ── Recall-First / Stewardship mode tests ──
// Verifies the discipline contract is structurally present in the MCP server's
// cognitive-mode and workflow-prompt surfaces. Each test maps to a hardening
// row from RECALL-FIRST-MODE-TASKS.md (R1-R7).

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

const promptsSrc = readFileSync(join(REPO_ROOT, 'src', 'prompts.ts'), 'utf-8');
const contracts = JSON.parse(readFileSync(join(REPO_ROOT, 'tool-contracts.json'), 'utf-8'));

describe('Recall-First / Stewardship mode', () => {
  test('Stewardship is registered in COGNITIVE_MODES', () => {
    assert.ok(
      /\{\s*mode:\s*'Stewardship'/.test(promptsSrc),
      'Expected Stewardship mode in COGNITIVE_MODES; missing means renderModesTable() will not show it'
    );
    assert.ok(
      /Will future sessions need this work/.test(promptsSrc),
      'Expected Stewardship question text'
    );
  });

  test('recall_first workflow prompt is registered', () => {
    assert.ok(
      /name:\s*'recall_first'/.test(promptsSrc),
      'Expected recall_first WorkflowPrompt'
    );
    assert.ok(
      /allPrompts.*recall_first/s.test(promptsSrc),
      'recall_first must be in the allPrompts export array'
    );
  });

  test('R1: workflow prompt declares all 4 phases (recall, act, persist, verify)', () => {
    const recallFirstBlock = promptsSrc.match(
      /const recall_first: WorkflowPrompt = \{[\s\S]*?^\};/m
    );
    assert.ok(recallFirstBlock, 'recall_first block not found');
    const body = recallFirstBlock[0];
    assert.ok(/Phase 1.*RECALL/i.test(body), 'Phase 1 RECALL missing');
    assert.ok(/Phase 2.*ACT/i.test(body), 'Phase 2 ACT missing');
    assert.ok(/Phase 3.*PERSIST/i.test(body), 'Phase 3 PERSIST missing');
    assert.ok(/Phase 4.*VERIFY/i.test(body), 'Phase 4 VERIFY missing');
  });

  test('R2: verify step uses search/inspect (NOT KG/entity)', () => {
    const recallFirstBlock = promptsSrc.match(
      /const recall_first: WorkflowPrompt = \{[\s\S]*?^\};/m
    )[0];
    assert.ok(/velixar_search/.test(recallFirstBlock), 'verify must mention velixar_search');
    assert.ok(/velixar_inspect/.test(recallFirstBlock), 'verify must mention velixar_inspect');
    assert.ok(
      /Do NOT.*KG|entity/i.test(recallFirstBlock),
      'verify step must explicitly ban KG/entity probes (async-indexed)'
    );
  });

  test('R3: do_not_use_when guidance is explicit', () => {
    const recallFirstBlock = promptsSrc.match(
      /const recall_first: WorkflowPrompt = \{[\s\S]*?^\};/m
    )[0];
    assert.ok(
      /DO NOT USE WHEN/i.test(recallFirstBlock),
      'workflow prompt must include DO NOT USE WHEN clause'
    );
    assert.ok(
      /trivial|conversational|read-only/i.test(recallFirstBlock),
      'do_not_use_when must list trivial / conversational / read-only cases'
    );
  });

  test('R5: persist step bans parallel batched velixar_store', () => {
    const recallFirstBlock = promptsSrc.match(
      /const recall_first: WorkflowPrompt = \{[\s\S]*?^\};/m
    )[0];
    assert.ok(
      /sequential/i.test(recallFirstBlock),
      'persist step must require SEQUENTIAL stores (not parallel)'
    );
    assert.ok(
      /not parallel|partial-success|partial[\s-]?failure/i.test(recallFirstBlock),
      'persist step must explain WHY parallel is banned'
    );
  });

  test('R7: act step requires explicit citation of recalled context', () => {
    const recallFirstBlock = promptsSrc.match(
      /const recall_first: WorkflowPrompt = \{[\s\S]*?^\};/m
    )[0];
    assert.ok(
      /cite at least one recalled fact|explicitly cite|"no prior context found"/i.test(recallFirstBlock),
      'act step must require either citation of recalled fact OR explicit no-context assertion (R7: prevents recall from becoming theater)'
    );
  });

  test('contract entry exists for velixar_act', () => {
    assert.ok(
      contracts.contracts.velixar_act,
      'velixar_act contract entry missing in tool-contracts.json'
    );
    const c = contracts.contracts.velixar_act;
    assert.strictEqual(c.cognitive_mode, 'stewardship', 'velixar_act must be in stewardship mode');
    assert.ok(c.use_when, 'use_when required');
    assert.ok(c.do_not_use_when, 'do_not_use_when required');
    assert.ok(c.signal_words && c.signal_words.length > 0, 'signal_words required');
  });

  test('R6: every contract cognitive_mode references a real mode in COGNITIVE_MODES', () => {
    // Extract the modes from the source file (regex scan).
    const modesMatch = promptsSrc.match(/COGNITIVE_MODES = \[([\s\S]*?)\] as const;/);
    assert.ok(modesMatch, 'COGNITIVE_MODES array not found');
    const modeNames = new Set(
      [...modesMatch[1].matchAll(/mode:\s*'(\w+(?:\s\w+)?)'/g)]
        .map(m => m[1].toLowerCase().replace(/\s+/g, '_'))
    );
    // Add aliases that contracts might use:
    modeNames.add('orientation');
    modeNames.add('retrieval');
    modeNames.add('deep_retrieval');
    modeNames.add('structure');
    modeNames.add('continuity');
    modeNames.add('conflict');
    modeNames.add('consolidation');
    modeNames.add('verification');
    modeNames.add('construction');
    modeNames.add('stewardship');

    const orphans = [];
    for (const [tool, c] of Object.entries(contracts.contracts)) {
      const cm = c.cognitive_mode;
      if (cm && !modeNames.has(cm)) {
        orphans.push(`${tool}.cognitive_mode = "${cm}"`);
      }
    }
    assert.deepStrictEqual(
      orphans,
      [],
      `Contracts reference cognitive modes not declared in COGNITIVE_MODES:\n  ${orphans.join('\n  ')}\n\nAdd the mode to COGNITIVE_MODES in src/prompts.ts or fix the contract.`
    );
  });

  test('R4: total prompt size stays under 4 KB to limit token cost', () => {
    const recallFirstBlock = promptsSrc.match(
      /const recall_first: WorkflowPrompt = \{[\s\S]*?^\};/m
    )[0];
    // 4 KB is a soft cap — keeps the prompt re-injectable on every velixar_store
    // without dominating context. R4 hardening row.
    assert.ok(
      recallFirstBlock.length < 4096,
      `recall_first prompt is ${recallFirstBlock.length} bytes; soft cap is 4096 (R4 token-cost guardrail)`
    );
  });
});
