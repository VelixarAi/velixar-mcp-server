// ── Contract Gate ──
// Fails CI when an MCP tool consumes a backend response without runtime validation.
// Root cause this guards: silent-data-loss bugs from `api.get<{...}>` / `api.request<T>`
// TypeScript casts that compile but ignore real response shape.
//
// Rule: in src/tools/, any `api.{request,get,post,patch}<...>` call must use either
//   (a) the `*Validated` variants in api.ts, or
//   (b) `<unknown>` plus a `validate*Response(...)` call in the same function.
//
// New unsafe casts are rejected. Existing offenders are listed in EXEMPT below
// and tracked in the migration task. Do not add to EXEMPT without an issue link.

import { test } from 'node:test';
import assert from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const TOOLS_DIR = new URL('../src/tools', import.meta.url).pathname;

// Files allowed to retain unvalidated typed casts during migration. Each entry
// has a matching row in the call-site migration task. Empty target.
const EXEMPT = new Set([
  'lifecycle.ts',
  'livedata.ts',
  'system.ts',
  'clairvoyance.ts',
]);

const UNSAFE = /\bapi\.(request|get|post|patch)\s*<\s*(?!unknown\b)[^>]+>/g;

function scanFile(path) {
  const src = readFileSync(path, 'utf-8');
  const hits = [];
  let m;
  while ((m = UNSAFE.exec(src)) !== null) {
    const line = src.slice(0, m.index).split('\n').length;
    hits.push({ line, snippet: m[0] });
  }
  return hits;
}

test('no new unvalidated api casts in src/tools/', () => {
  const files = readdirSync(TOOLS_DIR).filter(f => f.endsWith('.ts'));
  const violations = [];
  for (const f of files) {
    if (EXEMPT.has(f)) continue;
    const hits = scanFile(join(TOOLS_DIR, f));
    for (const h of hits) {
      violations.push(`${f}:${h.line}  ${h.snippet}`);
    }
  }
  assert.deepStrictEqual(
    violations,
    [],
    `\nUnvalidated api casts found in non-exempt files. Use api.{get,post,patch}Validated(...) or <unknown> + a validate*Response() call:\n  ${violations.join('\n  ')}\n`,
  );
});

test('EXEMPT shrinks — every entry has a real file with a real cast', () => {
  for (const f of EXEMPT) {
    const path = join(TOOLS_DIR, f);
    const hits = scanFile(path);
    assert.ok(
      hits.length > 0,
      `EXEMPT lists ${f} but it has no unvalidated casts left — remove from EXEMPT.`,
    );
  }
});
