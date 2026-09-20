// ── VOU Tools — the meter, readable by the agent that is generating it ──
//
// An agent should be able to ask "how much VOU has this workspace consumed
// today?" or "explain why my last execution consumed 23.4 VOU" without anyone
// opening a dashboard. That is the same requirement the CLI satisfies, and these
// tools read THE SAME endpoints (`/v1/vou/*`) so the two can never disagree.
//
// EVERY TOOL HERE IS READ-ONLY. There is no write, no correction, no schedule
// change and no rating override. The VOU ledger is append-only and enforced so by
// a database trigger; exposing a mutation through an MCP tool would put an
// economic act behind a model's tool call.
//
// AUTHORIZATION IS THE BACKEND'S, NOT OURS.
// These tools carry no workspace parameter. The backend answers for the workspace
// the API key authenticated as, and requires an explicit `usage:read` scope
// (`usage:audit` for reconcile, `usage:export` for export). A key that can store
// and recall memories cannot read the meter unless it was granted that scope. So
// a client cannot reach another tenant's consumption by asking nicely, and cannot
// reach its own without being entitled to.
//
// NOTHING HERE RETURNS PAYLOADS. The backend strips credential-bearing and
// content-bearing fields before responding; these tools surface metadata only.

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ApiClient } from '../api.js';
import { wrapResponse } from '../api.js';
import type { ApiConfig } from '../types.js';

const BETA_NOTE =
  'VOU BETA — NOT FOR BILLING. Weights are ASSUMPTION pending measured unit costs; ' +
  'no monetary amount is derivable from these numbers.';

export const vouTools: Tool[] = [
  {
    name: 'vou_status',
    description:
      'Health of the VOU meter for this workspace: GREEN / DEGRADED / BLOCKED / RED / UNKNOWN, ' +
      'schedule in force, normalizer lag, and any measurement gaps. A meter that cannot measure ' +
      'itself reports UNKNOWN rather than healthy. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        hours: { type: 'number', description: 'Window in hours (default 24)' },
      },
      required: [],
    },
  },
  {
    name: 'vou_usage',
    description:
      'How much VOU this workspace has consumed, broken down by operation family and operation ' +
      'type, with zero-rated operations and meter gaps reported alongside the total. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'string', description: 'ISO timestamp lower bound' },
        until: { type: 'string', description: 'ISO timestamp upper bound' },
      },
      required: [],
    },
  },
  {
    name: 'vou_explain',
    description:
      'Explain why a specific execution, request or ledger entry consumed the VOU it did, ' +
      'itemised by operation with the weight actually applied. The explanation is rebuilt from ' +
      'the stored ledger, never recomputed from current weights, so a past answer does not ' +
      'change when the schedule does. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Execution id, request id, or ledger id' },
        tree: { type: 'boolean', description: 'Return the nested execution tree instead' },
      },
      required: ['id'],
    },
  },
  {
    name: 'vou_execution',
    description:
      'The operation tree for one execution, including nested agents and swarms, with VOU per ' +
      'agent. VOU accrues at the leaf: a parent creates no orchestration charge. Read-only.',
    inputSchema: {
      type: 'object',
      properties: { execution_id: { type: 'string' } },
      required: ['execution_id'],
    },
  },
  {
    name: 'vou_gaps',
    description:
      'Where the meter FAILED to measure: unattributable operations, failed emissions, missing ' +
      'weights, operations with no resource evidence. A VOU total presented without its gaps is ' +
      'a claim rather than a measurement. Read-only.',
    inputSchema: {
      type: 'object',
      properties: { hours: { type: 'number' } },
      required: [],
    },
  },
  {
    name: 'vou_coverage',
    description:
      'How much of the declared operation catalog is instrumented and observed. Returns four ' +
      'separate numbers rather than one percentage, because "100% covered" has no agreed ' +
      'denominator. Read-only.',
    inputSchema: {
      type: 'object',
      properties: { hours: { type: 'number' } },
      required: [],
    },
  },
  {
    name: 'vou_recent',
    description:
      'Recent normalized VOU ledger entries for this workspace, newest first, with the agent, ' +
      'execution, MCP client and tool that produced each. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max entries (default 20)' },
        since: { type: 'string', description: 'ISO timestamp' },
      },
      required: [],
    },
  },
];

const VOU_TOOL_NAMES = new Set(vouTools.map((t) => t.name));

export function isVouTool(name: string): boolean {
  return VOU_TOOL_NAMES.has(name);
}

function num(value: unknown, fallback: number, lo: number, hi: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(lo, Math.min(hi, Math.trunc(parsed)));
}

export async function handleVouTool(
  name: string,
  args: Record<string, unknown>,
  api: ApiClient,
  config: ApiConfig,
): Promise<{ text: string; isError?: boolean }> {
  const query = new URLSearchParams();

  try {
    let path: string;

    switch (name) {
      case 'vou_status':
        query.set('hours', String(num(args.hours, 24, 1, 720)));
        path = `/v1/vou/status?${query}`;
        break;

      case 'vou_usage':
        if (typeof args.since === 'string') query.set('since', args.since);
        if (typeof args.until === 'string') query.set('until', args.until);
        path = `/v1/vou/summary?${query}`;
        break;

      case 'vou_explain': {
        if (typeof args.id !== 'string' || !args.id.trim()) {
          return { text: JSON.stringify({ error: 'id is required' }), isError: true };
        }
        query.set('id', args.id.trim());
        if (args.tree === true) query.set('tree', 'true');
        path = `/v1/vou/explain?${query}`;
        break;
      }

      case 'vou_execution': {
        if (typeof args.execution_id !== 'string' || !args.execution_id.trim()) {
          return { text: JSON.stringify({ error: 'execution_id is required' }), isError: true };
        }
        query.set('id', args.execution_id.trim());
        query.set('tree', 'true');
        path = `/v1/vou/explain?${query}`;
        break;
      }

      case 'vou_gaps':
        query.set('hours', String(num(args.hours, 24, 1, 720)));
        path = `/v1/vou/gaps?${query}`;
        break;

      case 'vou_coverage':
        query.set('hours', String(num(args.hours, 24, 1, 720)));
        path = `/v1/vou/coverage?${query}`;
        break;

      case 'vou_recent':
        query.set('limit', String(num(args.limit, 20, 1, 200)));
        if (typeof args.since === 'string') query.set('since', args.since);
        path = `/v1/vou/recent?${query}`;
        break;

      default:
        return { text: JSON.stringify({ error: `unknown VOU tool: ${name}` }), isError: true };
    }

    const result = await api.get<Record<string, unknown>>(path);
    // The banner travels with the DATA, not just in the tool description: a model
    // summarising this for a user will carry the field, and would not carry a
    // caveat that lived only in the schema it was given at connect time.
    return {
      text: JSON.stringify(wrapResponse({ ...result, beta_notice: BETA_NOTE }, config)),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A 403 here is the usual case and is not a fault: the key lacks usage:read.
    // Saying so plainly is more useful than a generic failure, and it does not
    // leak anything — the caller already knows which key it used.
    const hint = /403|scope/i.test(message)
      ? ' — this API key lacks the required usage scope (usage:read, or usage:audit / ' +
        'usage:export for those views). VOU scopes are granted explicitly and are not ' +
        'implied by memory:read.'
      : '';
    return { text: JSON.stringify({ error: `${message}${hint}` }), isError: true };
  }
}
