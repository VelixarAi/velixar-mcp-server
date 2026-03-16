#!/usr/bin/env node
// ── M14: Quarterly Deferred Tool Review ──
// Run every 3 months to review deferred tool decisions against real usage.
// Usage: node scripts/quarterly-review.js

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const contracts = JSON.parse(readFileSync(join(__dirname, '../tool-contracts.json'), 'utf-8'));

const checklist = [
  { id: 'DEFERRED_TOOLS', question: 'Review deferred tool candidates — any new usage patterns justify adding them?', action: 'Check tool-contracts.json deferred_candidates if present' },
  { id: 'TOOL_OVERLAP', question: 'Are any existing tools redundant based on real usage data?', action: 'Check if any tool has <1% selection rate in production logs' },
  { id: 'DESCRIPTION_DRIFT', question: 'Have tool descriptions drifted from actual behavior?', action: 'Run: node scripts/check-benchmark-staleness.js' },
  { id: 'CONSTITUTION_FRESHNESS', question: 'Is the constitution still accurate for current tool set?', action: 'Compare constitution tool list against registered tools' },
  { id: 'BENCHMARK_COVERAGE', question: 'Are benchmarks covering new tools added since last review?', action: 'Run: node benchmarks/run.js — check coverage %' },
  { id: 'HOST_COMPAT', question: 'Any new MCP hosts released that need testing?', action: 'Check MCP ecosystem for new hosts since last review' },
  { id: 'SDK_PARITY', question: 'Are JS/Python SDKs still in sync with MCP tools?', action: 'Run: npx ts-node scripts/check-sdk-parity.ts' },
  { id: 'SCHEMA_CONTRACTS', question: 'Have backend response shapes changed?', action: 'Run: npx ts-node scripts/check-schema-contracts.ts' },
];

const toolCount = Object.keys(contracts).length;
const now = new Date();
const quarter = `Q${Math.ceil((now.getMonth() + 1) / 3)} ${now.getFullYear()}`;

console.log(`\n═══ Quarterly Tool Review — ${quarter} ═══`);
console.log(`Tool contracts: ${toolCount} tools\n`);

for (const item of checklist) {
  console.log(`☐ [${item.id}] ${item.question}`);
  console.log(`  → ${item.action}\n`);
}

console.log('After completing all items, update the review log:');
console.log(`  echo "${quarter}: reviewed" >> scripts/quarterly-review.log`);
