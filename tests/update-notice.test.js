import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isOlder, noteFromHeader, noteLatest, takeUpdateNotice, _reset } from '../dist/update_notice.js';
import { VERSION } from '../dist/version.js';

// A stale build learns it is behind (via signal A's header or B's npm check) and
// surfaces ONE nudge on the next tool response. A current build stays silent.

test('isOlder compares MAJOR.MINOR.PATCH numerically', () => {
  assert.equal(isOlder('1.3.4', '1.4.0'), true);
  assert.equal(isOlder('1.4.0', '1.4.0'), false);
  assert.equal(isOlder('1.4.1', '1.4.0'), false);
  assert.equal(isOlder('1.4.0', '1.10.0'), true, 'string compare would wrongly say 1.10 < 1.4');
  assert.equal(isOlder('2.0.0', '1.9.9'), false);
});

test('garbage / pre-release versions never trip the nudge', () => {
  assert.equal(isOlder('1.4.0', 'latest'), false);
  assert.equal(isOlder('1.4', '1.4.0'), false, 'short version → no nag');
  assert.equal(isOlder('1.4.0-beta', '1.4.0'), false);
});

test('a behind client surfaces the notice exactly ONCE, then stays quiet', () => {
  _reset();
  noteLatest('99.0.0');                 // some newer version than our VERSION
  const first = takeUpdateNotice();
  assert.ok(first, 'first take yields the notice');
  assert.equal(first.current, VERSION);
  assert.equal(first.latest, '99.0.0');
  assert.match(first.message, /99\.0\.0/);
  assert.match(first.message, /restart/i);
  assert.equal(takeUpdateNotice(), null, 'no nagging — second take is silent');
});

test('a current (or ahead) client never nudges', () => {
  _reset();
  noteLatest(VERSION);                  // exactly our version
  assert.equal(takeUpdateNotice(), null);
  noteLatest('0.0.1');                  // older than us
  assert.equal(takeUpdateNotice(), null);
});

test('signal A: the response header feeds the notice', () => {
  _reset();
  noteFromHeader('99.0.0');
  assert.ok(takeUpdateNotice(), 'header value newer than us → nudge');
});

test('signal A: a missing/blank header is a no-op', () => {
  _reset();
  noteFromHeader(null);
  noteFromHeader('');
  assert.equal(takeUpdateNotice(), null);
});

test('keeps the NEWEST latest when both signals report', () => {
  _reset();
  noteLatest('99.0.0');
  noteLatest('98.0.0');                 // older than the one already seen — ignored
  const n = takeUpdateNotice();
  assert.equal(n.latest, '99.0.0');
});

// ── v2: backend-authoritative manifest + escalation ──

test('manifest handshake: server-computed status becomes the notice', async () => {
  _reset();
  const { fetchManifest, instructionsText } = await import('../dist/update_notice.js');
  const fakeApi = { get: async () => ({
    manifest: { latest: '99.0.0' },
    update_status: { status: 'behind', current: VERSION, latest: '99.0.0', severity: 'info',
      reason: 'test reason', action: 'update your MCP config to velixar-mcp-server@99.0.0',
      restart_required: true },
  }) };
  await fetchManifest(fakeApi);
  const n = takeUpdateNotice();
  assert.equal(n.latest, '99.0.0');
  assert.match(n.message, /test reason/);
  assert.match(n.message, /relay/i, 'the message must ask the agent to relay it');
  assert.equal(instructionsText() !== null, true, 'initialize instructions channel armed');
  assert.equal(takeUpdateNotice(), null, 'info severity: once per session');
});

test('escalated severity repeats on EVERY response and carries a warning', async () => {
  _reset();
  const { fetchManifest } = await import('../dist/update_notice.js');
  await fetchManifest({ get: async () => ({
    manifest: { latest: '99.0.0' },
    update_status: { status: 'behind', current: VERSION, latest: '99.0.0',
      severity: 'data_integrity', reason: 'fixes provenance fabrication',
      action: 'update to velixar-mcp-server@99.0.0', restart_required: true },
  }) });
  const first = takeUpdateNotice();
  assert.ok(first.warning, 'escalated notice must warn results may be affected');
  assert.ok(takeUpdateNotice(), 'repeats — not once-per-session');
  assert.ok(takeUpdateNotice(), 'keeps repeating until resolved');
});

test('manifest says current -> no notice, and header churn at same version stays quiet', async () => {
  _reset();
  const { fetchManifest } = await import('../dist/update_notice.js');
  await fetchManifest({ get: async () => ({ manifest: { latest: VERSION } }) });
  assert.equal(takeUpdateNotice(), null);
  noteFromHeader(VERSION);
  assert.equal(takeUpdateNotice(), null, 'same latest from the header must not re-nag');
});

test('a NEWER latest from the header re-arms the notice mid-session', async () => {
  _reset();
  noteLatest('98.0.0');
  takeUpdateNotice();                       // consumed
  noteFromHeader('99.0.0');                 // update shipped mid-session
  const n = takeUpdateNotice();
  assert.ok(n && n.latest === '99.0.0', 'latest moved -> one fresh notice');
});

test('manifest fetch failure is silent', async () => {
  _reset();
  const { fetchManifest } = await import('../dist/update_notice.js');
  await fetchManifest({ get: async () => { throw new Error('offline'); } });
  assert.equal(takeUpdateNotice(), null);
});
