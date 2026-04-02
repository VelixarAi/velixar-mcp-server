#!/usr/bin/env node
// ── SDK Parity Check ──
// Compares MCP server tool list against JS and Python SDK method lists.
// Run in CI to catch drift between repos.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

// Extract tool names from MCP server source
function getMcpTools(): string[] {
  const toolFiles = ['memory.ts', 'recall.ts', 'graph.ts', 'cognitive.ts', 'lifecycle.ts', 'system.ts', 'livedata.ts'];
  const tools: string[] = [];
  for (const f of toolFiles) {
    const path = join(ROOT, 'src', 'tools', f);
    if (!existsSync(path)) continue;
    const src = readFileSync(path, 'utf-8');
    const matches = src.matchAll(/name:\s*'(velixar_\w+)'/g);
    for (const m of matches) tools.push(m[1]);
  }
  return [...new Set(tools)].sort();
}

// Map MCP tool names to expected SDK method names
function toolToMethod(tool: string): string {
  return tool
    .replace('velixar_', '')
    .replace('graph_traverse', 'graphTraverse')
    .replace('batch_store', 'batchStore')
    .replace('batch_search', 'batchSearch')
    .replace('session_save', 'sessionSave')
    .replace('session_recall', 'sessionRecall');
}

// System/internal tools that SDKs don't need to expose
const SDK_EXEMPT = new Set([
  'velixar_health', 'velixar_debug', 'velixar_capabilities', 'velixar_security',
  'velixar_context', 'velixar_inspect', 'velixar_timeline', 'velixar_patterns',
  'velixar_distill', 'velixar_consolidate', 'velixar_retag',
  'velixar_session_save', 'velixar_session_recall', 'velixar_session_resume',
  'velixar_batch_store', 'velixar_batch_search',
  'velixar_discover_data', 'velixar_list_sources', 'velixar_query_source',
  'velixar_upload',
  // Phase 3-5 tools — exempt until SDKs catch up
  'velixar_multi_search', 'velixar_search_neighborhood', 'velixar_coverage_check',
  'velixar_prepare_context', 'velixar_refine_context',
]);

// Check JS SDK
function checkJsSdk(tools: string[]): string[] {
  const sdkPath = join(ROOT, '..', 'velixar-js', 'src', 'index.ts');
  if (!existsSync(sdkPath)) return ['JS SDK not found at ' + sdkPath];
  const src = readFileSync(sdkPath, 'utf-8');
  const missing: string[] = [];
  for (const tool of tools) {
    if (SDK_EXEMPT.has(tool)) continue;
    const method = toolToMethod(tool);
    if (!src.includes(method)) missing.push(`${tool} → ${method}`);
  }
  return missing;
}

// Check Python SDK
function checkPythonSdk(tools: string[]): string[] {
  const sdkPath = join(ROOT, '..', 'velixar-python', 'velixar', 'client.py');
  if (!existsSync(sdkPath)) return ['Python SDK not found at ' + sdkPath];
  const src = readFileSync(sdkPath, 'utf-8');
  const missing: string[] = [];
  for (const tool of tools) {
    if (SDK_EXEMPT.has(tool)) continue;
    // Python uses snake_case
    const method = tool.replace('velixar_', '');
    if (!src.includes(method)) missing.push(`${tool} → ${method}`);
  }
  return missing;
}

// Run
const tools = getMcpTools();
console.log(`MCP Server: ${tools.length} tools`);
console.log(`SDK-required: ${tools.filter(t => !SDK_EXEMPT.has(t)).length} tools\n`);

const jsMissing = checkJsSdk(tools);
const pyMissing = checkPythonSdk(tools);

let exitCode = 0;

if (jsMissing.length) {
  console.error(`❌ JS SDK missing ${jsMissing.length} methods:`);
  jsMissing.forEach(m => console.error(`   ${m}`));
  exitCode = 1;
} else {
  console.log('✅ JS SDK: all methods present');
}

if (pyMissing.length) {
  console.error(`❌ Python SDK missing ${pyMissing.length} methods:`);
  pyMissing.forEach(m => console.error(`   ${m}`));
  exitCode = 1;
} else {
  console.log('✅ Python SDK: all methods present');
}

process.exit(exitCode);
