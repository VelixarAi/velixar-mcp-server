// The version a host sees MUST be the version npm published.
//
// It was not. Three hand-typed version numbers had drifted apart:
//   package.json 1.2.0  |  serverInfo 1.1.0  |  velixar_capabilities 0.5.0
// A host asking "what am I talking to?" got a confident, wrong answer. A version
// number that can disagree with itself is worse than none: it is trusted.
//
// These tests are the probe that stops it recurring. Bumping package.json is now
// the ONLY way to change the version, and a hardcoded one fails the build.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { VERSION, SERVER_NAME } from '../dist/version.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));

test('VERSION is derived from package.json', () => {
  assert.equal(VERSION, pkg.version);
  assert.equal(SERVER_NAME, pkg.name);
});

test('the server reports the published version to hosts', async () => {
  // server.ts constructs `new Server({ name, version })`. Read the built output
  // rather than the source: what ships is what matters.
  const built = readFileSync(new URL('../dist/server.js', import.meta.url), 'utf8');
  assert.match(
    built,
    /version:\s*VERSION|name:\s*serverName,\s*version:\s*VERSION/,
    'serverInfo must use the derived VERSION, not a literal'
  );
  assert.doesNotMatch(
    built,
    /version:\s*['"]\d+\.\d+\.\d+['"]/,
    'a hardcoded serverInfo version has crept back in'
  );
});

test('no hand-typed server version literals in src', () => {
  // prompts.ts versions its PROMPTS independently (deliberate — a prompt's
  // version tracks its content, not the server's), so it is exempt.
  const EXEMPT = new Set(['prompts.ts', 'version.ts', 'index.js']);
  const offenders = [];

  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!/\.ts$/.test(entry) || EXEMPT.has(entry)) continue;
      const src = readFileSync(p, 'utf8');
      // a version assigned from a string literal, e.g. const VERSION = '0.5.0'
      const m = src.match(/(?:const\s+VERSION|version)\s*[:=]\s*['"]\d+\.\d+\.\d+['"]/g);
      if (m) offenders.push(`${p}: ${m.join(', ')}`);
    }
  };
  walk(new URL('../src', import.meta.url).pathname);

  assert.deepEqual(
    offenders,
    [],
    `hardcoded version literal(s) — import VERSION from version.js instead:\n${offenders.join('\n')}`
  );
});
