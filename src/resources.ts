// ── Velixar MCP Server — Resources ──
// Auto-recall recent memories resource.
// Identity and constitution resources will be added in Phase 2/4.

import type { ApiClient } from './api.js';
import type { ApiConfig } from './types.js';

interface MemoryRecord {
  content: string;
  tags?: string[];
  tier?: number;
}

let _recalledMemories: MemoryRecord[] | null = null;

export async function fetchRecall(api: ApiClient, config: ApiConfig): Promise<void> {
  if (process.env.VELIXAR_AUTO_RECALL === 'false') return;
  const limit = parseInt(process.env.VELIXAR_RECALL_LIMIT || '10', 10);
  try {
    const params = new URLSearchParams({ user_id: config.userId, limit: String(limit) });
    const result = await api.get<{ memories?: MemoryRecord[] }>(`/memory/list?${params}`, true);
    _recalledMemories = result.memories || [];
  } catch {
    _recalledMemories = [];
  }
}

export function getResourceList() {
  if (process.env.VELIXAR_AUTO_RECALL === 'false' || !_recalledMemories?.length) {
    return { resources: [] };
  }
  return {
    resources: [
      {
        uri: 'velixar://memories/recent',
        name: 'Velixar — Recent Memories',
        description: `${_recalledMemories.length} most recent memories from your Velixar memory store`,
        mimeType: 'text/plain',
      },
    ],
  };
}

export function readResource(uri: string) {
  if (uri === 'velixar://memories/recent') {
    const text = (_recalledMemories || [])
      .map(m => {
        const tags = m.tags?.length ? ` [${m.tags.join(', ')}]` : '';
        const tier = m.tier != null ? ` (tier ${m.tier})` : '';
        return `${m.content}${tags}${tier}`;
      })
      .join('\n---\n');
    return {
      contents: [
        {
          uri: 'velixar://memories/recent',
          mimeType: 'text/plain',
          text: text || 'No memories found.',
        },
      ],
    };
  }
  throw new Error(`Unknown resource: ${uri}`);
}

export function getResourceUris(): string[] {
  return _recalledMemories?.length ? ['velixar://memories/recent'] : [];
}
