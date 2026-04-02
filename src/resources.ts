// ── Velixar MCP Server — Resources ──
// Three startup resources per strategy memo:
//   velixar://identity/current — user identity profile
//   velixar://memories/recent — compact recent memories
//   velixar://system/constitution — cognitive behavioral constitution

import type { ApiClient } from './api.js';
import type { ApiConfig } from './types.js';
import { COGNITIVE_MODES, renderModesTable } from './prompts.js';

interface MemoryRecord {
  id?: string;
  content: string;
  tags?: string[];
  tier?: number;
  created_at?: string;
}

interface IdentityData {
  preferences?: Record<string, unknown>;
  expertise?: string[];
  communication_style?: string;
  recurring_goals?: string[];
  stable_constraints?: string[];
}

let _memories: MemoryRecord[] | null = null;
let _identity: IdentityData | null = null;
let _identityFetchedAt: number | null = null;
let _relevantMemories: MemoryRecord[] | null = null;
let _relevantStaleAfter = 0; // timestamp after which relevant memories are stale
let _toolCallsSinceRefresh = 0;
let _constitutionRead = false; // H1: tracks if host has read constitution resource

const IDENTITY_STALE_MS = 24 * 60 * 60 * 1000; // 24h
const RELEVANT_STALE_CALLS = 5; // refresh after 5 tool calls

// ── Constitution (static, versioned with server) ──

const CONSTITUTION_VERSION = '0.6.0';
const CONSTITUTION = `# Velixar Cognitive Constitution v${CONSTITUTION_VERSION}

## Core Principle
Prefer the smallest tool that answers the current cognitive question.

## Cognitive Modes
${renderModesTable()}

## Master Pattern: Orient Then Narrow
1. Start with velixar_context for broad orientation
2. Identify the cognitive mode from the user's question
3. Narrow with the specialized tool for that mode
4. Stop when the question is answered — do not chain unnecessarily

## Two-Tool Path for Complex Synthesis
For complex questions requiring comprehensive, verified context:
1. velixar_context — orient (what exists?)
2. velixar_prepare_context — assemble verified context with gap declaration
This handles multi-angle search, coverage verification, and temporal analysis internally.
Use velixar_search for simple factual lookups — do not over-engineer simple questions.

## Anti-Patterns (never do these)
- Never dump raw memory lists without synthesis
- Never present inferred content as retrieved fact
- Never ignore contradictions — surface them explicitly
- Never leak data across workspaces
- Never assert identity claims without evidence

## Response Classes
1. **Retrieved** — directly from stored memory. Assert confidently.
2. **Inferred** — synthesized from multiple memories or patterns. Qualify with confidence.
3. **Speculative** — hypothesis with weak or no evidence. Present as exploratory or do not assert.

## Justification Rules
- Every synthesized claim carries a justification with claim type, confidence, and evidence
- Presentation mode (assertive → do_not_assert) is determined by claim type × confidence
- Longer derivation chains require lower assertiveness
- Contradictions reduce confidence regardless of evidence strength

## Workspace Isolation
- All operations are workspace-scoped
- Never generalize workspace-local identity to global without explicit policy
- Workspace bleed is a critical defect

## Episodic Memory Aging
- Episodic memories are eligible for archival after semantic extraction (via velixar_distill or velixar_consolidate)
- Semantic memories persist indefinitely — updated, never archived
- Archived episodic memories remain accessible via velixar_timeline and velixar_inspect but are excluded from active context (velixar_context, velixar_search)
- When consolidating, always preserve original episodic IDs as provenance`;

// ── Fetch ──

export async function fetchRecall(api: ApiClient, config: ApiConfig): Promise<void> {
  const promises: Promise<void>[] = [];

  // Memories
  if (process.env.VELIXAR_AUTO_RECALL !== 'false') {
    const limit = parseInt(process.env.VELIXAR_RECALL_LIMIT || '10', 10);
    promises.push(
    api.get<unknown>(`/memory/list?user_id=${config.userId}&limit=${limit}`, true,
    ).then(r => {
      const rObj = (r && typeof r === 'object') ? r as Record<string, unknown> : {};
      _memories = Array.isArray(rObj.memories) ? rObj.memories as MemoryRecord[] : [];
    })
     .catch(() => { _memories = []; }),
    );
  }

  // Identity
  promises.push(
    api.get<unknown>('/memory/identity', true)
      .then(r => {
        const rObj = (r && typeof r === 'object') ? r as Record<string, unknown> : {};
        _identity = (rObj.identity && typeof rObj.identity === 'object') ? rObj.identity as IdentityData : null;
        _identityFetchedAt = Date.now();
      })
      .catch(() => { _identity = null; }),
  );

  // Relevant memories (proactive)
  const relevantParams = new URLSearchParams({
    q: 'important recent context',
    user_id: config.userId,
    limit: '10',
  });
  promises.push(
    api.get<unknown>(`/memory/search?${relevantParams}`, true)
      .then(r => {
        const rObj = (r && typeof r === 'object') ? r as Record<string, unknown> : {};
        _relevantMemories = Array.isArray(rObj.memories) ? rObj.memories as MemoryRecord[] : [];
        _relevantStaleAfter = Date.now() + 5 * 60 * 1000;
        _toolCallsSinceRefresh = 0;
      })
      .catch(() => { _relevantMemories = []; }),
  );

  await Promise.allSettled(promises);
}

export function refreshIdentity(api: ApiClient): void {
  api.get<unknown>('/memory/identity', true)
    .then(r => {
      const rObj = (r && typeof r === 'object') ? r as Record<string, unknown> : {};
      _identity = (rObj.identity && typeof rObj.identity === 'object') ? rObj.identity as IdentityData : null;
      _identityFetchedAt = Date.now();
    })
    .catch(() => {});
}

export function refreshRelevantMemories(api: ApiClient, config: ApiConfig): void {
  const params = new URLSearchParams({
    q: 'important recent context',
    user_id: config.userId,
    limit: '10',
  });
  api.get<unknown>(`/memory/search?${params}`, true)
    .then(r => {
      const rObj = (r && typeof r === 'object') ? r as Record<string, unknown> : {};
      _relevantMemories = Array.isArray(rObj.memories) ? rObj.memories as MemoryRecord[] : [];
      _relevantStaleAfter = Date.now() + 5 * 60 * 1000; // 5 min
      _toolCallsSinceRefresh = 0;
    })
    .catch(() => {});
}

export function markToolCall(): void {
  _toolCallsSinceRefresh++;
}

export function isRelevantStale(): boolean {
  return _toolCallsSinceRefresh >= RELEVANT_STALE_CALLS || Date.now() > _relevantStaleAfter;
}

// ── Resource List ──

export function getResourceList() {
  const resources: Array<{ uri: string; name: string; description: string; mimeType: string }> = [];

  // Always expose constitution
  resources.push({
    uri: 'velixar://system/constitution',
    name: 'Velixar — Cognitive Constitution',
    description: 'Behavioral rules, cognitive modes, anti-patterns, and justification policy',
    mimeType: 'text/plain',
  });

  // Identity (even if empty — signals absence)
  const identityStale = _identityFetchedAt
    ? Date.now() - _identityFetchedAt > IDENTITY_STALE_MS
    : true;
  resources.push({
    uri: 'velixar://identity/current',
    name: 'Velixar — User Identity',
    description: _identity
      ? `User profile${identityStale ? ' (stale — >24h since refresh)' : ''}`
      : 'No identity profile yet — store preferences to build one',
    mimeType: 'text/plain',
  });

  // Recent memories
  if (_memories?.length) {
    resources.push({
      uri: 'velixar://memories/recent',
      name: 'Velixar — Recent Memories',
      description: `${_memories.length} recent memories (compact summaries)`,
      mimeType: 'text/plain',
    });
  }

  // Relevant memories (proactive)
  if (_relevantMemories?.length) {
    const stale = isRelevantStale();
    resources.push({
      uri: 'velixar://memories/relevant',
      name: 'Velixar — Relevant Memories',
      description: `${_relevantMemories.length} contextually relevant memories${stale ? ' (stale — refresh recommended)' : ''}`,
      mimeType: 'text/plain',
    });
  }

  // Shadow graph (domain-scoped knowledge graph view)
  resources.push({
    uri: 'velixar://domains/{domain}/shadow_graph',
    name: 'Velixar — Domain Shadow Graph',
    description: 'Knowledge graph entities and relationships for a specific domain. Replace {domain} with the domain name.',
    mimeType: 'application/json',
  });

  return { resources };
}

// ── Read Resource ──

export async function readResource(uri: string, api?: ApiClient) {
  if (uri === 'velixar://system/constitution') {
    _constitutionRead = true;
    return { contents: [{ uri, mimeType: 'text/plain', text: CONSTITUTION }] };
  }

  if (uri === 'velixar://identity/current') {
    if (!_identity || Object.keys(_identity).length === 0) {
      return { contents: [{ uri, mimeType: 'text/plain', text: 'No identity profile available. Store user preferences and expertise to build one.' }] };
    }
    const stale = _identityFetchedAt ? Date.now() - _identityFetchedAt > IDENTITY_STALE_MS : false;
    const lines: string[] = [];
    if (stale) lines.push('⚠ Identity data is stale (>24h since last refresh)\n');
    if (_identity.expertise?.length) lines.push(`Expertise: ${_identity.expertise.join(', ')}`);
    if (_identity.communication_style) lines.push(`Communication style: ${_identity.communication_style}`);
    if (_identity.recurring_goals?.length) lines.push(`Goals: ${_identity.recurring_goals.join(', ')}`);
    if (_identity.stable_constraints?.length) lines.push(`Constraints: ${_identity.stable_constraints.join(', ')}`);
    if (_identity.preferences && Object.keys(_identity.preferences).length) {
      lines.push(`Preferences: ${Object.entries(_identity.preferences).map(([k, v]) => `${k}=${v}`).join(', ')}`);
    }
    return { contents: [{ uri, mimeType: 'text/plain', text: lines.join('\n') || 'Identity profile is empty.' }] };
  }

  if (uri === 'velixar://memories/recent') {
    const text = (_memories || [])
      .map((m, i) => {
        const tags = m.tags?.length ? ` [${m.tags.join(', ')}]` : '';
        const content = m.content.length > 200 ? m.content.slice(0, 200) + '…' : m.content;
        const id = m.id ? ` (${m.id})` : '';
        return `${i + 1}. ${content}${tags}${id}`;
      })
      .join('\n');
    return { contents: [{ uri, mimeType: 'text/plain', text: text || 'No memories found.' }] };
  }

  if (uri === 'velixar://memories/relevant') {
    const stale = isRelevantStale();
    const lines: string[] = [];
    if (stale) lines.push('⚠ Relevant memories may be stale — consider refreshing via velixar_context\n');
    for (const [i, m] of (_relevantMemories || []).entries()) {
      const tags = m.tags?.length ? ` [${m.tags.join(', ')}]` : '';
      const content = m.content.length > 200 ? m.content.slice(0, 200) + '…' : m.content;
      const id = m.id ? ` (${m.id})` : '';
      lines.push(`${i + 1}. ${content}${tags}${id}`);
    }
    return { contents: [{ uri, mimeType: 'text/plain', text: lines.join('\n') || 'No relevant memories yet.' }] };
  }

  // Shadow graph — velixar://domains/{domain}/shadow_graph
  const shadowMatch = uri.match(/^velixar:\/\/domains\/([^/]+)\/shadow_graph$/);
  if (shadowMatch && api) {
    const domain = decodeURIComponent(shadowMatch[1]);
    try {
      const result = await api.post<Record<string, unknown>>('/graph/search', { query: domain, limit: 50 });
      const r = result as Record<string, unknown>;
      const entities = Array.isArray(r.entities) ? r.entities : Array.isArray(r.results) ? r.results : [];
      // M23: Add freshness metadata to each entity
      const now = Date.now();
      const enriched = entities.map((e: Record<string, unknown>) => {
        const createdAt = String(e.created_at || e.node_created_at || '');
        const createdMs = createdAt ? new Date(createdAt).getTime() : 0;
        const stalenessDays = createdMs > 0 ? Math.floor((now - createdMs) / (1000 * 60 * 60 * 24)) : null;
        return { ...e, node_created_at: createdAt || null, staleness_days: stalenessDays };
      });
      return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify({ domain, entities: enriched, count: enriched.length }) }] };
    } catch {
      return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify({ domain, entities: [], count: 0, error: 'Graph search unavailable' }) }] };
    }
  }

  throw new Error(`Unknown resource: ${uri}`);
}

export function getResourceUris(): string[] {
  const uris = ['velixar://system/constitution', 'velixar://identity/current', 'velixar://domains/{domain}/shadow_graph'];
  if (_memories?.length) uris.push('velixar://memories/recent');
  if (_relevantMemories?.length) uris.push('velixar://memories/relevant');
  return uris;
}

// H1: Compact constitution fallback (~400 tokens) for hosts that don't read resources.
// Returns the compact text on first call per session, then null.
const COMPACT_CONSTITUTION = `Velixar Constitution (compact): ` +
  `Start with velixar_context for orientation, then narrow with the specialized tool matching the cognitive mode. ` +
  `Modes: ${COGNITIVE_MODES.map(m => `${m.mode}→${m.tool.replace('velixar_', '')}`).join(', ')}. ` +
  `Stop when answered. Never dump raw lists. Qualify inferred claims. Surface contradictions. Never leak across workspaces.`;

export function getConstitutionFallback(): string | null {
  if (_constitutionRead) return null;
  _constitutionRead = true; // inject once per session
  return COMPACT_CONSTITUTION;
}
