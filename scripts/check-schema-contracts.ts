#!/usr/bin/env npx tsx
// H3/H6: Schema contract test — validates Lambda response shapes against expected contracts.
// Run: npx tsx scripts/check-schema-contracts.ts
// Requires VELIXAR_API_KEY and VELIXAR_API_BASE env vars.
// Exits non-zero on shape mismatch — designed for CI.

const API_KEY = process.env.VELIXAR_API_KEY;
const API_BASE = process.env.VELIXAR_API_BASE || 'https://api.velixar.ai';

if (!API_KEY) {
  console.log('⚠ VELIXAR_API_KEY not set — skipping live schema validation');
  process.exit(0);
}

interface Check {
  name: string;
  method: 'GET' | 'POST';
  path: string;
  body?: Record<string, unknown>;
  validate: (data: unknown) => string | null; // null = pass, string = error
}

const has = (obj: unknown, key: string): boolean =>
  typeof obj === 'object' && obj !== null && key in (obj as Record<string, unknown>);

const checks: Check[] = [
  {
    name: 'health',
    method: 'GET',
    path: '/health',
    validate: (d) => has(d, 'status') ? null : 'missing status field',
  },
  {
    name: 'memory/search',
    method: 'GET',
    path: '/memory/search?q=test&limit=1',
    validate: (d) => {
      if (!has(d, 'memories')) return 'missing memories array';
      if (!Array.isArray((d as Record<string, unknown>).memories)) return 'memories is not an array';
      return null;
    },
  },
  {
    name: 'memory/list',
    method: 'GET',
    path: '/memory/list?limit=1',
    validate: (d) => {
      if (!has(d, 'memories')) return 'missing memories array';
      if (!Array.isArray((d as Record<string, unknown>).memories)) return 'memories is not an array';
      return null;
    },
  },
  {
    name: 'memory/identity',
    method: 'GET',
    path: '/memory/identity',
    validate: (d) => has(d, 'identity') || has(d, 'error') ? null : 'missing identity or error field',
  },
  {
    name: 'exocortex/overview',
    method: 'GET',
    path: '/exocortex/overview',
    validate: (d) => {
      const r = d as Record<string, unknown>;
      if (has(r, 'error')) return null; // error responses are valid
      if (!has(r, 'total_memories') && !has(r, 'memory_count')) return 'missing total_memories field';
      return null;
    },
  },
  {
    name: 'exocortex/contradictions',
    method: 'GET',
    path: '/exocortex/contradictions?status=open',
    validate: (d) => {
      if (!has(d, 'contradictions')) return 'missing contradictions array';
      if (!Array.isArray((d as Record<string, unknown>).contradictions)) return 'contradictions is not an array';
      return null;
    },
  },
  {
    name: 'graph/traverse',
    method: 'POST',
    path: '/graph/traverse',
    body: { entity: '__schema_test__', max_hops: 1 },
    validate: (d) => {
      const r = d as Record<string, unknown>;
      if (has(r, 'error')) return null;
      if (!has(r, 'nodes') && !has(r, 'entities') && !has(r, 'results')) return 'missing nodes/entities/results';
      return null;
    },
  },
  {
    name: 'memory/multi_search',
    method: 'POST',
    path: '/memory/multi_search',
    body: { queries: ['__schema_test__'], limit_per_query: 1 },
    validate: (d) => {
      const r = d as Record<string, unknown>;
      if (has(r, 'error')) return null;
      if (!has(r, 'results')) return 'missing results array';
      if (!Array.isArray((r as Record<string, unknown>).results)) return 'results is not an array';
      return null;
    },
  },
  {
    name: 'memory/search_by_vector',
    method: 'POST',
    path: '/memory/search_by_vector',
    body: { memory_id: '00000000-0000-0000-0000-000000000000', limit: 1 },
    validate: (d) => {
      const r = d as Record<string, unknown>;
      if (has(r, 'error')) return null; // 404 for non-existent ID is acceptable
      if (!has(r, 'neighbors') && !has(r, 'memories')) return 'missing neighbors array';
      return null;
    },
  },
  {
    name: 'memory/coverage',
    method: 'POST',
    path: '/memory/coverage',
    body: { topic: '__schema_test__', memory_ids: ['__test__'] },
    validate: (d) => {
      const r = d as Record<string, unknown>;
      if (has(r, 'error')) return null;
      if (!has(r, 'coverage_ratio') && !has(r, 'total_relevant')) return 'missing coverage_ratio or total_relevant';
      return null;
    },
  },
];

async function call(check: Check): Promise<{ name: string; pass: boolean; error?: string }> {
  const url = `${API_BASE}/v1${check.path}`;
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${API_KEY}`,
    'Content-Type': 'application/json',
  };
  try {
    const res = await fetch(url, {
      method: check.method,
      headers,
      ...(check.body ? { body: JSON.stringify(check.body) } : {}),
    });
    const data = await res.json();
    const err = check.validate(data);
    return { name: check.name, pass: !err, error: err || undefined };
  } catch (e) {
    return { name: check.name, pass: false, error: `fetch failed: ${(e as Error).message}` };
  }
}

async function main() {
  console.log(`\n═══ Schema Contract Tests ═══\n`);
  console.log(`API: ${API_BASE}\n`);

  const results = await Promise.all(checks.map(call));
  let failures = 0;

  for (const r of results) {
    if (r.pass) {
      console.log(`✅ ${r.name}`);
    } else {
      console.log(`❌ ${r.name}: ${r.error}`);
      failures++;
    }
  }

  console.log(`\n${results.length - failures}/${results.length} passed\n`);
  process.exit(failures > 0 ? 1 : 0);
}

main();
