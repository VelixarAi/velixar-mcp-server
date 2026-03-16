#!/usr/bin/env node
// ── Velixar MCP Server — Benchmark Runner ──
// Usage: node benchmarks/run.js

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(readFileSync(join(__dirname, 'fixtures.json'), 'utf-8'));
const prompts = JSON.parse(readFileSync(join(__dirname, 'tool-selection-prompts.json'), 'utf-8'));
const messyFixture = JSON.parse(readFileSync(join(__dirname, 'messy-fixture.json'), 'utf-8'));

// M2: Confidence interval helper — Wilson score interval for proportions
function wilsonCI(successes, total, z = 1.96) {
  if (total === 0) return { lower: 0, upper: 0, margin: 0 };
  const p = successes / total;
  const denom = 1 + z * z / total;
  const center = (p + z * z / (2 * total)) / denom;
  const spread = z * Math.sqrt((p * (1 - p) + z * z / (4 * total)) / total) / denom;
  return { lower: Math.max(0, center - spread), upper: Math.min(1, center + spread), margin: spread };
}

const results = [];

// Tool Selection Coverage
const tools = new Set(prompts.map(p => p.expected));
const coverageRatio = tools.size / 23;
const coverageCI = coverageRatio <= 1.0 ? wilsonCI(tools.size, 23) : null; // CI only meaningful for proportions ≤1
results.push({
  suite: 'tool_selection_coverage',
  score: coverageRatio,
  ci: coverageCI,
  baseline: 0.8, excellence: 0.95,
  pass: coverageRatio >= 0.8,
  details: `${tools.size}/23 tools covered, ${prompts.length} prompts${coverageCI ? ` (±${(coverageCI.margin * 100).toFixed(1)}%)` : ''}`,
});

// Fixture Completeness
const fCount = Object.keys(fixtures.fixtures).length;
const gCount = fixtures.gold_tasks.length;
results.push({
  suite: 'fixture_completeness',
  score: fCount >= 4 && gCount >= 8 ? 1.0 : fCount / 4,
  baseline: 1.0, excellence: 1.0,
  pass: fCount >= 4 && gCount >= 8,
  details: `${fCount} fixtures, ${gCount} gold tasks`,
});

// Threshold Definitions
const metrics = Object.keys(fixtures.thresholds);
const allDefined = metrics.every(m => fixtures.thresholds[m].baseline !== undefined && fixtures.thresholds[m].excellence !== undefined);
results.push({
  suite: 'threshold_definitions',
  score: allDefined ? 1.0 : 0.5,
  baseline: 1.0, excellence: 1.0,
  pass: allDefined,
  details: `${metrics.length} metrics with baseline + excellence thresholds`,
});

// Needle-in-Haystack Design
const needles = Object.values(fixtures.fixtures).filter(f => f.needle).length;
results.push({
  suite: 'needle_test_design',
  score: needles / 2,
  baseline: 1.0, excellence: 1.0,
  pass: needles >= 2,
  details: `${needles} fixtures with needle-in-haystack tests`,
});

// M15: Tool Gap Detection — flag if graph-related prompts have low coverage
const graphTools = ['velixar_graph_traverse'];
const graphPrompts = prompts.filter(p => graphTools.includes(p.expected));
const graphCoverage = graphPrompts.length > 0 ? graphPrompts.length / prompts.length : 0;
if (graphPrompts.length < 5) {
  console.log(`⚠ M15: Only ${graphPrompts.length} graph-related prompts — consider adding more for gap detection`);
}

// M1: Messy Data Fixture Completeness
const messyGenerators = Object.keys(messyFixture.generators);
const messyGold = messyFixture.gold_tasks.length;
const messyOutcomes = Object.keys(messyFixture.expected_outcomes);
const messyCI = wilsonCI(messyGenerators.length, 7); // 7 noise categories expected
results.push({
  suite: 'messy_fixture_completeness',
  score: messyGenerators.length >= 6 && messyGold >= 4 ? 1.0 : messyGenerators.length / 6,
  ci: messyCI,
  baseline: 1.0, excellence: 1.0,
  pass: messyGenerators.length >= 6 && messyGold >= 4 && messyOutcomes.length >= 4,
  details: `${messyGenerators.length} noise generators, ${messyGold} gold tasks, ${messyOutcomes.length} outcome thresholds (±${(messyCI.margin * 100).toFixed(1)}%)`,
});

// Print
console.log('\n═══ Velixar Benchmark Results ═══\n');
for (const r of results) {
  const s = r.pass ? '✅' : '❌';
  const ciStr = r.ci ? ` [${(r.ci.lower * 100).toFixed(1)}%-${(r.ci.upper * 100).toFixed(1)}%]` : '';
  console.log(`${s} ${r.suite}: ${(r.score * 100).toFixed(1)}%${ciStr} (baseline: ${(r.baseline * 100).toFixed(0)}%, excellence: ${(r.excellence * 100).toFixed(0)}%)`);
  if (r.details) console.log(`   ${r.details}`);
}
const allPass = results.every(r => r.pass);
console.log(`\n${allPass ? '✅ All benchmarks pass' : '❌ Some benchmarks failed'}`);
process.exit(allPass ? 0 : 1);
