// Update nudge — signals A + B, one notice.
//
// Two independent ways to learn "a newer velixar-mcp-server exists", both funnelled
// into a SINGLE session-scoped notice that rides the next tool response's meta:
//
//   A (backend-driven): every API response carries an `X-Velixar-Mcp-Latest` header,
//     server-controlled via the backend's VELIXAR_MCP_LATEST env. The client compares
//     it to its own VERSION — so Velixar retargets the nudge without any client
//     redeploy, and it works even when npm is unreachable.
//   B (client self-check): at startup the client asks the npm registry directly for
//     the published latest. Independent of the backend; catches PINNED users (the ones
//     npx never auto-upgrades) and fires before the first tool call.
//
// Hard boundary: a stdio binary sitting idle cannot be pushed to, so we can never
// reach a user *before* their next use — only make that next tool call carry the word.
// Both signals are best-effort and fail silent: a nudge must never break a tool call.

import { VERSION } from './version.js';

let latestSeen: string | null = null; // newest "latest" learned from A or B
let shown = false;                     // one notice per process — never nag

/**
 * semver-ish "is `a` strictly older than `b`", comparing the numeric MAJOR.MINOR.PATCH.
 * Anything non-numeric or short (pre-release tags, garbage) → false, so we never nag on
 * noise. Only a clean, unambiguous "you are behind" trips the notice.
 */
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

/** Record a candidate "latest" from either signal; keep the newest, ignore anything not ahead of us. */
export function noteLatest(candidate: string | null | undefined): void {
  if (!candidate || typeof candidate !== 'string') return;
  if (!isOlder(VERSION, candidate)) return;                  // we're current or ahead
  if (latestSeen && !isOlder(latestSeen, candidate)) return; // already knew an equal/newer target
  latestSeen = candidate;
}

/** A — the backend advertises latest on every response header. */
export function noteFromHeader(headerValue: string | null | undefined): void {
  noteLatest(headerValue || undefined);
}

/** B — ask npm directly, once, at startup. Fire-and-forget, fail-silent, short timeout. */
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
  } catch {
    // offline / airgapped / npm down — signal A (the response header) still covers it.
  }
}

export interface UpdateNotice {
  current: string;
  latest: string;
  message: string;
}

/**
 * Consume the pending notice, ONCE per process. Returns what to surface, or null.
 * Called from makeMeta, so the notice lands on the first tool response after either
 * signal marks us behind — then never again this session.
 */
export function takeUpdateNotice(): UpdateNotice | null {
  if (shown || !latestSeen) return null;
  shown = true;
  return {
    current: VERSION,
    latest: latestSeen,
    message:
      `A newer Velixar MCP server is available (you are on ${VERSION}, latest is ${latestSeen}). ` +
      `Update your MCP config to velixar-mcp-server@${latestSeen} (or drop the version pin to always get latest) and restart your client.`,
  };
}

/** Test seam — reset module state between cases. */
export function _reset(): void { latestSeen = null; shown = false; }
