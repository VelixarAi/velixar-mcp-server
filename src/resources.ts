// ── Velixar MCP Server — Resources ──
// Three startup resources per strategy memo:
//   velixar://identity/current — user identity profile
//   velixar://memories/recent — compact recent memories
//   velixar://system/constitution — cognitive behavioral constitution

import type { ApiClient } from './api.js';
import type { ApiConfig } from './types.js';

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

const IDENTITY_STALE_MS = 24 * 60 * 60 * 1000; // 24h

// ── Constitution (static, versioned with server) ──

const CONSTITUTION_VERSION = '0.5.0';
const CONSTITUTION = `# Velixar Cognitive Constitution v${CONSTITUTION_VERSION}

## Core Principle
Prefer the smallest tool that answers the current cognitive question.

## Cognitive Modes
| Mode | Question | First Tool |
|------|----------|------------|
| Orientation | "Understand the situation broadly" | velixar_context |
| Retrieval | "I know what I'm looking for" | velixar_search |
| Structure | "Understand connections" | velixar_graph_traverse |
| Continuity | "How did this evolve?" | velixar_timeline |
| Conflict | "Something contradicts" | velixar_contradictions |
| Consolidation | "Preserve what matters" | velixar_distill |

## Master Pattern: Orient Then Narrow
1. Start with velixar_context for broad orientation
2. Identify the cognitive mode from the user's question
3. Narrow with the specialized tool for that mode
4. Stop when the question is answered — do not chain unnecessarily

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
- Workspace bleed is a critical defect`;

// ── Fetch ──

export async function fetchRecall(api: ApiClient, config: ApiConfig): Promise<void> {
  const promises: Promise<void>[] = [];

  // Memories
  if (process.env.VELIXAR_AUTO_RECALL !== 'false') {
    const limit = parseInt(process.env.VELIXAR_RECALL_LIMIT || '10', 10);
    promises.push(
      api.get<{ memories?: MemoryRecord[] }>(
        `/memory/list?user_id=${config.userId}&limit=${limit}`, true,
      ).then(r => { _memories = r.memories || []; })
       .catch(() => { _memories = []; }),
    );
  }

  // Identity
  promises.push(
    api.get<{ identity?: IdentityData }>('/memory/identity', true)
      .then(r => {
        _identity = r.identity || null;
        _identityFetchedAt = Date.now();
      })
      .catch(() => { _identity = null; }),
  );

  await Promise.allSettled(promises);
}

export function refreshIdentity(api: ApiClient): void {
  api.get<{ identity?: IdentityData }>('/memory/identity', true)
    .then(r => { _identity = r.identity || null; _identityFetchedAt = Date.now(); })
    .catch(() => {});
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

  return { resources };
}

// ── Read Resource ──

export function readResource(uri: string) {
  if (uri === 'velixar://system/constitution') {
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
        // Compact: truncate to 200 chars, include ID for inspection
        const content = m.content.length > 200 ? m.content.slice(0, 200) + '…' : m.content;
        const id = m.id ? ` (${m.id})` : '';
        return `${i + 1}. ${content}${tags}${id}`;
      })
      .join('\n');
    return { contents: [{ uri, mimeType: 'text/plain', text: text || 'No memories found.' }] };
  }

  throw new Error(`Unknown resource: ${uri}`);
}

export function getResourceUris(): string[] {
  const uris = ['velixar://system/constitution', 'velixar://identity/current'];
  if (_memories?.length) uris.push('velixar://memories/recent');
  return uris;
}
