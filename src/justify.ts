// ── Justification Pipeline ──
// Implements the epistemic justification layer from MCP-SERVER-STRATEGY.md.
// Every inferred response must carry a JustificationResult so no derived
// claim is ever presented as a retrieved fact.

import type {
  JustificationResult,
  ConfidenceProfile,
  EvidenceItem,
  EvidenceClass,
  ClaimType,
  ConfidenceLevel,
  PresentationMode,
  MemoryItem,
} from './types.js';

// ── Evidence Builder ──

export function buildEvidence(memories: MemoryItem[], workspaceId: string): EvidenceItem[] {
  return memories.map(m => ({
    id: m.id,
    source_type: m.source_type || 'user',
    evidence_class: classifyEvidence(m),
    relevance: m.relevance ?? 0.5,
    freshness: ageFreshness(m.provenance?.created_at),
    workspace_id: workspaceId,
  }));
}

function classifyEvidence(m: MemoryItem): EvidenceClass {
  if (m.contradiction_flags?.length) return 'contradictory';
  if (m.source_type === 'distill' || m.memory_type === 'semantic') return 'aggregated';
  if (m.relevance !== undefined && m.relevance < 0.3) return 'weak';
  return 'direct';
}

function ageFreshness(ts?: string): 'recent' | 'aging' | 'stale' {
  if (!ts) return 'stale';
  const age = Date.now() - new Date(ts).getTime();
  if (age < 24 * 60 * 60 * 1000) return 'recent';      // <24h
  if (age < 7 * 24 * 60 * 60 * 1000) return 'aging';    // <7d
  return 'stale';
}

// ── Confidence Computation ──

export function computeConfidence(evidence: EvidenceItem[], contradictionCount: number): ConfidenceProfile {
  if (evidence.length === 0) {
    return {
      level: 'low', score: 0.1, evidence_strength: 0, evidence_consistency: 0,
      evidence_freshness: 0, derivation_distance: 3, contradiction_pressure: 0,
      reason: 'No supporting evidence found',
    };
  }

  const strength = Math.min(evidence.length / 5, 1);
  const contradictory = evidence.filter(e => e.evidence_class === 'contradictory').length;
  const consistency = evidence.length > 0 ? 1 - (contradictory / evidence.length) : 0;
  const freshCounts = { recent: 0, aging: 0, stale: 0 };
  evidence.forEach(e => freshCounts[e.freshness]++);
  const freshness = (freshCounts.recent * 1 + freshCounts.aging * 0.5) / evidence.length;
  const contradictionPressure = contradictionCount > 0 ? Math.min(contradictionCount / 3, 1) : 0;
  const derivation = evidence.some(e => e.evidence_class === 'direct') ? 1 : 2;

  const rawScore = (strength * 0.3 + consistency * 0.25 + freshness * 0.2 + (1 - contradictionPressure) * 0.15 + (1 / derivation) * 0.1);

  // STALENESS FLOORS CONFIDENCE — it is not just another weighted term.
  //
  // Verified in prod 2026-07-31: 10 evidence items, EVERY ONE tagged freshness "stale", so
  // evidence_freshness resolved to 0 — and the verdict was still level "high", score 0.75.
  // The arithmetic explains it exactly: freshness at its WORST POSSIBLE VALUE costs only
  // its 0.2 weight, and strength(0.3) + consistency(0.25) + contradiction(0.1) +
  // derivation(0.1) carry the total to precisely the 0.75 "high" threshold. A scored
  // dimension pinned at rock bottom contributed nothing to the outcome; it was averaged
  // away by the dimensions that happened to look good.
  //
  // A weighted sum lets any single dimension be outvoted. Some dimensions must not be
  // outvotable. If everything you know is old, you do not get to be confident about it —
  // no quantity of stale evidence, however internally consistent, makes a claim current.
  // So freshness sets a CEILING on the score rather than contributing a share of it.
  const ceiling = freshnessCeiling(freshness);
  const score = Math.min(rawScore, ceiling);
  const capped = score < rawScore;
  const level = resolveLevel(score, contradictionPressure);

  return {
    level, score, evidence_strength: strength, evidence_consistency: consistency,
    evidence_freshness: freshness, derivation_distance: derivation,
    contradiction_pressure: contradictionPressure,
    // If a cap fired, SAY SO. Silently lowering a number replaces one unexplained verdict
    // with another; a reader must be able to see that age is what limited this.
    ...(capped ? { freshness_capped: true, raw_score: Number(rawScore.toFixed(4)) } : {}),
    reason: buildReason(level, evidence.length, contradictionCount, capped),
  };
}

/** The highest score a given freshness may reach. Deliberately a ladder, not a curve —
 *  the thresholds are the ones resolveLevel() already uses, so the cap is legible as
 *  "this may be at most `medium`" rather than as an opaque number. */
function freshnessCeiling(freshness: number): number {
  if (freshness === 0) return 0.49;    // NOTHING recent or even aging -> `low` at best
  if (freshness < 0.5) return 0.74;    // mostly stale                 -> `medium` at best
  return 1;                            // enough current evidence      -> uncapped
}

function resolveLevel(score: number, contradictionPressure: number): ConfidenceLevel {
  if (contradictionPressure > 0.5) return 'conflicting';
  if (score >= 0.75) return 'high';
  if (score >= 0.5) return 'medium';
  if (score >= 0.25) return 'low';
  return 'unstable';
}

function buildReason(level: ConfidenceLevel, count: number, contradictions: number, staleCapped = false): string {
  const parts = [`Based on ${count} piece${count !== 1 ? 's' : ''} of evidence`];
  if (contradictions > 0) {
    parts.push(`with ${contradictions} contradiction${contradictions !== 1 ? 's' : ''}`);
  }
  // The cap has to survive into the prose too. A reader who sees only `level: low` and a
  // pile of consistent evidence will reasonably conclude the scorer is broken — unless the
  // reason says age is what limited it. Note this appends rather than early-returning:
  // contradictions used to short-circuit the sentence, which would have hidden the cap
  // in exactly the payload that carried both problems at once.
  if (staleCapped) {
    parts.push('capped by staleness (all supporting evidence is old, so confidence cannot be high regardless of how much of it agrees)');
  }
  if (contradictions === 0 && !staleCapped) parts.push(`confidence ${level}`);
  else parts.push(`confidence ${level}`);
  return parts.join('; ');
}

// ── Presentation Policy ──

export function resolvePresentation(claimType: ClaimType, confidence: ConfidenceProfile): PresentationMode {
  if (confidence.level === 'unstable' || confidence.score < 0.15) return 'do_not_assert';
  if (claimType === 'hypothesis') return 'exploratory';
  if (claimType === 'retrieved_fact' && confidence.level === 'high') {
    return confidence.contradiction_pressure > 0 ? 'confident_summary' : 'assertive';
  }
  if (claimType === 'synthesized_summary' && confidence.level === 'high') return 'confident_summary';
  if (confidence.contradiction_pressure > 0.3) return 'cautious';
  if (confidence.level === 'medium') return 'tentative_synthesis';
  return 'cautious';
}

// ── Full Justification Builder ──

export function justify(
  claim: string,
  claimType: ClaimType,
  memories: MemoryItem[],
  workspaceId: string,
  opts?: { contradictionCount?: number; scope?: JustificationResult['workspace_scope'] },
): JustificationResult {
  const evidence = buildEvidence(memories, workspaceId);
  const contradictionCount = opts?.contradictionCount ?? 0;
  const confidence = computeConfidence(evidence, contradictionCount);
  const types = [...new Set(evidence.map(e => e.evidence_class))];

  return {
    claim,
    claim_type: claimType,
    workspace_scope: opts?.scope ?? 'workspace_local',
    support: { evidence_count: evidence.length, evidence_types: types, items: evidence },
    confidence,
    uncertainty_flags: confidence.level === 'low' || confidence.level === 'unstable'
      ? ['insufficient_evidence'] : [],
    contradiction_flags: contradictionCount > 0 ? ['contradictions_detected'] : [],
    derived_from: memories.map(m => m.id),
    presentation_mode: resolvePresentation(claimType, confidence),
  };
}
