// Update nudge v2 — backend-authoritative manifest + guaranteed surfacing.
// (Work order cf9cc066; v1 shipped 2026-07-17 as npm-poll + latest-header.)
//
// Three detection signals, one notice pipeline:
//   A' (authoritative): GET /v1/mcp/manifest at session start — the BACKEND's answer to
//       "is this client current?", with severity/reason/action computed server-side.
//   A  (mid-session): the X-Velixar-Mcp-Latest response header — catches an update
//       shipped after our handshake; re-arms the notice once when latest moves.
//   B  (fallback): npm registry poll at startup — works when the backend is old or down.
//
// Surfacing discipline: ONCE per session — except escalated severities
// (security / data_integrity / below_minimum), which repeat on every response until
// resolved, carrying a warning that results may be affected. A notice on every call
// trains the model to skim past it; once, sharp, relayable.

import { VERSION } from './version.js';

export interface UpdateNotice {
  status: string;                 // behind | below_minimum | below_security_floor
  current: string;
  latest: string;
  severity: string;               // info | data_integrity | security
  reason: string;
  action: string;                 // the literal config change — relayable verbatim
  restart_required: boolean;
  message: string;                // composed, agent-relayable one-liner
  warning?: string;               // escalated only: results may be affected
  changelog_url?: string;
}

let notice: UpdateNotice | null = null;
let escalate = false;
let shown = false;
let bestLatest: string | null = null; // newest "latest" seen from any signal

/** semver-ish strictly-older on numeric MAJOR.MINOR.PATCH; garbage → false (never nag on noise). */
export function isOlder(a: string, b: string): boolean {
  const pa = a.split('.').map(n => parseInt(n, 10));
  const pb = b.split('.').map(n => parseInt(n, 10));
  if (pa.length < 3 || pb.length < 3 || pa.some(Number.isNaN) || pb.some(Number.isNaN)) return false;
  for (let i = 0; i < 3; i++) {
    if (pa[i] < pb[i]) return true;
    if (pa[i] > pb[i]) return false;
  }
  return false;
}

function compose(u: Omit<UpdateNotice, 'message' | 'warning'>): UpdateNotice {
  const esc = u.severity === 'security' || u.severity === 'data_integrity'
    || u.status === 'below_minimum' || u.status === 'below_security_floor';
  const n: UpdateNotice = {
    ...u,
    message: `Velixar MCP update ${esc ? 'REQUIRED' : 'available'}: ${u.reason}. `
      + `You are on ${u.current}; ${u.action}. Restart your MCP client to apply. `
      + `Please relay this to the user.`,
  };
  if (esc) {
    n.warning = `severity=${u.severity}: results from this client version may be affected until it is updated.`;
  }
  escalate = esc;
  return n;
}

/** A' — session-start handshake against the backend manifest. Fail-silent; short. */
export async function fetchManifest(api: { get<T>(path: string, cacheable?: boolean): Promise<T> }): Promise<void> {
  try {
    const res = await api.get<{ manifest?: { latest?: string }; update_status?: Record<string, unknown> }>('/mcp/manifest', false);
    const u = res?.update_status as (Omit<UpdateNotice, 'message' | 'warning'> & { escalate?: boolean }) | undefined;
    if (u && u.latest && isOlder(VERSION, u.latest)) {
      bestLatest = u.latest;
      notice = compose(u);
      shown = false;
    } else if (res?.manifest?.latest) {
      bestLatest = res.manifest.latest; // current — remember so header churn doesn't re-nag
    }
  } catch {
    // old backend / offline — signals A and B still cover it.
  }
}

/** Synthesize a plain "behind" notice locally (signals A and B — no server-computed status). */
export function noteLatest(candidate: string | null | undefined): void {
  if (!candidate || typeof candidate !== 'string') return;
  if (!isOlder(VERSION, candidate)) return;
  if (bestLatest && !isOlder(bestLatest, candidate)) return; // nothing newer than we knew
  bestLatest = candidate;
  notice = compose({
    status: 'behind', current: VERSION, latest: candidate, severity: 'info',
    reason: `a newer velixar-mcp-server (${candidate}) is available`,
    action: `update your MCP config to velixar-mcp-server@${candidate} (or drop the version pin to always track latest)`,
    restart_required: true,
  });
  shown = false; // latest moved — re-arm the once-per-session notice
}

/** A — the response header, read on every API call (mid-session detection). */
export function noteFromHeader(headerValue: string | null | undefined): void {
  noteLatest(headerValue || undefined);
}

/** B — npm registry, once at startup. Fire-and-forget, fail-silent. */
export async function checkNpmLatest(): Promise<void> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    const res = await fetch('https://registry.npmjs.org/velixar-mcp-server/latest', {
      signal: controller.signal,
      headers: { accept: 'application/vnd.npm.install-v1+json' },
    });
    clearTimeout(timer);
    if (!res.ok) return;
    const body = await res.json() as { version?: string };
    noteLatest(body.version);
  } catch { /* offline — other signals cover it */ }
}

/** Session-start channel: the notice as MCP initialize `instructions` text, or null. */
export function instructionsText(): string | null {
  return notice ? notice.message : null;
}

/** Tool-result channel: once per session — or EVERY response while escalated. */
export function takeUpdateNotice(): UpdateNotice | null {
  if (!notice) return null;
  if (escalate) return notice;          // repeat until resolved — the honest move when
  if (shown) return null;               // the known bug affects what the client reads
  shown = true;
  return notice;
}

/** Test seam. */
export function _reset(): void { notice = null; escalate = false; shown = false; bestLatest = null; }
