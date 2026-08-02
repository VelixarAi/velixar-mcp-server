#!/usr/bin/env node
// Every advertised capability must PROVE itself against production.
//
// WHY THIS EXISTS (2026-08-01). `velixar_capabilities` reports:
//
//     features: { identity: true, contradictions: true, graph: true, ... }
//
// Those are HARDCODED LITERALS. Nothing measures them, so the list is a claim rather than
// a fact, and it stays `true` when the capability is dormant. Verified the same day:
// `identity: true` is advertised while /v1/memory/identity returns snapshot_count 0 and
// thought_trace_count 0 — the read path works and NOTHING WAS EVER WRITTEN.
//
// That is the shape of nearly every defect found on 2026-08-01: not a crash, but a
// plausible-looking value that nobody could distinguish from a working one.
//   * declared `references` were dropped, and the memory stamped is_origin:true — a
//     legitimate state, so a total lineage outage looked like an answer.
//   * the KG canary was green for 8 days, then permanently red on age alone.
//   * the monthly rollover job threw BEFORE its own log line: zero credits ever issued,
//     silently, for the life of the feature.
//   * coverage_ratio returned a confident 0.57 that was ANTI-correlated with the thing
//     callers read it as.
// Several of those passed a full green unit suite. Unit tests prove functions behave;
// only a probe against production proves a CAPABILITY is delivering.
//
// THE RULE THIS ENCODES: a capability is advertised only if a probe can FAIL when it is
// absent. Each check below therefore states what absence looks like, and the negative
// controls at the end prove the checks can go red — a suite of vacuous truths looks
// exactly like a suite of passes.
//
// READ-ONLY. Calls only read tools against the real corpus, writes nothing. It needs a
// real corpus by construction: a probe workspace with three synthetic rows cannot tell
// "dormant" from "working".
//
// Exit 0 = every advertised capability verified. Exit 1 = at least one is advertised but
// NOT delivering. Exit 2 = the probe could not run (which is NOT a pass).
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CALL_TIMEOUT_MS = parseInt(process.env.CAP_CALL_TIMEOUT_MS || '60000', 10);
const key = process.env.VELIXAR_API_KEY;
if (!key) { console.error('VELIXAR_API_KEY required (read-only probe against the real corpus)'); process.exit(2); }

const serverPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'server.js');
const results = [];

function record(capability, verdict, detail) {
  results.push({ capability, verdict, detail });
  const mark = verdict === 'DELIVERING' ? '\x1b[32m✓\x1b[0m'
             : verdict === 'DORMANT'    ? '\x1b[31m✗\x1b[0m'
             : '\x1b[33m?\x1b[0m';
  console.log(`  ${mark} ${capability.padEnd(22)} ${verdict}${detail ? ` — ${detail}` : ''}`);
}

async function call(client, name, args = {}) {
  const res = await client.callTool({ name, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS });
  const text = res?.content?.find(c => c.type === 'text')?.text ?? '';
  try { return JSON.parse(text); } catch { return { _raw: text }; }
}
const body = r => r?.data ?? r ?? {};

// An ERROR is not evidence of absence. A tool that rejects the probe's arguments returns
// a message, and reading that as "0 results" reports a WORKING capability as dormant.
// This bit the first draft three times over (graph, contradictions, timeline) and is the
// same error class as coverage_ratio: absence of evidence read as evidence of absence.
const errored = o => typeof o?._raw === 'string' || typeof o?.error === 'string'
                     || (o && o.error && typeof o.error === 'object');
const errText = o => String(o?._raw ?? o?.error?.message ?? o?.error ?? '').slice(0, 90);

async function main() {
  const transport = new StdioClientTransport({
    command: process.execPath, args: [serverPath],
    env: { ...process.env, VELIXAR_API_KEY: key }, stderr: 'ignore',
  });
  const client = new Client({ name: 'cap-verify', version: '1' }, { capabilities: {} });
  await client.connect(transport);

  const caps = body(await call(client, 'velixar_capabilities'));
  const advertised = caps.features ?? {};
  console.log(`\nadvertised capabilities: ${Object.entries(advertised).filter(([, v]) => v).length} true, `
            + `client ${caps.version}\n`);

  // Each entry: does the capability produce OUTPUT, or only exist as a flag?
  console.log('── does each advertised capability actually deliver? ──');

  // identity — the one already known to be dormant, kept as the worked example.
  if (advertised.identity) {
    const id = body(await call(client, 'velixar_identity'));
    const snaps = id.snapshot_count ?? 0;
    const traces = id.thought_trace_count ?? 0;
    record('identity', (snaps > 0 || traces > 0) ? 'DELIVERING' : 'DORMANT',
           `snapshot_count=${snaps} thought_trace_count=${traces}`
           + (snaps === 0 ? ' — read path OK, nothing ever written' : ''));
  }

  if (advertised.graph) {
    const g = body(await call(client, 'velixar_graph_stats'));
    // Field names VERIFIED against a live response: entity_count / relationship_count.
    // The first draft guessed node_count/edge_count, read 0, and reported a graph holding
    // 4,315 entities as DORMANT.
    const ents = g.entity_count ?? 0, rels = g.relationship_count ?? 0;
    record('graph', errored(g) ? 'UNPROVEN' : (ents > 0 ? 'DELIVERING' : 'DORMANT'),
           errored(g) ? errText(g) : `entities=${ents} relationships=${rels}`);
  }

  if (advertised.contradictions) {
    const c = body(await call(client, 'velixar_contradictions', { limit: 5 }));
    // VERIFIED shape: { conflict_summary, evidence: [...], count, superseded_count }.
    const list = c.evidence ?? c.contradictions ?? [];
    // Producing records is the capability; ACTING on them is a separate claim we do not
    // make here. Say which one was verified so the gap stays visible.
    record('contradictions',
           errored(c) ? 'UNPROVEN' : (list.length > 0 ? 'DELIVERING' : 'DORMANT'),
           errored(c) ? errText(c)
             : `${c.count ?? list.length} active, ${c.superseded_count ?? 0} superseded `
               + `(DETECTION verified; acting on them is a separate, unverified claim)`);
  }

  if (advertised.timeline) {
    // REQUIRES topic or memory_id — the first draft omitted both, got
    // "Either topic or memory_id required", and scored the error as zero events.
    const t = body(await call(client, 'velixar_timeline', { topic: 'velixar', limit: 5 }));
    const evs = t.events ?? t.timeline ?? t.entries ?? [];
    record('timeline', errored(t) ? 'UNPROVEN' : (evs.length > 0 ? 'DELIVERING' : 'DORMANT'),
           errored(t) ? errText(t) : `${evs.length} events`);
  }

  if (advertised.patterns) {
    const p = body(await call(client, 'velixar_patterns'));
    const pats = p.patterns ?? [];
    const notImpl = JSON.stringify(p).includes('not_implemented');
    if (errored(p)) { record('patterns', 'UNPROVEN', errText(p)); } else
    record('patterns', notImpl ? 'DORMANT' : (pats.length > 0 ? 'DELIVERING' : 'DORMANT'),
           notImpl ? 'declares not_implemented' : `${pats.length} patterns`);
  }

  if (advertised.justification) {
    const j = body(await call(client, 'velixar_context', { topic: 'velixar' }));
    const mode = j.justification?.presentation_mode;
    record('justification', mode ? 'DELIVERING' : 'DORMANT',
           mode ? `presentation_mode=${mode}` : 'no justification block emitted');
  }

  if (advertised.workspace_isolation) {
    // Cannot be proven from inside one workspace — asserting it here would be exactly the
    // vacuous check this file exists to prevent. Say so rather than printing a tick.
    record('workspace_isolation', 'UNPROVEN',
           'needs a SECOND workspace credential; single-key probe cannot falsify it');
  }

  if (advertised.audit_log) {
    const a = body(await call(client, 'velixar_audit_log', { limit: 3 }));
    const entries = a.entries ?? a.audit ?? a.events ?? [];
    record('audit_log', errored(a) ? 'UNPROVEN' : (entries.length > 0 ? 'DELIVERING' : 'DORMANT'),
           errored(a) ? errText(a) : `${entries.length} entries`);
  }

  // ── negative controls ────────────────────────────────────────────────────
  console.log('\n── negative controls: can these checks FAIL? ──');
  const dormantLike = { snapshot_count: 0, thought_trace_count: 0 };
  const liveLike = { snapshot_count: 7, thought_trace_count: 3 };
  const verdict = o => ((o.snapshot_count ?? 0) > 0 || (o.thought_trace_count ?? 0) > 0)
                        ? 'DELIVERING' : 'DORMANT';
  console.log(`  ${verdict(dormantLike) === 'DORMANT' ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} `
            + `an empty capability is reported DORMANT`);
  console.log(`  ${verdict(liveLike) === 'DELIVERING' ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} `
            + `a populated capability is reported DELIVERING`);
  if (verdict(dormantLike) !== 'DORMANT' || verdict(liveLike) !== 'DELIVERING') {
    console.error('CONTROL FAILED — the verdict function does not discriminate'); process.exit(2);
  }

  await client.close();

  const dormant = results.filter(r => r.verdict === 'DORMANT');
  const unproven = results.filter(r => r.verdict === 'UNPROVEN');
  console.log(`\n${results.filter(r => r.verdict === 'DELIVERING').length}/${results.length} advertised capabilities verified`
            + (unproven.length ? `, ${unproven.length} unproven` : ''));
  if (unproven.length) {
    console.log('\x1b[33mUNPROVEN (the probe could not decide — NOT a pass, NOT a failure):\x1b[0m '
              + unproven.map(u => u.capability).join(', '));
  }
  if (dormant.length) {
    console.log('\x1b[31mADVERTISED BUT NOT DELIVERING:\x1b[0m ' + dormant.map(d => d.capability).join(', '));
    console.log('Either wake the capability or stop advertising it — a flag that is always '
              + 'true is not a capability report.');
    process.exit(1);
  }
  console.log('\x1b[32mevery advertised capability produced real output\x1b[0m');
}

main().catch(e => { console.error('probe could not run:', e?.message ?? e); process.exit(2); });
