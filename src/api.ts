// ── Velixar MCP Server — API Client ──
// Typed HTTP client with workspace header injection, retry, timeout, caching.

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ApiConfig, ApiTiming, MemoryItem, MemoryOrigin, MemoryType, ResponseMeta, SourceType, VelixarError, VelixarResponse } from './types.js';
import type { ValidatedRawMemory } from './validate.js';
import { VERSION } from './version.js';
import { noteFromHeader, takeUpdateNotice } from './update_notice.js';

// Verifiable volume fingerprint from the backend's X-Velixar-Volume header (DX #10).
let _lastVolumeId: string | null = null;
export function getLastVolumeId(): string | null { return _lastVolumeId; }

// ── Workspace Resolution ──

function resolveWorkspace(): { id: string; source: ApiConfig['workspaceSource'] } {
  // Priority 1: explicit env var
  const envWs = process.env.VELIXAR_WORKSPACE_ID;
  if (envWs) return { id: envWs, source: 'env' };

  // Priority 2: .velixar.json config
  const cwd = process.cwd();
  const configPath = join(cwd, '.velixar.json');
  if (existsSync(configPath)) {
    try {
      const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
      if (cfg.workspace_id) return { id: cfg.workspace_id, source: 'config' };
    } catch { /* ignore parse errors */ }
  }

  // Priority 3: git root directory name
  try {
    const gitRoot = execSync('git rev-parse --show-toplevel', {
      encoding: 'utf-8',
      timeout: 2000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const dirName = gitRoot.split('/').pop();
    if (dirName) return { id: dirName, source: 'git' };
  } catch { /* not a git repo */ }

  // No workspace — will be display-only; backend enforces via API key
  return { id: '', source: 'none' };
}

// ── Workspace Cross-Validation ──

let clientRoots: string[] = [];

// Who is driving us (set once at MCP initialize). Sent on every request so the
// backend can mark the right connector "connected" from REAL traffic instead of
// waiting for someone to click a tile. Null = unknown; we then send no header at
// all rather than guess.
let clientSlug: string | null = null;
export function setClientSlug(slug: string | null): void { clientSlug = slug; }
export function getClientSlug(): string | null { return clientSlug; }
let lastSeenWorkspaceId: string | null = null; // H4: Track workspace changes mid-session

export function setClientRoots(roots: Array<{ uri: string; name?: string }>): void {
  clientRoots = roots.map(r => {
    // Extract directory name from file:// URI
    try {
      const path = r.uri.replace('file://', '');
      return path.split('/').pop() || path;
    } catch { return r.name || r.uri; }
  }).filter(Boolean);
}

export function validateWorkspace(config: ApiConfig): string | null {
  if (!config.workspaceId || clientRoots.length === 0) return null;

  // H4: Detect workspace change mid-session
  if (lastSeenWorkspaceId && lastSeenWorkspaceId !== config.workspaceId) {
    const warning = `Workspace changed mid-session: "${lastSeenWorkspaceId}" → "${config.workspaceId}". Memories from this point go to the new workspace.`;
    lastSeenWorkspaceId = config.workspaceId;
    return warning;
  }
  lastSeenWorkspaceId = config.workspaceId;

  // If client provided roots and none match our workspace, warn
  const match = clientRoots.some(root =>
    root === config.workspaceId || root.includes(config.workspaceId) || config.workspaceId.includes(root),
  );
  if (!match) {
    return `Workspace mismatch: resolved "${config.workspaceId}" (from ${config.workspaceSource}) but host roots are [${clientRoots.join(', ')}]. Memories may be stored in the wrong workspace.`;
  }
  return null;
}

// ── Config ──

export function loadConfig(): ApiConfig {
  const apiKey = process.env.VELIXAR_API_KEY;
  if (!apiKey) {
    console.error('VELIXAR_API_KEY environment variable required');
    process.exit(1);
  }

  const ws = resolveWorkspace();

  // H5: Stale env var detection — warn if VELIXAR_WORKSPACE_ID doesn't match git root
  if (ws.source === 'env') {
    try {
      const gitRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf-8', timeout: 2000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      const gitDir = gitRoot.split('/').pop();
      if (gitDir && gitDir !== ws.id && !ws.id.includes(gitDir)) {
        log('warn', 'stale_workspace_env', { env_workspace: ws.id, git_root: gitDir, hint: 'VELIXAR_WORKSPACE_ID may be stale — it does not match the current git root' });
      }
    } catch { /* not a git repo — can't validate */ }
  }

  return {
    apiKey,
    apiBase: process.env.VELIXAR_API_URL || 'https://api.velixarai.com',
    // No default. Sending an invented identity ("mcp-user") on every call made
    // the backend fence each MCP install into its own memory universe the moment
    // user filters became airtight. Absent, the backend resolves scope from the
    // key's creator and their workspace role — reads see what the dashboard sees.
    userId: process.env.VELIXAR_USER_ID || undefined,
    workspaceId: ws.id,
    workspaceSource: ws.source,
    timeoutMs: 30_000,
    debug: process.env.VELIXAR_DEBUG === 'true',
  };
}

// ── User Scoping ──
// Every read/write goes through one of these two, so "send user_id only when
// the operator explicitly set one" is decided in exactly one place.

/** Query params with user_id included only when explicitly configured. */
export function userParams(config: ApiConfig, extra: Record<string, string> = {}): URLSearchParams {
  const p = new URLSearchParams(extra);
  if (config.userId) p.set('user_id', config.userId);
  return p;
}

/** Request body with user_id included only when explicitly configured. */
export function withUser(config: ApiConfig, body: Record<string, unknown>): Record<string, unknown> {
  return config.userId ? { user_id: config.userId, ...body } : body;
}

// ── Structured Logging ──

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_JSON = process.env.VELIXAR_LOG_FORMAT === 'json';

export function log(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
  if (LOG_JSON) {
    console.error(JSON.stringify({ ts: new Date().toISOString(), level, msg, service: 'velixar-mcp', ...fields }));
  } else {
    const extra = fields ? ` ${JSON.stringify(fields)}` : '';
    console.error(`[velixar] ${level}: ${msg}${extra}`);
  }
}

// ── Response Cache ──

interface CacheEntry {
  data: unknown;
  timestamp: number;
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60_000; // 1 minute

// H16: Rate limit tracking
let _rateLimitRemaining = -1; // -1 = unknown
let _rateLimitTotal = -1;
export function getRateLimitInfo() { return { remaining: _rateLimitRemaining, total: _rateLimitTotal }; }

function getCached(key: string): CacheEntry | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    cache.delete(key);
    return undefined;
  }
  return entry;
}

function setCache(key: string, data: unknown): void {
  cache.set(key, { data, timestamp: Date.now() });
}

// ── Timing Tracking ──

const timings: ApiTiming[] = [];
const MAX_TIMINGS = 50;

export function getTimings(): ApiTiming[] {
  return timings.slice(-20);
}

function recordTiming(endpoint: string, duration_ms: number, cached: boolean): void {
  timings.push({ endpoint, duration_ms, timestamp: Date.now(), cached });
  if (timings.length > MAX_TIMINGS) timings.splice(0, timings.length - MAX_TIMINGS);
}

// ── Retry Stats ──

let retryCount = 0;
let fallbackCount = 0;

export function getRetryStats() {
  return { retryCount, fallbackCount };
}

// ── Circuit Breaker ──
// M7: Adaptive — exponential backoff for recovery timeout
// M8: Cold-start aware — single timeout followed by success doesn't open circuit

const CIRCUIT_THRESHOLD = 5;    // failures before opening
const CIRCUIT_INITIAL_RESET_MS = 5_000; // M7: start at 5s, increase on repeated failures

let circuitFailures = 0;
let circuitOpenedAt = 0;
let circuitResetMs = CIRCUIT_INITIAL_RESET_MS;
let consecutiveOpens = 0; // M7: track repeated circuit opens

function isCircuitOpen(): boolean {
  if (circuitFailures < CIRCUIT_THRESHOLD) return false;
  if (Date.now() - circuitOpenedAt > circuitResetMs) {
    // Half-open: allow one attempt
    circuitFailures = CIRCUIT_THRESHOLD - 1;
    return false;
  }
  return true;
}

function recordCircuitSuccess(): void {
  // M8: If we had exactly threshold failures and now succeed, likely cold start
  const wasColdStart = circuitFailures === CIRCUIT_THRESHOLD - 1;
  circuitFailures = 0;
  // M7: Decrease reset timeout on success (min 5s)
  if (consecutiveOpens > 0) {
    consecutiveOpens = Math.max(0, consecutiveOpens - 1);
    circuitResetMs = Math.max(CIRCUIT_INITIAL_RESET_MS, CIRCUIT_INITIAL_RESET_MS * Math.pow(2, consecutiveOpens));
  }
}

function recordCircuitFailure(): void {
  circuitFailures++;
  if (circuitFailures >= CIRCUIT_THRESHOLD) {
    circuitOpenedAt = Date.now();
    consecutiveOpens++;
    // M7: Exponential backoff on repeated opens (max 60s)
    circuitResetMs = Math.min(60_000, CIRCUIT_INITIAL_RESET_MS * Math.pow(2, consecutiveOpens - 1));
    log('error', 'circuit_breaker_open', { failures: circuitFailures, reset_ms: circuitResetMs, consecutive_opens: consecutiveOpens });
  }
}

export function getCircuitState() {
  return {
    failures: circuitFailures,
    open: isCircuitOpen(),
    threshold: CIRCUIT_THRESHOLD,
    reset_ms: circuitResetMs,
    consecutive_opens: consecutiveOpens,
  };
}

// ── API Request ──

export class ApiClient {
  constructor(private config: ApiConfig) {}

  async request<T>(
    path: string,
    options: RequestInit & { cacheable?: boolean } = {},
  ): Promise<T> {
    const { cacheable, ...fetchOptions } = options;
    const cacheKey = `${path}:${JSON.stringify(fetchOptions.body || '')}`;
    const method = ((fetchOptions.method as string) || 'GET').toUpperCase();
    const isMutation = method !== 'GET' && method !== 'HEAD';

    // Check cache for GET-like requests
    if (cacheable) {
      const cached = getCached(cacheKey);
      if (cached) {
        recordTiming(path, 0, true);
        return cached.data as T;
      }
    }

    if (!path.startsWith('/v1/')) path = `/v1${path}`;  // live API is /v1-prefixed; server router normalizes identically
    const url = `${this.config.apiBase}${path}`;
    const start = Date.now();
    let lastError: Error | null = null;

    // Circuit breaker check
    if (isCircuitOpen()) {
      // Try cache first when circuit is open
      if (cacheable) {
        const staleEntry = cache.get(cacheKey);
        if (staleEntry) {
          fallbackCount++;
          recordTiming(path, 0, true);
          return staleEntry.data as T;
        }
      }
      throw new Error('Circuit breaker open — backend unreachable');
    }

    // Retry with exponential backoff (max 3 attempts)
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) {
        retryCount++;
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 4000);
        await new Promise(r => setTimeout(r, delay));
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);

      try {
        const res = await fetch(url, {
          ...fetchOptions,
          signal: controller.signal,
          headers: {
            authorization: `Bearer ${this.config.apiKey}`,
            'Content-Type': 'application/json',
            ...(clientSlug ? { 'X-Velixar-Client': clientSlug } : {}),
            // Our own version, so the backend can tell how many callers run stale
            // builds (and drives the A-signal comparison on the response side).
            'X-Velixar-Client-Version': VERSION,
            // The channel is declared, not inferred: this process IS the MCP
            // server, so every request it makes is mcp-channel by definition.
            // (A REST script that wants client attribution sends its own
            // X-Velixar-Client plus X-Velixar-Channel: rest.)
            'X-Velixar-Channel': 'mcp',
            ...(fetchOptions.headers as Record<string, string> || {}),
          },
        });

        if (!res.ok) {
          const body = await res.text().catch(() => '');
          // The backend now emits machine-actionable error metadata in the body
          // (retryable, subsystem, state_effect, retry_after). Honor the SERVER's
          // retryable signal instead of guessing by status — guessing is what made a
          // client hammer a systemic-fault path and trip the circuit breaker. Surface
          // subsystem + state_effect to the agent so it knows which layer broke and
          // whether a failed write left residue.
          let e: Record<string, unknown> | null = null;
          try { e = (JSON.parse(body) as { error?: Record<string, unknown> }).error ?? null; } catch { /* non-JSON */ }
          const detail = (e && typeof e.message === 'string') ? e.message : body.slice(0, 200);
          const tags: string[] = [];
          if (e && e.retryable !== undefined) tags.push(`retryable=${e.retryable}`);
          if (e && e.subsystem) tags.push(`subsystem=${e.subsystem}`);
          if (e && e.state_effect) tags.push(`state_effect=${e.state_effect}`);
          if (e && e.retry_after !== undefined) tags.push(`retry_after=${e.retry_after}s`);
          const err = new Error(`API ${res.status}: ${detail}${tags.length ? ` (${tags.join(', ')})` : ''}`);
          // Prefer the server's explicit retryable; fall back to the status heuristic.
          const retry = (e && typeof e.retryable === 'boolean') ? e.retryable : !(res.status >= 400 && res.status < 500);
          if (!retry) throw err;
          lastError = err;
          continue;
        }

        const data = await res.json() as T;
        const duration = Date.now() - start;
        recordTiming(path, duration, false);

        // H16: Track rate limit headers for budget awareness
        const remaining = res.headers.get('x-ratelimit-remaining');
        const limit = res.headers.get('x-ratelimit-limit');
        if (remaining !== null) {
          _rateLimitRemaining = parseInt(remaining, 10);
          _rateLimitTotal = limit ? parseInt(limit, 10) : _rateLimitTotal;
        }

        // Update nudge, signal A: the backend advertises the latest published
        // version on every response (server-controlled via its env). The notice
        // module compares it to our VERSION and, if we're behind, surfaces a
        // one-time nudge on the next tool response's meta.
        noteFromHeader(res.headers.get('x-velixar-mcp-latest'));

        // Verifiable volume (DX #10): the backend stamps a stable, non-reversible
        // fingerprint of the workspace it scoped this call to. Surface it so the agent
        // can confirm which volume it read/wrote — cross-volume contamination is the
        // platform's top risk, and "(scoped by API key)" was a non-answer.
        const vol = res.headers.get('x-velixar-volume');
        if (vol) _lastVolumeId = vol;

        if (this.config.debug) {
          log('debug', 'api_call', { path, duration_ms: duration });
        }
        // M10/M29: Always log timing at info level for diagnostics
        log('info', 'api_timing', { path, duration_ms: duration, cached: false });

        // Cache successful reads
        if (cacheable) setCache(cacheKey, data);
        // A successful mutation makes every cached read suspect (an inspect
        // after update/delete was serving the pre-mutation row for up to the
        // full TTL) — drop them all so the next read refetches.
        if (isMutation) cache.clear();

        recordCircuitSuccess();
        return data;
      } catch (e) {
        const err = e as Error;
        if (err.name === 'AbortError') {
          lastError = new Error(`API timeout after ${this.config.timeoutMs}ms`);
        } else if (err.message.startsWith('API 4')) {
          throw err; // Don't retry client errors
        } else {
          lastError = err;
        }
      } finally {
        clearTimeout(timer);
      }
    }

    // All retries exhausted — record circuit failure
    recordCircuitFailure();

    // A timed-out mutation may still have landed server-side — the outcome is
    // unknown, so cached reads can't be trusted to outlive it.
    if (isMutation) cache.clear();

    // Try cache fallback
    if (cacheable) {
      // Check even expired cache entries
      const staleEntry = cache.get(cacheKey);
      if (staleEntry) {
        fallbackCount++;
        recordTiming(path, 0, true);
        if (this.config.debug) {
          log('warn', 'cache_fallback', { path });
        }
        return staleEntry.data as T;
      }
    }

    throw lastError || new Error('API request failed');
  }

  // ── Convenience Methods ──

  async get<T>(path: string, cacheable = false): Promise<T> {
    return this.request<T>(path, { method: 'GET', cacheable });
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  async patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
  }

  async delete<T>(path: string): Promise<T> {
    return this.request<T>(path, { method: 'DELETE' });
  }

  // ── Validated Variants ──
  // Force a runtime validator on every response. Prefer these in new code.
  // The raw cast in `request<T>` is the silent-data-loss class — avoid it.

  async requestValidated<T>(
    path: string,
    options: RequestInit & { cacheable?: boolean },
    validate: (raw: unknown, endpoint: string) => T,
  ): Promise<T> {
    const raw = await this.request<unknown>(path, options);
    return validate(raw, path);
  }

  async getValidated<T>(
    path: string,
    validate: (raw: unknown, endpoint: string) => T,
    cacheable = false,
  ): Promise<T> {
    return this.requestValidated(path, { method: 'GET', cacheable }, validate);
  }

  async postValidated<T>(
    path: string,
    body: unknown,
    validate: (raw: unknown, endpoint: string) => T,
  ): Promise<T> {
    return this.requestValidated(path, { method: 'POST', body: JSON.stringify(body) }, validate);
  }

  async patchValidated<T>(
    path: string,
    body: unknown,
    validate: (raw: unknown, endpoint: string) => T,
  ): Promise<T> {
    return this.requestValidated(path, { method: 'PATCH', body: JSON.stringify(body) }, validate);
  }
}

// ── Response Normalization ──
// Backend returns raw shapes; normalize to VelixarResponse<T> with MemoryItem.

/** Raw memory shape from backend — use ValidatedRawMemory from validate.ts for new code */
interface RawMemory {
  id: string;
  content: string;
  score?: number;
  tier?: number;
  type?: string | null;
  tags?: string[];
  salience?: number;
  created_at?: string;
  updated_at?: string;
  previous_memory_id?: string | null;
  timestamp?: string;
  origin?: MemoryOrigin;
}

function inferMemoryType(raw: RawMemory | ValidatedRawMemory): MemoryType {
  // Tier 0 (pinned) and tier 2 (semantic) → semantic; tier 1 (session) → episodic
  return raw.tier === 1 ? 'episodic' : 'semantic';
}

function inferSourceType(raw: RawMemory | ValidatedRawMemory): SourceType {
  if (raw.type === 'distill') return 'distill';
  if (raw.type === 'inferred') return 'inferred';
  return 'user';
}

export function normalizeMemory(raw: RawMemory | ValidatedRawMemory): MemoryItem {
  return {
    id: raw.id,
    workspace_id: '', // filled by caller
    content: raw.content,
    tags: raw.tags || [],
    memory_type: inferMemoryType(raw),
    source_type: inferSourceType(raw),
    author: { type: 'user' },
    relevance: raw.score,
    confidence: raw.salience,
    provenance: {
      created_at: raw.created_at || '',
      updated_at: raw.updated_at || raw.created_at || '',
      last_touched: raw.created_at || '',
      derived_from: raw.previous_memory_id ? [raw.previous_memory_id] : undefined,
    },
    origin: raw.origin,
  };
}

export function makeMeta(config: ApiConfig, overrides: Partial<ResponseMeta> = {}): ResponseMeta {
  const meta: ResponseMeta = {
    // "" read as "workspace isolation is not active". The backend always
    // scopes by the API key; when the client has no local resolution, SAY so.
    workspace_id: config.workspaceId || '(scoped by API key)',
    confidence: 1,
    staleness: 'fresh',
    contradictions_present: false,
    data_absent: false,
    partial_context: false,
    request_ms: 0,
    ...overrides,
    // H8: If data_absent, require absence_reason
    ...(overrides.data_absent && !overrides.absence_reason ? { absence_reason: 'no_data' as const } : {}),
  };
  // H30: Early-exit signal — sufficient when data present, confident, no contradictions
  if (meta.sufficient_answer === undefined) {
    meta.sufficient_answer = !meta.data_absent && !meta.partial_context && !meta.contradictions_present && meta.confidence >= 0.7;
  }
  // Update nudge: if either signal (A: response header, B: npm self-check) marked us
  // behind, surface it ONCE here, on the first tool response after it was learned.
  const _upd = takeUpdateNotice();
  if (_upd) meta.update_available = _upd;
  // Verifiable volume fingerprint (DX #10) — which volume the backend scoped us to.
  if (_lastVolumeId) meta.volume_id = _lastVolumeId;
  return meta;
}

export function wrapResponse<T>(data: T, config: ApiConfig, overrides: Partial<ResponseMeta> = {}): VelixarResponse<T> {
  return { status: overrides.partial_context ? 'partial' : 'ok', data, meta: makeMeta(config, overrides) };
}

// ── Error Helpers ──

export function makeError(code: string, message: string, retryable = false): VelixarError {
  return { status: 'error', error: { code, message, retryable } };
}

export function isApiError(e: unknown): e is Error {
  return e instanceof Error;
}
