// ── Structured Error Responses ──
// H7.3: Single toolError() function for all handlers.
// H7.5: isError: true for app errors, McpError for protocol errors only.
// H7.6: Error code registry with description, retryable, suggestion, severity.
// Phase A: New tools only. Phase B: migrate existing with feature flag.

export interface StructuredError {
  error_code: string;
  message: string;
  suggestion?: string;
  retryable: boolean;
  retry_after_seconds?: number;
  severity: 'low' | 'medium' | 'high' | 'critical';
}

// H7.6: Error code registry
const ERROR_REGISTRY: Record<string, Omit<StructuredError, 'message'>> = {
  MEMORY_NOT_FOUND: { error_code: 'MEMORY_NOT_FOUND', retryable: false, suggestion: 'Use velixar_list to find valid IDs', severity: 'low' },
  DUPLICATE_DETECTED: { error_code: 'DUPLICATE_DETECTED', retryable: false, suggestion: 'Use velixar_update to modify the existing memory', severity: 'low' },
  COVERAGE_LOW: { error_code: 'COVERAGE_LOW', retryable: true, suggestion: 'Run additional searches to improve coverage', severity: 'medium' },
  CONTEXT_EXPIRED: { error_code: 'CONTEXT_EXPIRED', retryable: true, suggestion: 'Call velixar_prepare_context again', severity: 'low', retry_after_seconds: 0 },
  RATE_LIMITED: { error_code: 'RATE_LIMITED', retryable: true, suggestion: 'Wait and retry', severity: 'medium', retry_after_seconds: 5 },
  BACKEND_UNAVAILABLE: { error_code: 'BACKEND_UNAVAILABLE', retryable: true, suggestion: 'Inform the user and try again later', severity: 'high', retry_after_seconds: 30 },
  INVALID_PARAMS: { error_code: 'INVALID_PARAMS', retryable: false, suggestion: 'Check parameter types and values', severity: 'low' },
  ENTITY_NOT_FOUND: { error_code: 'ENTITY_NOT_FOUND', retryable: false, suggestion: 'Use velixar_graph_search to find entities by name', severity: 'low' },
  WORKSPACE_MISMATCH: { error_code: 'WORKSPACE_MISMATCH', retryable: false, suggestion: 'Verify workspace configuration', severity: 'high' },
  QUARANTINE_VIOLATION: { error_code: 'QUARANTINE_VIOLATION', retryable: false, suggestion: 'Memory is in a quarantine zone — check zone permissions', severity: 'high' },
  ARCHIVE_FAILED: { error_code: 'ARCHIVE_FAILED', retryable: true, suggestion: 'Retry the archive operation', severity: 'medium', retry_after_seconds: 5 },
};

const STRUCTURED_ERRORS_ENABLED = process.env.VELIXAR_STRUCTURED_ERRORS === 'true';

/**
 * H7.3: Single error function for all tool handlers.
 * Handles feature flag internally — no branching in handlers.
 * content[0].text is always valid JSON when isError: true.
 */
export function toolError(code: string, message: string, overrides?: Partial<StructuredError>): { text: string; isError: true } {
  const registry = ERROR_REGISTRY[code];
  const error: StructuredError = {
    error_code: code,
    message,
    retryable: registry?.retryable ?? false,
    severity: registry?.severity ?? 'medium',
    suggestion: overrides?.suggestion ?? registry?.suggestion,
    retry_after_seconds: overrides?.retry_after_seconds ?? registry?.retry_after_seconds,
    ...overrides,
  };

  if (STRUCTURED_ERRORS_ENABLED) {
    return { text: JSON.stringify(error), isError: true };
  }

  // Phase A fallback: return both old and new keys for backward compat
  return {
    text: JSON.stringify({
      error: message,
      ...error,
    }),
    isError: true,
  };
}

export function getErrorRegistry(): Record<string, Omit<StructuredError, 'message'>> {
  return { ...ERROR_REGISTRY };
}
