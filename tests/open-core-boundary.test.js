// Open-core boundary: proprietary modules must not reach the published artifact.
//
// `files` in package.json publishes dist/ wholesale, and tsc emits EVERY file that
// tsconfig `include` matches — an import is not what places a file in dist/, inclusion
// is. So "not imported by server.ts" is not the property; "absent from dist/" is.
// This test reads the freshly built dist/ (npm test builds first, and the build
// cleans dist/ so a stale artifact cannot make this pass).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, '..', 'dist');

const PROPRIETARY = [
  'tools/clairvoyance.js',
  'tools/clairvoyance.d.ts',
  'simulation',
];

test('dist/ exists (the build ran before this test)', () => {
  assert.ok(existsSync(join(dist, 'server.js')), 'dist/server.js missing — run npm run build');
});

for (const rel of PROPRIETARY) {
  test(`dist/${rel} is not in the published artifact`, () => {
    assert.equal(existsSync(join(dist, rel)), false, `dist/${rel} exists — tsconfig exclude is not holding`);
  });
}

test('no compiled file under dist/ imports the proprietary modules', () => {
  // The property is an IMPORT of the module, not the word: a comment that names the
  // boundary is allowed, a specifier that would load the code is not.
  const IMPORT = /from\s+['"][^'"]*(?:tools\/clairvoyance|simulation\/(?:personas|runner|report))\.js['"]|import\(\s*['"][^'"]*(?:tools\/clairvoyance|simulation\/)[^'"]*['"]\s*\)/;
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (/\.(js|d\.ts)$/.test(entry.name) && IMPORT.test(readFileSync(p, 'utf-8'))) offenders.push(p.slice(dist.length + 1));
    }
  };
  walk(dist);
  assert.deepEqual(offenders, [], `these compiled files import a proprietary module: ${offenders.join(', ')}`);
});

test('the registered tool list has no clairvoyance tool', async () => {
  // Registration is a runtime list; the source-level import removal in server.ts is the
  // mechanism, this is the observable. Read the compiled server rather than importing it
  // (importing would start the MCP server on stdio).
  const src = readFileSync(join(dist, 'server.js'), 'utf-8');
  assert.equal(src.includes('clairvoyanceTools'), false, 'dist/server.js still spreads clairvoyanceTools into allTools');
});
