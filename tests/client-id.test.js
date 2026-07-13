// Who is calling? The dashboard's "connected" badge depends on this being right.
//
// The badge used to require minting a key from the tool's own tile. A tool using a
// key from anywhere else was invisible — Claude Code could be hammering the API and
// its tile still said nothing. Now the server reports its host from the MCP
// handshake, so the badge is earned by traffic.
//
// A WRONG slug is worse than none: it would light up the wrong tile. Hence the
// ordering test below.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugFromName, slugFromEnv, resolveClient } from '../dist/client_id.js';

test('real handshake names map to the dashboard slugs', () => {
  const cases = {
    'claude-code': 'claude_code',
    'Claude Code': 'claude_code',
    'claude-ai': 'claude_desktop',
    'Claude Desktop': 'claude_desktop',
    'cursor-vscode': 'cursor',
    'Cursor': 'cursor',
    'Windsurf': 'windsurf',
    'codeium-windsurf': 'windsurf',
    'continue': 'continue',
    'Kiro CLI': 'kiro',
    'cline': 'cline',
    'Zed': 'zed',
    'codex-cli': 'codex',
    'goose': 'goose',
    'opencode': 'opencode',
  };
  for (const [name, want] of Object.entries(cases)) {
    assert.equal(slugFromName(name), want, `${name} -> ${want}`);
  }
});

test('ORDERING: "Claude Code" must never resolve to Claude Desktop', () => {
  // Both contain "claude". If the desktop rule ran first, every Claude Code user
  // would light up the Claude Desktop tile — a confidently wrong badge.
  assert.equal(slugFromName('claude-code'), 'claude_code');
  assert.equal(slugFromName('Claude Code (CLI)'), 'claude_code');
  assert.notEqual(slugFromName('claude-code'), 'claude_desktop');
});

test('an unknown host reports nothing rather than guessing', () => {
  assert.equal(slugFromName('some-random-mcp-host'), null);
  assert.equal(slugFromName(''), null);
  assert.equal(slugFromName(undefined), null);
});

test('env is a fallback, never an override', () => {
  assert.equal(slugFromEnv({ CURSOR_SESSION_ID: '1' }), 'cursor');
  assert.equal(slugFromEnv({}), null);
  // handshake wins: a Cursor env var must not relabel a host that named itself
  const prev = process.env.CURSOR_SESSION_ID;
  process.env.CURSOR_SESSION_ID = '1';
  try {
    assert.equal(resolveClient('claude-code'), 'claude_code');
  } finally {
    if (prev === undefined) delete process.env.CURSOR_SESSION_ID;
    else process.env.CURSOR_SESSION_ID = prev;
  }
});
