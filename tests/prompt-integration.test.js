#!/usr/bin/env node
// S6: Prompt integration test
// Calls getPrompt() with sample args, verifies:
// - No unresolved {{placeholders}} in output
// - Tool names in output are valid
// - Stop conditions exist in every prompt

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const promptsSrc = readFileSync(join(root, 'src/prompts.ts'), 'utf-8');

// Extract tool names from tool files
const toolFiles = ['memory.ts', 'recall.ts', 'graph.ts', 'cognitive.ts', 'lifecycle.ts', 'system.ts'];
const actualTools = new Set();
for (const f of toolFiles) {
  const src = readFileSync(join(root, 'src/tools', f), 'utf-8');
  for (const m of src.matchAll(/name:\s*['"]([^'"]+)['"]/g)) {
    if (m[1].startsWith('velixar_')) actualTools.add(m[1]);
  }
}

// Parse prompts from source (lightweight — regex-based, no TS compilation needed)
const promptBlocks = [];
const promptRegex = /const\s+(\w+):\s*WorkflowPrompt\s*=\s*\{[\s\S]*?name:\s*'([^']+)'[\s\S]*?arguments:\s*\[([\s\S]*?)\][\s\S]*?content:\s*`([\s\S]*?)`/g;
let match;
while ((match = promptRegex.exec(promptsSrc)) !== null) {
  const [, varName, name, argsBlock, content] = match;
  const args = [];
  for (const a of argsBlock.matchAll(/name:\s*'([^']+)'[\s\S]*?required:\s*(true|false)/g)) {
    args.push({ name: a[1], required: a[2] === 'true' });
  }
  promptBlocks.push({ varName, name, args, content });
}

let failures = 0;

for (const p of promptBlocks) {
  // Simulate getPrompt: replace required args with test values
  let rendered = p.content;
  for (const arg of p.args) {
    rendered = rendered.replaceAll(`{{${arg.name}}}`, arg.required ? `test_${arg.name}` : '');
  }

  // Check 1: No unresolved placeholders
  const unresolved = rendered.match(/\{\{[^}]+\}\}/g);
  if (unresolved) {
    console.error(`FAIL [${p.name}]: Unresolved placeholders: ${unresolved.join(', ')}`);
    failures++;
  }

  // Check 2: All velixar_ tool refs are valid
  const toolRefs = rendered.match(/velixar_[a-z_]+/g) || [];
  for (const ref of toolRefs) {
    if (!actualTools.has(ref)) {
      console.error(`FAIL [${p.name}]: References non-existent tool: ${ref}`);
      failures++;
    }
  }

  // Check 3: Stop conditions exist (except cognitive_constitution which is a reference doc)
  if (p.name !== 'cognitive_constitution' && !rendered.toLowerCase().includes('stop condition')) {
    console.error(`FAIL [${p.name}]: Missing stop conditions`);
    failures++;
  }
}

if (promptBlocks.length === 0) {
  console.error('FAIL: No prompts parsed from prompts.ts');
  process.exit(1);
}

if (failures === 0) {
  console.log(`PASS: ${promptBlocks.length} prompts validated. No unresolved placeholders, all tool refs valid, stop conditions present.`);
  process.exit(0);
} else {
  console.error(`\n${failures} failure(s) across ${promptBlocks.length} prompts`);
  process.exit(1);
}
