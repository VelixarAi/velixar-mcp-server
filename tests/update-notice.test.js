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
