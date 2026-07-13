// The installer writes to a file the user did not create, and which may already
// contain OTHER MCP servers they depend on. The only unforgivable failure here is
// deleting someone else's config, so that is what these tests are about.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeConfig } from '../dist/install.js';

const ENTRY = { command: 'npx', args: ['-y', 'velixar-mcp-server@1.2.4'], env: { VELIXAR_API_KEY: 'vlx_k' } };

test('a config that does not exist yet is created', () => {
  const out = JSON.parse(mergeConfig(null, 'mcpServers', ENTRY));
  assert.deepEqual(out.mcpServers.velixar, ENTRY);
});

test('an empty file is treated as an empty config, not a parse error', () => {
  const out = JSON.parse(mergeConfig('   \n', 'mcpServers', ENTRY));
  assert.ok(out.mcpServers.velixar);
});

test('OTHER MCP SERVERS SURVIVE — this is the whole point', () => {
  // The thing people actually do wrong by hand: paste the snippet over the top and
  // silently delete the servers they already had.
  const existing = JSON.stringify({
    mcpServers: {
      filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'] },
      github: { command: 'docker', args: ['run', 'ghcr.io/github/github-mcp-server'] },
    },
  });
  const out = JSON.parse(mergeConfig(existing, 'mcpServers', ENTRY));
  assert.ok(out.mcpServers.filesystem, 'filesystem server was destroyed');
  assert.ok(out.mcpServers.github, 'github server was destroyed');
  assert.deepEqual(out.mcpServers.filesystem.args, ['-y', '@modelcontextprotocol/server-filesystem', '/tmp']);
  assert.ok(out.mcpServers.velixar);
  assert.equal(Object.keys(out.mcpServers).length, 3);
});

test('unrelated top-level keys survive', () => {
  const existing = JSON.stringify({ globalShortcut: 'Cmd+Shift+V', mcpServers: {} });
  const out = JSON.parse(mergeConfig(existing, 'mcpServers', ENTRY));
  assert.equal(out.globalShortcut, 'Cmd+Shift+V');
});

test('running it twice UPDATES, it does not duplicate or nest', () => {
  const once = mergeConfig(null, 'mcpServers', ENTRY);
  const twice = mergeConfig(once, 'mcpServers', { ...ENTRY, env: { VELIXAR_API_KEY: 'vlx_new' } });
  const out = JSON.parse(twice);
  assert.equal(Object.keys(out.mcpServers).length, 1);
  assert.equal(out.mcpServers.velixar.env.VELIXAR_API_KEY, 'vlx_new', 'a re-run must update the key');
});

test('a MALFORMED config is REFUSED, never overwritten', () => {
  // It is the user's file. Clobbering a config we cannot parse would destroy
  // whatever they had, to fix a problem we caused by not reading it.
  assert.throws(
    () => mergeConfig('{ this is not json', 'mcpServers', ENTRY),
    /not valid JSON/,
  );
});

test('a host that nests under a different key is honoured', () => {
  const out = JSON.parse(mergeConfig(null, 'context_servers', ENTRY));
  assert.ok(out.context_servers.velixar);
  assert.equal(out.mcpServers, undefined);
});
