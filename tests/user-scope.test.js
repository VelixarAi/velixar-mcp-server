// The server must NEVER invent a user identity.
//
// It did. loadConfig() defaulted userId to the literal 'mcp-user', and every
// read and write volunteered it. The moment the backend made user filters
// airtight (the 07-12 cross-user leak fix), that placeholder became a fence:
// each MCP install lived in a parallel memory universe — 26 pinned memories
// visible where the dashboard showed 186. The user's pinned "Boil the Ocean"
// directive was invisible from every MCP session.
//
// The contract now: no VELIXAR_USER_ID -> send NO user_id anywhere; the
// backend derives scope from the API key's creator and their workspace role.
// VELIXAR_USER_ID set -> send exactly that, everywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { userParams, withUser } from '../dist/api.js';

const here = dirname(fileURLToPath(import.meta.url));

function tsSources(dir = join(here, '..', 'src'), out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) tsSources(p, out);
    else if (entry.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

test("the 'mcp-user' placeholder is gone from the source tree", () => {
  for (const f of tsSources()) {
    const text = readFileSync(f, 'utf8');
    // Comments explaining the history may name it; code must not.
    const codeLines = text.split('\n').filter(l => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    });
    assert.doesNotMatch(
      codeLines.join('\n'),
      /['"]mcp-user['"]/,
      `${f} still contains the invented 'mcp-user' identity`
    );
  }
});

test('no user_id is sent unless VELIXAR_USER_ID is explicitly set', () => {
  const config = { apiKey: 'k', apiBase: '', workspaceId: 'ws', workspaceSource: 'none', timeoutMs: 1, debug: false };

  const params = userParams(config, { q: 'x', limit: '5' });
  assert.equal(params.get('user_id'), null, 'reads must not volunteer an identity');
  assert.equal(params.get('q'), 'x');

  const body = withUser(config, { content: 'hi', tier: 2 });
  assert.equal('user_id' in body, false, 'writes must not volunteer an identity');
  assert.deepEqual(body, { content: 'hi', tier: 2 });
});

test('an explicit VELIXAR_USER_ID is honored everywhere', () => {
  const config = { apiKey: 'k', apiBase: '', userId: 'alex', workspaceId: 'ws', workspaceSource: 'none', timeoutMs: 1, debug: false };

  assert.equal(userParams(config, { q: 'x' }).get('user_id'), 'alex');
  assert.equal(withUser(config, { content: 'hi' }).user_id, 'alex');
});

test('every user_id the built server sends flows through the two helpers', () => {
  // A raw `user_id: config.userId` outside api.js is a site that will drift.
  const dist = join(here, '..', 'dist');
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.js') && !p.endsWith(join('dist', 'api.js'))) {
        const text = readFileSync(p, 'utf8');
        if (/user_id:\s*config\.userId/.test(text)) offenders.push(p);
      }
    }
  };
  walk(dist);
  assert.deepEqual(offenders, [], 'user_id must be injected only via userParams/withUser in api.js');
});
