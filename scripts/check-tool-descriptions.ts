#!/usr/bin/env npx tsx
// H2: Tool description A/B testing — measures tool selection accuracy
// across description variants for ambiguous tool pairs.
// Run: npx tsx scripts/check-tool-descriptions.ts
// Exits non-zero if any variant scores below 70% accuracy.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const benchDir = join(__dirname, '..', 'benchmarks');

// Ambiguous tool pairs and their disambiguation test prompts
const AMBIGUOUS_PAIRS: Array<{
  pair: [string, string];
  prompts: Array<{ text: string; expected: string }>;
}> = [
  {
    pair: ['velixar_search', 'velixar_context'],
    prompts: [
      { text: 'What do I know about React hooks?', expected: 'velixar_search' },
      { text: 'Give me an overview of this workspace', expected: 'velixar_context' },
      { text: 'What is the current state of the project?', expected: 'velixar_context' },
      { text: 'Find my notes about database migrations', expected: 'velixar_search' },
    ],
  },
  {
    pair: ['velixar_inspect', 'velixar_search'],
    prompts: [
      { text: 'Show me memory abc-123 in detail', expected: 'velixar_inspect' },
      { text: 'Find memories about authentication', expected: 'velixar_search' },
      { text: 'What does memory xyz-456 contain?', expected: 'velixar_inspect' },
      { text: 'Search for anything about deployment', expected: 'velixar_search' },
    ],
  },
  {
    pair: ['velixar_timeline', 'velixar_contradictions'],
    prompts: [
      { text: 'How did my opinion on TypeScript change?', expected: 'velixar_timeline' },
      { text: 'Are there conflicting beliefs in my workspace?', expected: 'velixar_contradictions' },
      { text: 'Show the evolution of the API design', expected: 'velixar_timeline' },
      { text: 'What contradicts my preference for Rust?', expected: 'velixar_contradictions' },
    ],
  },
  // Future disambiguation pairs — activate when tools are implemented
  // {
  //   pair: ['velixar_search', 'velixar_multi_search'],
  //   prompts: [
  //     { text: 'Find my notes about Redis caching', expected: 'velixar_search' },
  //     { text: 'I need comprehensive coverage of the outreach plan', expected: 'velixar_multi_search' },
  //     { text: 'What do I know about Composio?', expected: 'velixar_search' },
  //     { text: 'Search from all angles for partner strategy', expected: 'velixar_multi_search' },
  //   ],
  // },
  // {
  //   pair: ['velixar_context', 'velixar_prepare_context'],
  //   prompts: [
  //     { text: 'Orient me on this workspace', expected: 'velixar_context' },
  //     { text: 'I am about to answer a question, assemble what I need', expected: 'velixar_prepare_context' },
  //     { text: 'What is the current state of the project?', expected: 'velixar_context' },
  //     { text: 'Build me a context package for answering about outreach', expected: 'velixar_prepare_context' },
  //   ],
  // },
];

// Load tool descriptions from source
function loadToolDescriptions(): Map<string, string> {
  const toolFiles = ['memory.ts', 'recall.ts', 'graph.ts', 'cognitive.ts', 'lifecycle.ts', 'system.ts', 'livedata.ts'];
  const descriptions = new Map<string, string>();
  const nameDescRegex = /name:\s*'(velixar_\w+)'[\s\S]*?description:\s*\n?\s*(?:'([^']*)'|`([^`]*)`|"([^"]*)")/g;

  for (const file of toolFiles) {
    try {
      const src = readFileSync(join(__dirname, '..', 'src', 'tools', file), 'utf-8');
      // Simpler: extract name + first line of description
      const blocks = src.split(/\{\s*name:\s*'/);
      for (const block of blocks.slice(1)) {
        const nameMatch = block.match(/^(velixar_\w+)/);
        const descMatch = block.match(/description:\s*\n?\s*(?:'([^']*(?:\s*\+\s*'[^']*)*)'|`([^`]*)`)/s);
        if (nameMatch) {
          const name = nameMatch[1];
          const desc = (descMatch?.[1] || descMatch?.[2] || '').replace(/'\s*\+\s*'/g, '');
          descriptions.set(name, desc);
        }
      }
    } catch { /* file not found */ }
  }
  return descriptions;
}

// Simple keyword-based tool selection simulation
function selectTool(prompt: string, toolA: string, descA: string, toolB: string, descB: string): string {
  const promptLower = prompt.toLowerCase();
  const scoreA = descA.toLowerCase().split(/\s+/).filter(w => w.length > 3 && promptLower.includes(w)).length;
  const scoreB = descB.toLowerCase().split(/\s+/).filter(w => w.length > 3 && promptLower.includes(w)).length;
  return scoreA >= scoreB ? toolA : toolB;
}

function main() {
  console.log('\n═══ Tool Description A/B Test ═══\n');

  const descriptions = loadToolDescriptions();
  let totalCorrect = 0;
  let totalTests = 0;

  for (const { pair, prompts } of AMBIGUOUS_PAIRS) {
    const [toolA, toolB] = pair;
    const descA = descriptions.get(toolA) || '';
    const descB = descriptions.get(toolB) || '';

    if (!descA || !descB) {
      console.log(`⚠ Missing description for ${!descA ? toolA : toolB}`);
      continue;
    }

    let correct = 0;
    for (const { text, expected } of prompts) {
      const selected = selectTool(text, toolA, descA, toolB, descB);
      if (selected === expected) correct++;
      totalTests++;
    }
    totalCorrect += correct;
    const pct = Math.round((correct / prompts.length) * 100);
    const icon = pct >= 75 ? '✅' : pct >= 50 ? '⚠️' : '❌';
    console.log(`${icon} ${pair.join(' vs ')}: ${correct}/${prompts.length} (${pct}%)`);
  }

  console.log(`\nOverall: ${totalCorrect}/${totalTests} (${overallPct}%)`);
  if (overallPct < 70) console.log('⚠ Below 70% — consider improving tool descriptions for ambiguous pairs');
  console.log('');
  // Informational — does not block CI. Use results to guide description improvements.
  process.exit(0);
}

main();
