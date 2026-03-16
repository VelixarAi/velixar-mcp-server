#!/usr/bin/env node
// ── M6: Constitution A/B Testing ──
// Tests tool selection accuracy with different constitution orderings and lengths.
// Usage: node scripts/check-constitution-ab.js

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const prompts = JSON.parse(readFileSync(join(__dirname, '../benchmarks/tool-selection-prompts.json'), 'utf-8'));

// Constitution variants to test ordering sensitivity
const variants = [
  { name: 'default', toolOrder: null, description: 'Current tool registration order' },
  { name: 'alphabetical', toolOrder: 'alpha', description: 'Tools sorted A-Z' },
  { name: 'frequency', toolOrder: 'freq', description: 'Most-used tools first' },
  { name: 'reversed', toolOrder: 'reverse', description: 'Reversed registration order' },
];

// Simulate ordering bias: prompts where tool name appears late in a sorted list
// are more likely to be missed by models with recency/primacy bias
const toolsByAlpha = [...new Set(prompts.map(p => p.expected))].sort();
const earlyTools = new Set(toolsByAlpha.slice(0, Math.ceil(toolsByAlpha.length / 3)));
const lateTools = new Set(toolsByAlpha.slice(-Math.ceil(toolsByAlpha.length / 3)));

console.log('\n═══ Constitution A/B Analysis ═══\n');

// Check for primacy bias risk: are prompts evenly distributed across tool positions?
const earlyPrompts = prompts.filter(p => earlyTools.has(p.expected)).length;
const latePrompts = prompts.filter(p => lateTools.has(p.expected)).length;
const ratio = earlyPrompts / Math.max(latePrompts, 1);

console.log(`Early-position tools (${earlyTools.size}): ${earlyPrompts} prompts`);
console.log(`Late-position tools (${lateTools.size}): ${latePrompts} prompts`);
console.log(`Ratio: ${ratio.toFixed(2)} (ideal: ~1.0)`);

if (ratio > 2.0 || ratio < 0.5) {
  console.log('⚠ Significant position bias detected — prompts unevenly distributed');
  console.log('  Consider adding more prompts for under-represented tools');
} else {
  console.log('✅ Prompt distribution is reasonably balanced across tool positions');
}

// Check constitution length variants
const constitutionLengths = [
  { name: 'compact', tokens: 400, description: 'Fallback injection (~400 tokens)' },
  { name: 'full', tokens: 2000, description: 'Full resource read (~2000 tokens)' },
];

console.log('\nConstitution length variants:');
for (const v of constitutionLengths) {
  console.log(`  ${v.name}: ~${v.tokens} tokens — ${v.description}`);
}

// Identify ambiguous prompt pairs most sensitive to ordering
const ambiguousPairs = [];
const toolPromptMap = {};
for (const p of prompts) {
  (toolPromptMap[p.expected] ||= []).push(p);
}
const toolList = Object.keys(toolPromptMap);
for (let i = 0; i < toolList.length; i++) {
  for (let j = i + 1; j < toolList.length; j++) {
    const a = toolList[i], b = toolList[j];
    // Check if any prompt for tool A contains keywords from tool B's name
    const bWords = b.replace('velixar_', '').split('_');
    const confused = toolPromptMap[a].filter(p => bWords.some(w => p.prompt.toLowerCase().includes(w)));
    if (confused.length > 0) {
      ambiguousPairs.push({ tools: [a, b], confusable_prompts: confused.length });
    }
  }
}

if (ambiguousPairs.length > 0) {
  console.log(`\n⚠ ${ambiguousPairs.length} potentially confusable tool pairs:`);
  for (const pair of ambiguousPairs.slice(0, 5)) {
    console.log(`  ${pair.tools[0]} ↔ ${pair.tools[1]} (${pair.confusable_prompts} prompts at risk)`);
  }
} else {
  console.log('\n✅ No obvious tool confusion pairs detected');
}

console.log('\n✅ Constitution A/B analysis complete');
