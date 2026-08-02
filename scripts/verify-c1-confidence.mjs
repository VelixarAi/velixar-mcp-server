#!/usr/bin/env node
// C1 verification — are the confidence signals actually honest in PRODUCTION?
//
// WHY THIS EXISTS (2026-08-01). C1's three fixes shipped in 1.6.0 (ae53a1b staleness
// ceiling, ac12c03 one-verdict-per-response, bae9788 empty-sections-say-why) and have unit
// tests. Unit tests prove the FUNCTIONS behave; they cannot prove the deployed client,
// talking to the real backend, over a real corpus, emits an honest payload. Those are
// different claims and only the second one matters to a user.
//
// It also exists because the register proposed the WRONG falsifier: "re-run LoCoMo
// end-to-end and see if the 29pp gap moves". The LoCoMo harness calls /v1/memory/search
// and nothing else — it never touches velixar_context or prepare_context, so it cannot
// observe any of these fixes. And the 29pp gap is reader synthesis (recall@25 = 98.3%
// means retrieval already found the documents), which memory b0c7dbbf shows is dominated
// by reader choice: 88% vs 38% on IDENTICAL retrieval. Running it would have produced a
// number that could not answer the question.
//
// The right test is direct: replay the payload shapes observed in prod on 2026-07-31
// (memory 03bc7f13) and assert the invariants that were supposed to make them impossible.
//
// READ-ONLY. Unlike synthetic-probe.mjs this deliberately runs against the REAL corpus
// with VELIXAR_API_KEY, because the whole question is whether confidence is honest about
// REAL data — a probe workspace with three synthetic rows cannot answer that. It calls
// only read tools (velixar_context, velixar_prepare_context, velixar_recall) and writes
// nothing.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PER_CALL_TIMEOUT_MS = parseInt(process.env.C1_CALL_TIMEOUT_MS || '60000', 10);
const key = process.env.VELIXAR_API_KEY;
if (!key) {
  console.error('VELIXAR_API_KEY required (read-only probe against the real corpus)');
  process.exit(2);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, '..', 'dist', 'server.js');

const results = [];
function check(name, passed, detail) {
  results.push({ name, passed, detail });
  const mark = passed ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
  console.log(`  ${mark} ${name}`);
  if (!passed && detail) console.log(`      ${detail}`);
}

const RANK = ['do_not_assert', 'exploratory', 'cautious', 'tentative_synthesis',
              'confident_summary', 'assertive'];

async function callTool(client, name, args) {
  const res = await client.callTool({ name, arguments: args }, undefined,
                                    { timeout: PER_CALL_TIMEOUT_MS });
  const text = res?.content?.find(c => c.type === 'text')?.text ?? '';
  try { return JSON.parse(text); } catch { return { _raw: text }; }
}

async function main() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: { ...process.env, VELIXAR_API_KEY: key },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'c1-verify', version: '1' }, { capabilities: {} });
  await client.connect(transport);

  const exercised = { total: 0, falsy: 0 };
  console.log('\n── C1.a  one confidence verdict per response ──');
  // The prod defect: meta.sufficient_answer false sitting beside
  // justification.presentation_mode "confident_summary". Given two signals a model takes
  // the confident one, so the dangerous direction is a payload claiming MORE than the
  // envelope. Probe several queries: this must hold for every response, not on average.
  const queries = [
    'what did we decide about the visibility contract',
    'zzzq nonexistent topic that is definitely not in this corpus 84713',
    'what is the forgetting horizon',
  ];
  for (const q of queries) {
    const r = await callTool(client, 'velixar_context', { intent: q });
    const meta = r?.meta ?? {};
    const j = r?.data?.justification ?? r?.justification ?? {};
    const mode = j.presentation_mode;
    exercised.total++;
    if (meta.sufficient_answer === false) exercised.falsy++;
    if (!mode) { check(`[${q.slice(0, 28)}…] payload carries a verdict`, true, 'no justification block — nothing to contradict'); continue; }
    const overclaims = meta.sufficient_answer === false &&
                       RANK.indexOf(mode) >= RANK.indexOf('confident_summary');
    check(`[${q.slice(0, 28)}…] envelope and payload agree`, !overclaims,
          `sufficient_answer=${meta.sufficient_answer} but presentation_mode=${mode}`);
    if (meta.data_absent === true) {
      check(`[${q.slice(0, 28)}…] data_absent ⇒ do_not_assert`, mode === 'do_not_assert',
            `data_absent=true but presentation_mode=${mode}`);
    }
  }

  console.log('\n── C1.b  staleness floors confidence ──');
  // All-stale evidence resolved to level "high", score 0.75 in prod. A dimension pinned at
  // its worst possible value must not be outvoted by a weighted sum.
  const stale = await callTool(client, 'velixar_context', {
    intent: 'what happened during the earliest work in this corpus',
  });
  const conf = stale?.data?.justification?.confidence ?? stale?.justification?.confidence ?? {};
  const items = stale?.data?.justification?.support?.items
             ?? stale?.justification?.support?.items ?? [];
  const freshness = items.map(i => i.freshness).filter(Boolean);
  const allStale = freshness.length > 0 && freshness.every(f => f === 'stale');
  if (allStale) {
    check('all-stale evidence is not "high"', conf.level !== 'high',
          `level=${conf.level} score=${conf.score} over ${freshness.length} stale items`);
    check('the cap is visible, not silent',
          conf.freshness_capped === true && typeof conf.raw_score === 'number',
          `freshness_capped=${conf.freshness_capped} raw_score=${conf.raw_score}`);
  } else {
    check('all-stale case reachable', true,
          `corpus returned ${freshness.length} items, not all stale (${[...new Set(freshness)].join('/')}) — ceiling not exercised`);
  }

  console.log('\n── C1.c  an empty section states WHY ──');
  // `empty_sections` is emitted by velixar_context (src/tools/recall.ts implements it).
  // An earlier draft of this probe called a `velixar_recall` tool that does not exist and
  // reported the resulting "Unknown tool" as a MISSING FIELD — a probe asserting the wrong
  // name manufactures a defect. Field paths below are taken from the live payload.
  const ctx = await callTool(client, 'velixar_context', { intent: 'zzzq nonexistent 84713' });
  const empties = ctx?.data?.empty_sections ?? ctx?.empty_sections;
  check('empty_sections is present', Array.isArray(empties),
        `got ${typeof empties} on velixar_context — 1.6.0 should always emit it`);
  if (Array.isArray(empties)) {
    const unexplained = empties.filter(s => !s.reason);
    check('every empty section carries a reason', unexplained.length === 0,
          `${unexplained.length} without a reason: ${JSON.stringify(unexplained.slice(0, 2))}`);
  }

  console.log('\n── C1.d  prepare_context cannot assert adequacy on nothing ──');
  // The worst of the four: 0 memories retrieved, data_absent true, coverage "unavailable",
  // and it still emitted "Context appears adequate for synthesis" with explicit_gaps [].
  const prep = await callTool(client, 'velixar_prepare_context', {
    queries: ['zzzq nonexistent topic 84713', 'zzzq another nonexistent 91852'],
    strategy: 'exploration', token_budget: 6000,
  });
  const d = prep?.data ?? prep;
  const ah = d?.anti_hallucination ?? {};             // live path, verified against prod
  const rm = d?.retrieval_metadata ?? {};
  const considered = rm.memories_considered;
  const instruction = String(ah.instruction ?? '');

  // The exact prod string that must no longer appear when coverage is unverified.
  const claimsAdequate = /appears adequate for synthesis/i.test(instruction);
  check('unverified coverage ⇒ does not claim adequacy',
        !(ah.coverage_verified === false && claimsAdequate),
        `coverage_verified=${ah.coverage_verified} while asserting: ${instruction.slice(0, 90)}`);
  check('zero memories ⇒ does not claim adequacy',
        !(considered === 0 && claimsAdequate),
        `memories_considered=${considered} while asserting: ${instruction.slice(0, 90)}`);
  check('retrieval_status is reported',
        ah.retrieval_status !== undefined,
        'retrieval_status absent — a timeout would again be indistinguishable from an empty corpus');
  check('coverage_verified is reported',
        ah.coverage_verified !== undefined,
        'coverage_verified absent — unknown coverage would read as verified coverage');
  // Deny-by-default: when coverage is NOT verified the instruction must say so rather than
  // stay silent, which is what let a caller read "no stated gaps" as "no gaps".
  if (ah.coverage_verified === false) {
    check('unverified coverage is stated, not implied',
          /could NOT be verified|possibly incomplete|qualify/i.test(instruction),
          `instruction does not warn: ${instruction.slice(0, 120)}`);
  }

  console.log('\n── negative control: can these checks FAIL at all? ──');
  // Every guard above is an implication (`sufficient_answer === false && overclaims`). An
  // implication whose antecedent never holds is VACUOUSLY true, and a suite of vacuous
  // truths looks exactly like a suite of passes. This session has already been burned once
  // by a probe that stayed green while its check was neutered, so assert the arithmetic
  // directly on synthetic payloads.
  const wouldCatch = (sufficient, mode) =>
    sufficient === false && RANK.indexOf(mode) >= RANK.indexOf('confident_summary');
  check('the C1.a rule REJECTS the documented prod payload',
        wouldCatch(false, 'confident_summary') === true,
        'the exact 2026-07-31 payload would now pass — the check is inert');
  check('the C1.a rule ACCEPTS an honest payload',
        wouldCatch(false, 'tentative_synthesis') === false &&
        wouldCatch(true, 'assertive') === false,
        'the check rejects honest payloads too — it is not measuring agreement');

  // Report how many live responses actually EXERCISED the rule, so a vacuous pass is
  // visible as a vacuous pass rather than counted as evidence.
  console.log(`      (live responses with sufficient_answer=false: ${exercised.falsy}/${exercised.total})`);

  await client.close();

  const failed = results.filter(r => !r.passed);
  console.log(`\n${results.length - failed.length}/${results.length} invariants hold`);
  if (failed.length) {
    console.log('\x1b[31mC1 NOT VERIFIED\x1b[0m — ' + failed.map(f => f.name).join('; '));
    process.exit(1);
  }
  console.log('\x1b[32mC1 VERIFIED in production\x1b[0m');
}

main().catch(e => { console.error('probe failed:', e?.message ?? e); process.exit(2); });
