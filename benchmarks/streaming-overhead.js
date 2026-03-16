#!/usr/bin/env node
// ── M9: Streaming Overhead Benchmark ──
// Measures response serialization overhead with and without chunking.
// Usage: node benchmarks/streaming-overhead.js

const ITERATIONS = 100;

// Simulate typical MCP tool responses of varying sizes
const payloads = [
  { name: 'small', data: JSON.stringify({ status: 'ok', data: { id: 'mem-1', content: 'short' } }) },
  { name: 'medium', data: JSON.stringify({ status: 'ok', data: { memories: Array.from({ length: 20 }, (_, i) => ({ id: `mem-${i}`, content: `Memory content ${i} with some detail about the topic at hand`, tags: ['tag1', 'tag2'], tier: 2 })) } }) },
  { name: 'large', data: JSON.stringify({ status: 'ok', data: { memories: Array.from({ length: 100 }, (_, i) => ({ id: `mem-${i}`, content: `Memory ${i}: ${'x'.repeat(200)}`, tags: ['a', 'b', 'c'], tier: 2, created_at: new Date().toISOString() })) } }) },
];

function benchBuffered(payload) {
  const start = performance.now();
  for (let i = 0; i < ITERATIONS; i++) {
    // Buffered: single JSON.stringify + single write
    const out = JSON.stringify({ jsonrpc: '2.0', id: i, result: { content: [{ type: 'text', text: payload }] } });
    // Simulate write cost
    Buffer.from(out);
  }
  return (performance.now() - start) / ITERATIONS;
}

function benchChunked(payload, chunkSize = 4096) {
  const start = performance.now();
  for (let i = 0; i < ITERATIONS; i++) {
    // Chunked: split payload into chunks, wrap each
    const full = JSON.stringify({ jsonrpc: '2.0', id: i, result: { content: [{ type: 'text', text: payload }] } });
    const chunks = [];
    for (let j = 0; j < full.length; j += chunkSize) {
      chunks.push(Buffer.from(full.slice(j, j + chunkSize)));
    }
  }
  return (performance.now() - start) / ITERATIONS;
}

console.log('\n═══ Streaming Overhead Benchmark ═══\n');
console.log(`Iterations per test: ${ITERATIONS}\n`);

const results = [];
for (const { name, data } of payloads) {
  const bufferedMs = benchBuffered(data);
  const chunkedMs = benchChunked(data);
  const overhead = ((chunkedMs - bufferedMs) / bufferedMs * 100);
  const sizeKB = (Buffer.byteLength(data) / 1024).toFixed(1);
  results.push({ name, sizeKB, bufferedMs, chunkedMs, overhead });
  console.log(`${name} (${sizeKB}KB):`);
  console.log(`  Buffered: ${bufferedMs.toFixed(3)}ms  Chunked: ${chunkedMs.toFixed(3)}ms  Overhead: ${overhead.toFixed(1)}%`);
}

const avgOverhead = results.reduce((s, r) => s + r.overhead, 0) / results.length;
console.log(`\nAverage chunking overhead: ${avgOverhead.toFixed(1)}%`);
if (avgOverhead > 50) {
  console.log('⚠ High overhead — consider disabling chunking on buffered transports');
} else {
  console.log('✅ Chunking overhead is acceptable');
}
