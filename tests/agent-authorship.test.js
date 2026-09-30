import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSearchResponse } from '../dist/validate.js';
import { normalizeMemory } from '../dist/api.js';

// The S03 backend stamps author_* on agent-principal writes; the validator used to drop them, so an
// agent-authored memory reached clients looking human-authored.
const row = { id: 'm1', content: 'x', author_principal_type: 'agent', author_principal_id: 'p-1', author_key_id: 'k-1',
  author_workspace_id: 'w-1', author_request_id: 'r-1', author_created_at: '2026-09-30T00:00:00Z' };

test('agent authorship survives validation and normalisation', () => {
  const v = validateSearchResponse({ memories: [row] }, '/memory/search').memories[0];
  assert.equal(v.author_principal_type, 'agent');
  const m = normalizeMemory(v);
  assert.deepEqual(m.agent_authorship, { principal_type: 'agent', principal_id: 'p-1', key_id: 'k-1', workspace_id: 'w-1', request_id: 'r-1', created_at: '2026-09-30T00:00:00Z' });
});

test('no authorship fields → no agent_authorship block (absent never means human)', () => {
  const m = normalizeMemory(validateSearchResponse({ memories: [{ id: 'm2', content: 'y' }] }, '/memory/search').memories[0]);
  assert.equal('agent_authorship' in m, false);
});

test('ill-typed authorship values are dropped, not coerced', () => {
  const v = validateSearchResponse({ memories: [{ id: 'm3', content: 'z', agent_authored: 'yes', author_principal_id: 42 }] }, '/memory/search').memories[0];
  assert.equal(v.agent_authored, undefined); assert.equal(v.author_principal_id, undefined);
});
