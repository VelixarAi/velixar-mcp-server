#!/usr/bin/env node
// MCP-external synthetic probe — F1-OBSERVABILITY layer 3, the off-box check.
//
// The cold-start wedge proved the backend can be healthy while the MCP session in
// front of it is dark; backend-side health can NEVER see that failure class by
// construction. This opens a REAL MCP stdio session against the built server and
// runs store -> search -> delete in the canary key's workspace, under a hard
// timeout, exiting nonzero on any failure (the scheduler's failure alert is the
// detection channel).
//
// SAFETY (FIR-F1-PHASE2 #7): runs ONLY with VELIXAR_CANARY_KEY — a dedicated,
// minimal-scope key whose workspace holds nothing but probe traffic. It REFUSES
// to fall back to VELIXAR_API_KEY: a probe pointed at a real corpus is pollution,
// and a broad-scope key in a CI secret is blast radius nobody ordered.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HARD_TIMEOUT_MS = parseInt(process.env.PROBE_TIMEOUT_MS || '120000', 10);
const PER_CALL_TIMEOUT_MS = 30000;

const key = process.env.VELIXAR_CANARY_KEY;
if (!key) {
  console.error('REFUSED: VELIXAR_CANARY_KEY is not set. This probe never runs with a broad-scope key.');
  process.exit(2);
}
if (process.env.VELIXAR_API_KEY && process.env.VELIXAR_API_KEY === key) {
  console.error('REFUSED: VELIXAR_CANARY_KEY equals VELIXAR_API_KEY — mint a dedicated canary key.');
  process.exit(2);
}

// The wedge detector: if ANYTHING hangs, this timer is the check that sees it.
const watchdog = setTimeout(() => {
  console.error(`FAIL: probe exceeded hard timeout ${HARD_TIMEOUT_MS}ms (wedge — the failure class this probe exists for)`);
  process.exit(1);
}, HARD_TIMEOUT_MS);
watchdog.unref?.();

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverEntry = path.join(repoRoot, 'dist', 'index.js');

function stage(name, t0) {
  console.log(`stage=${name} ms=${Date.now() - t0}`);
}

const token = `mcp-probe-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
let exitCode = 1;
const t0 = Date.now();

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  env: { ...process.env, VELIXAR_API_KEY: key },
});
const client = new Client({ name: 'velixar-synthetic-probe', version: '1.0.0' });

async function call(name, args) {
  const res = await client.callTool({ name, arguments: args }, undefined, { timeout: PER_CALL_TIMEOUT_MS });
  const text = (res.content || []).map((c) => c.text || '').join('\n');
  if (res.isError) throw new Error(`${name} returned isError: ${text.slice(0, 400)}`);
  return text;
}

try {
  await client.connect(transport);
  stage('initialize', t0);

  const stored = await call('velixar_store', {
    content: `[MCP-PROBE] ${token} — external synthetic session probe; safe to delete.`,
    tags: ['mcp-synthetic-probe'],
    source: 'canary',
  });
  const idMatch = stored.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (!idMatch) throw new Error(`store returned no memory id: ${stored.slice(0, 300)}`);
  const memoryId = idMatch[0];
  stage('store', t0);

  const found = await call('velixar_search', { query: token, limit: 5 });
  if (!found.includes(token)) throw new Error('stored token not found by search through the MCP session');
  stage('search', t0);

  await call('velixar_delete', { memory_id: memoryId });
  stage('delete', t0);

  const gone = await call('velixar_search', { query: token, limit: 5 });
  // Tombstone semantics: content becomes [DELETED]; the token must no longer appear.
  if (gone.includes(token)) throw new Error('deleted probe memory still surfaces in search');
  stage('delete_verify', t0);

  console.log(`PASS total_ms=${Date.now() - t0}`);
  exitCode = 0;
} catch (e) {
  console.error(`FAIL: ${e?.message || e}`);
  exitCode = 1;
} finally {
  clearTimeout(watchdog);
  try { await client.close(); } catch { /* transport may already be dead — that's the finding */ }
  process.exit(exitCode);
}
