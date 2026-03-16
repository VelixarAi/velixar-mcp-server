// ── Velixar MCP Server — API Client ──
// Typed HTTP client with workspace header injection, retry, timeout, caching.

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ApiConfig, ApiTiming, MemoryItem, MemoryType, ResponseMeta, SourceType, VelixarError, VelixarResponse } from './types.js';
import type { ValidatedRawMemory } from './validate.js';

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
    userId: process.env.VELIXAR_USER_ID || 'mcp-user',
    workspaceId: ws.id,
    workspaceSource: ws.source,
    timeoutMs: 30_000,
    debug: process.env.VELIXAR_DEBUG === 'true',
  };
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

const CIRCUIT_THRESHOLD = 5;    // failures before opening
const CIRCUIT_RESET_MS = 30_000; // 30s before half-open

let circuitFailures = 0;
let circuitOpenedAt = 0;

function isCircuitOpen(): boolean {
  if (circuitFailures < CIRCUIT_THRESHOLD) return false;
  if (Date.now() - circuitOpenedAt > CIRCUIT_RESET_MS) {
    // Half-open: allow one attempt
    circuitFailures = CIRCUIT_THRESHOLD - 1;
    return false;
  }
  return true;
}

function recordCircuitSuccess(): void {
  circuitFailures = 0;
}

function recordCircuitFailure(): void {
  circuitFailures++;
  if (circuitFailures >= CIRCUIT_THRESHOLD) {
    circuitOpenedAt = Date.now();
    log('error', 'circuit_breaker_open', { failures: circuitFailures });
  }
}

export function getCircuitState() {
  return {
    failures: circuitFailures,
    open: isCircuitOpen(),
    threshold: CIRCUIT_THRESHOLD,
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

    // Check cache for GET-like requests
    if (cacheable) {
      const cached = getCached(cacheKey);
      if (cached) {
        recordTiming(path, 0, true);
        return cached.data as T;
      }
    }

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
            ...(fetchOptions.headers as Record<string, string> || {}),
          },
        });

        if (!res.ok) {
          const body = await res.text().catch(() => '');
          const err = new Error(`API ${res.status}: ${body.slice(0, 200)}`);
          // Don't retry 4xx (client errors)
          if (res.status >= 400 && res.status < 500) throw err;
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

        if (this.config.debug) {
          log('debug', 'api_call', { path, duration_ms: duration });
        }

        // Cache successful reads
        if (cacheable) setCache(cacheKey, data);

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
  };
}

export function makeMeta(config: ApiConfig, overrides: Partial<ResponseMeta> = {}): ResponseMeta {
  const meta: ResponseMeta = {
    workspace_id: config.workspaceId,
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
