#!/usr/bin/env node
// S2: Prompt freshness test
// Parses prompts.ts, extracts tool names referenced in prompt text,
// asserts they match actual tools from server.ts. Catches stale references.

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const promptsSrc = readFileSync(join(root, 'src/prompts.ts'), 'utf-8');
const serverSrc = readFileSync(join(root, 'src/server.ts'), 'utf-8');
const matrixSrc = readFileSync(join(root, 'tool-prompt-matrix.json'), 'utf-8');

// Extract tool names from server.ts imports (tool arrays)
const toolFiles = ['memory.ts', 'recall.ts', 'graph.ts', 'cognitive.ts', 'lifecycle.ts', 'system.ts'];
const actualTools = new Set();
for (const f of toolFiles) {
  const src = readFileSync(join(root, 'src/tools', f), 'utf-8');
  // Match tool name definitions: name: 'velixar_xxx'
  for (const m of src.matchAll(/name:\s*['"]([^'"]+)['"]/g)) {
    if (m[1].startsWith('velixar_')) actualTools.add(m[1]);
  }
}

// Extract velixar_ tool references from prompt text
const promptToolRefs = new Set();
for (const m of promptsSrc.matchAll(/velixar_[a-z_]+/g)) {
  promptToolRefs.add(m[0]);
}

// Extract tools from matrix
const matrix = JSON.parse(matrixSrc);
const matrixTools = new Set(Object.keys(matrix.tools));

let failures = 0;

// Check 1: No prompt references a non-existent tool
for (const ref of promptToolRefs) {
  if (!actualTools.has(ref)) {
    console.error(`FAIL: Prompt references non-existent tool: ${ref}`);
    failures++;
  }
}

// Check 2: Every actual tool is in the matrix
for (const tool of actualTools) {
  if (!matrixTools.has(tool)) {
    console.error(`FAIL: Tool ${tool} missing from tool-prompt-matrix.json`);
    failures++;
  }
}

// Check 3: Every matrix tool exists
for (const tool of matrixTools) {
  if (!actualTools.has(tool)) {
    console.error(`FAIL: Matrix references non-existent tool: ${tool}`);
    failures++;
  }
}

// Check 4: Matrix prompt references match actual prompt text
// Note: cognitive_constitution uses renderModesTable() at runtime — tool names aren't in source text
for (const [tool, prompts] of Object.entries(matrix.tools)) {
  for (const prompt of prompts) {
    if (prompt === 'cognitive_constitution') continue; // uses runtime interpolation
    const promptRegex = new RegExp(`const\\s+${prompt}[\\s\\S]*?(?=const\\s+\\w+:\\s*WorkflowPrompt|export\\s+const)`);
    const block = promptsSrc.match(promptRegex);
    if (block && !block[0].includes(tool)) {
      console.error(`FAIL: Matrix says ${tool} is in prompt ${prompt}, but prompt text doesn't reference it`);
      failures++;
    }
  }
}

if (failures === 0) {
  console.log(`PASS: All ${actualTools.size} tools verified. ${promptToolRefs.size} prompt references valid. Matrix consistent.`);
  process.exit(0);
} else {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
