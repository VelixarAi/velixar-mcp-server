// The slugs this server reports in X-Velixar-Client must be slugs the backend
// actually KNOWS. If we report one it does not recognise, it drops the header and
// the tool's tile never turns "connected" — which is precisely the bug 1.2.3 fixed.
//
// The list is OWNED BY THE BACKEND (lambda/api/connectors.py) and published at
// GET /v1/contract. client_id.ts keeps its own RULES (the name-matching regexes are
// genuinely ours), but the SLUG SET is a shared contract and must not drift.
//
// This hits the LIVE contract on purpose: a mocked one would only prove we agree
// with ourselves. If it cannot run, it FAILS — a check that silently passes when
// it cannot run is not a check. Set SKIP_CONTRACT=1 to opt out deliberately.
import { test, skip } from 'node:test';
import assert from 'node:assert/strict';
import { slugFromName } from '../dist/client_id.js';

const CONTRACT_URL = 'https://api.velixarai.com/v1/contract';

// Every slug client_id.ts can possibly emit. Derived by exercising the mapper, so
// it cannot fall out of step with the RULES table the way a second hand-written
// list would.
const EMITTABLE = [...new Set([
  'claude-code', 'claude-ai', 'cursor', 'windsurf', 'continue',
  'kiro', 'cline', 'zed', 'codex', 'goose', 'opencode',
].map(slugFromName))].filter(Boolean).sort();

async function contract() {
  const res = await fetch(CONTRACT_URL, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`contract fetch failed: HTTP ${res.status}`);
  const json = await res.json();
  return json?.data ?? json;
}

test('every slug we can emit is one the backend knows', { skip: process.env.SKIP_CONTRACT === '1' }, async () => {
  const c = await contract();
  assert.ok(c.connectors, '/v1/contract did not publish `connectors`');
  const known = Object.keys(c.connectors);

  const unknown = EMITTABLE.filter(s => !known.includes(s));
  assert.deepEqual(
    unknown, [],
    `we would report ${JSON.stringify(unknown)} in X-Velixar-Client, but the backend ` +
    `does not know these slugs — it will drop the header and the tile will never connect`
  );
});

test('we can identify every host the backend supports', { skip: process.env.SKIP_CONTRACT === '1' }, async () => {
  const c = await contract();
  const known = Object.keys(c.connectors).sort();
  const unmappable = known.filter(s => !EMITTABLE.includes(s));
  assert.deepEqual(
    unmappable, [],
    `the backend supports ${JSON.stringify(unmappable)} but client_id.ts cannot produce ` +
    `those slugs — a user of that host would never light up its tile`
  );
});
