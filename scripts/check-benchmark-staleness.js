#!/usr/bin/env node
// M11: Benchmark staleness detection — hashes tool descriptions and contracts.
// If hashes change between releases, flags affected benchmarks as potentially stale.
// Run: node scripts/check-benchmark-staleness.js
// Stores hashes in .benchmark-hashes.json; exits non-zero if stale.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const hashFile = resolve(root, '.benchmark-hashes.json');

// Extract tool names and descriptions from source
function extractToolSignatures() {
  const toolFiles = ['memory.ts', 'recall.ts', 'graph.ts', 'cognitive.ts', 'lifecycle.ts', 'system.ts'];
  const signatures = {};

  for (const file of toolFiles) {
    const src = readFileSync(resolve(root, 'src', 'tools', file), 'utf-8');
    // Match tool name + description blocks
    const regex = /name:\s*'(velixar_\w+)'[\s\S]*?description:\s*\n?\s*((?:'[^']*'(?:\s*\+\s*'[^']*')*)|(?:`[^`]*`))/g;
    let match;
    while ((match = regex.exec(src))) {
      const name = match[1];
      const desc = match[2].replace(/['\s+`]/g, '');
      signatures[name] = createHash('md5').update(desc).digest('hex').slice(0, 8);
    }
  }
  return signatures;
}

const current = extractToolSignatures();
console.log('\n═══ Benchmark Staleness Check ═══\n');

if (!existsSync(hashFile)) {
  writeFileSync(hashFile, JSON.stringify(current, null, 2));
  console.log(`✅ Baseline created with ${Object.keys(current).length} tool signatures\n`);
  process.exit(0);
}

const previous = JSON.parse(readFileSync(hashFile, 'utf-8'));
const changed = [];
const added = [];
const removed = [];

for (const [name, hash] of Object.entries(current)) {
  if (!previous[name]) added.push(name);
  else if (previous[name] !== hash) changed.push(name);
}
for (const name of Object.keys(previous)) {
  if (!current[name]) removed.push(name);
}

if (changed.length === 0 && added.length === 0 && removed.length === 0) {
  console.log(`✅ All ${Object.keys(current).length} tool signatures unchanged\n`);
  process.exit(0);
}

if (changed.length) console.log(`⚠ Changed descriptions (benchmarks may be stale):\n  ${changed.join('\n  ')}`);
if (added.length) console.log(`➕ New tools (need benchmark coverage):\n  ${added.join('\n  ')}`);
if (removed.length) console.log(`➖ Removed tools:\n  ${removed.join('\n  ')}`);

// Update hashes
writeFileSync(hashFile, JSON.stringify(current, null, 2));
console.log(`\nHashes updated. Review affected benchmarks.\n`);
process.exit(1);
