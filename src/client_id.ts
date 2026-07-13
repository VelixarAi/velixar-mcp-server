/**
 * Who is driving this server?
 *
 * The dashboard used to decide a tool was "connected" only if you minted its key
 * from that tool's tile — which wrote a binding row. So a tool that was genuinely
 * talking to Velixar with a key created anywhere else (a shell env var, the CLI,
 * an older dashboard) was INVISIBLE. Claude Code could be calling the API all day
 * and its tile still said nothing, because the API had no idea who was calling.
 *
 * The server already knew — it just never told anyone. The MCP handshake carries
 * `clientInfo`, and the SDK hands it to us via `getClientVersion()`. We normalise
 * it to the same slugs the dashboard uses and send it on every request, so
 * "connected" is EARNED BY TRAFFIC rather than asserted by a click.
 *
 * Env detection is only a fallback: the handshake is authoritative, but a few
 * hosts historically send a generic clientInfo, and their env vars are a better
 * signal than nothing.
 */

/** The dashboard's connector slugs. Keep in sync with velixar-web/src/lib/connectors.ts. */
export type ClientSlug =
  | 'claude_code' | 'claude_desktop' | 'cursor' | 'windsurf' | 'continue'
  | 'kiro' | 'cline' | 'zed' | 'codex' | 'goose' | 'opencode';

/**
 * Match on a normalised name (lowercased, non-alphanumerics stripped).
 * ORDER MATTERS: "claude code" must be tested before bare "claude", or Claude Code
 * would be reported as Claude Desktop.
 */
const RULES: [RegExp, ClientSlug][] = [
  [/claude.*code|code.*claude/, 'claude_code'],
  [/claude.*(desktop|ai)|^claude$/, 'claude_desktop'],
  [/cursor/, 'cursor'],
  [/windsurf|codeium/, 'windsurf'],
  [/continue/, 'continue'],
  [/kiro/, 'kiro'],
  [/cline/, 'cline'],
  [/zed/, 'zed'],
  [/codex/, 'codex'],
  [/goose/, 'goose'],
  [/opencode/, 'opencode'],
];

export function slugFromName(name?: string): ClientSlug | null {
  if (!name) return null;
  const n = name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  for (const [re, slug] of RULES) if (re.test(n)) return slug;
  return null;
}

/** Fallback only — used when the handshake name is absent or unrecognised. */
export function slugFromEnv(env: NodeJS.ProcessEnv = process.env): ClientSlug | null {
  if (env.CLAUDECODE || env.CLAUDE_CODE_SESSION) return 'claude_code';
  if (env.CURSOR_SESSION_ID) return 'cursor';
  if (env.WINDSURF_SESSION) return 'windsurf';
  if (env.CONTINUE_SESSION_ID) return 'continue';
  if (env.KIRO_SESSION) return 'kiro';
  return null;
}

/** The identity we report. `null` means "we genuinely do not know" — say nothing. */
export function resolveClient(name?: string): ClientSlug | null {
  return slugFromName(name) ?? slugFromEnv();
}
