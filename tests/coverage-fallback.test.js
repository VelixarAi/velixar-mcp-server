// The coverage_check FALLBACK must not invert at zero data.
//
// The backend fix (v16) made 0/0 read as UNKNOWN on the main path — but the
// client-side fallback (backend coverage endpoint unreachable → broad search +
// set difference) kept the old inversion: zero relevant memories returned
// coverage_ratio 1 / confidence high. An agent trusting that would confidently
// synthesize from nothing. Found by an external pressure test 2026-07-17.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleRetrievalTool } from '../dist/tools/retrieval.js';

const config = {
  apiKey: 'vlx_test', apiBase: 'https://api.test.invalid',
  workspaceId: 'ws-test', timeoutMs: 1000, debug: false,
};

function fakeApi({ searchMemories }) {
  return {
    // Backend coverage endpoint down → forces the fallback branch.
    async post() { throw new Error('coverage endpoint unreachable'); },
    async get(path) {
      if (path.startsWith('/memory/search')) return { memories: searchMemories, count: searchMemories.length };
      throw new Error(`unexpected GET ${path}`);
    },
  };
}

test('fallback at zero data reports UNKNOWN, never full/high', async () => {
  const api = fakeApi({ searchMemories: [] });
  const res = await handleRetrievalTool('velixar_coverage_check',
    { topic: 'nonexistent topic', memory_ids: ['m1'] }, api, config);
  const body = JSON.parse(res.text);
  const d = body.data ?? body;
  assert.equal(d._fallback, true, 'must have exercised the fallback branch');
  assert.equal(d.coverage_ratio, null, '0/0 must be null, not 1');
  assert.equal(d.coverage_status, 'no_relevant_memories');
  assert.equal(d.confidence_assessment, 'unknown');
});

test('fallback with real data still computes a real ratio', async () => {
  const mems = [
    { id: 'm1', content: 'alpha memory content', tags: [], created_at: '2026-07-17T00:00:00Z' },
    { id: 'm2', content: 'beta memory content', tags: [], created_at: '2026-07-17T00:00:00Z' },
  ];
  const api = fakeApi({ searchMemories: mems });
  const res = await handleRetrievalTool('velixar_coverage_check',
    { topic: 'alpha beta', memory_ids: ['m1'] }, api, config);
  const d = JSON.parse(res.text).data ?? JSON.parse(res.text);
  assert.equal(d._fallback, true);
  assert.equal(d.coverage_ratio, 0.5, 'covered 1 of 2 relevant');
  assert.equal(d.coverage_status, 'partial');
  assert.notEqual(d.confidence_assessment, 'unknown');
});
