#!/usr/bin/env node
// M3: Circular dependency check — fails build on import cycles.
// Run: node scripts/check-circular-deps.js
// Uses built-in module resolution — no external deps needed.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcDir = resolve(__dirname, '..', 'src');

function findTsFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) files.push(...findTsFiles(full));
    else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) files.push(full);
  }
  return files;
}

function extractImports(filePath) {
  const content = readFileSync(filePath, 'utf-8');
  const imports = [];
  const regex = /from\s+['"](\.[^'"]+)['"]/g;
  let match;
  while ((match = regex.exec(content))) {
    let resolved = resolve(dirname(filePath), match[1]);
    if (!resolved.endsWith('.ts')) resolved += '.ts';
    resolved = resolved.replace(/\.js\.ts$/, '.ts');
    imports.push(resolved);
  }
  return imports;
}

function findCycles(graph) {
  const visited = new Set();
  const inStack = new Set();
  const cycles = [];

  function dfs(node, path) {
    if (inStack.has(node)) {
      const cycleStart = path.indexOf(node);
      cycles.push(path.slice(cycleStart).map(p => p.replace(srcDir + '/', '')));
      return;
    }
    if (visited.has(node)) return;
    visited.add(node);
    inStack.add(node);
    path.push(node);
    for (const dep of graph.get(node) || []) {
      dfs(dep, [...path]);
    }
    inStack.delete(node);
  }

  for (const node of graph.keys()) dfs(node, []);
  return cycles;
}

const files = findTsFiles(srcDir);
const graph = new Map();
for (const file of files) {
  graph.set(file, extractImports(file).filter(f => files.includes(f)));
}

const cycles = findCycles(graph);

console.log('\n═══ Circular Dependency Check ═══\n');
if (cycles.length === 0) {
  console.log(`✅ No circular dependencies found (${files.length} files checked)\n`);
  process.exit(0);
} else {
  // Deduplicate cycles (same cycle can be found from different starting points)
  const unique = new Map();
  for (const cycle of cycles) {
    const key = [...cycle].sort().join('→');
    if (!unique.has(key)) unique.set(key, cycle);
  }
  for (const cycle of unique.values()) {
    console.log(`❌ ${cycle.join(' → ')} → ${cycle[0]}`);
  }
  console.log(`\n${unique.size} circular dependency chain(s) found\n`);
  process.exit(1);
}
