// ── Simulation Runner v2 ──
// Upgraded: event injection mid-simulation, per-persona activity levels,
// richer round tracking, convergence detection with trend analysis.

import type { Persona } from './personas.js';
import { generateDevilsAdvocates } from './personas.js';

export interface SimulationEvent {
  round: number;        // inject at this round
  description: string;  // "Competitor launches free migration tool"
  impact: string;       // "high" | "medium" | "low"
}

export interface RoundAction {
  personaId: string;
  personaName: string;
  personaType: string;
  action: string;
  active: boolean;
  grounded: boolean; // did the action reference known data?
}

export interface RoundResult {
  round: number;
  actions: RoundAction[];
  summary: string;
  stateBullets: string[];
  consensus: string | null;
  eventInjected: string | null;
  activeCount: number;
  totalCount: number;
}

export interface SimulationResult {
  simulationId: string;
  question: string;
  variables: Record<string, string>;
  events: SimulationEvent[];
  rounds: RoundResult[];
  finalState: string[];
  emergentConsensus: string;
  convergenceRound: number | null;
  trendHistory: string[]; // consensus per round for trend analysis
  personas: Array<{ id: string; name: string; type: string; role: string; memoryCount: number }>;
  tokensUsed: number;
  roundsCompleted: number;
  roundsPlanned: number;
  aborted: boolean;
  durationMs: number;
}

type LLMCall = (system: string, user: string) => Promise<string>;

export async function runSimulation(opts: {
  simulationId: string;
  question: string;
  variables: Record<string, string>;
  events?: SimulationEvent[];
  personas: Persona[];
  roundCount: number;
  llmCall: LLMCall;
  seed?: number;
  concurrency?: number;
  timeoutMs?: number;
  onRound?: (round: number, total: number) => void;
}): Promise<SimulationResult> {
  const {
    simulationId, question, variables, roundCount,
    llmCall, seed, concurrency = 10, timeoutMs = 60000,
  } = opts;
  const events = (opts.events || []).sort((a, b) => a.round - b.round);
  let personas = [...opts.personas];

  const startTime = Date.now();
  const rounds: RoundResult[] = [];
  const stateBullets: string[] = [];
  const trendHistory: string[] = [];
  const maxBullets = roundCount * 3;
  let tokensUsed = 0;
  let convergenceRound: number | null = null;
  let lastConsensus = '';
  let consensusStreak = 0;
  let aborted = false;

  const rng = seed !== undefined ? seededRandom(seed) : Math.random;

  for (let round = 1; round <= roundCount; round++) {
    if (Date.now() - startTime > timeoutMs) { aborted = true; break; }
    opts.onRound?.(round, roundCount);

    // Event injection — check if any events fire this round
    let eventInjected: string | null = null;
    const roundEvents = events.filter(e => e.round === round);
    if (roundEvents.length > 0) {
      eventInjected = roundEvents.map(e => `⚡ EVENT: ${e.description} (impact: ${e.impact})`).join('\n');
      stateBullets.push(...roundEvents.map(e => `[EVENT R${round}] ${e.description}`));
    }

    // Devil's advocates at 25% mark
    if (round === Math.ceil(roundCount * 0.25) && rounds.length >= 3) {
      const consensus = extractRecentConsensus(rounds);
      if (consensus) {
        const devils = generateDevilsAdvocates(consensus, simulationId);
        personas = [...personas, ...devils];
      }
    }

    // Build round context
    const recentRounds = rounds.slice(-3).map(r =>
      `Round ${r.round}${r.eventInjected ? ' [EVENT]' : ''}: ${r.summary}`
    ).join('\n');

    const variableStr = Object.entries(variables).map(([k, v]) => `${k}: ${v}`).join(', ');
    const roundContext = [
      `SCENARIO VARIABLES: ${variableStr}`,
      `Round ${round} of ${roundCount}.`,
      eventInjected ? `\n${eventInjected}\nHow does this change your behavior?` : '',
      stateBullets.length > 0 ? `\nKEY DEVELOPMENTS:\n${stateBullets.slice(-12).map(b => `• ${b}`).join('\n')}` : '',
      recentRounds ? `\nRECENT:\n${recentRounds}` : '',
      '\nWhat do you do? Be specific — state your action and reasoning. 2-4 sentences.',
    ].filter(Boolean).join('\n');

    // Determine active personas (per-persona activity level + randomness)
    const activePersonas = personas.filter(p => {
      const prob = p.activityLevel ?? 0.7;
      // Events boost activity — everyone pays attention
      const boost = eventInjected ? 0.3 : 0;
      return rng() < Math.min(1.0, prob + boost);
    });
    if (activePersonas.length === 0) activePersonas.push(personas[0]);

    // Run in parallel batches
    const actions: RoundAction[] = [];
    for (let i = 0; i < activePersonas.length; i += concurrency) {
      const batch = activePersonas.slice(i, i + concurrency);
      const results = await Promise.allSettled(
        batch.map(async p => {
          const response = await llmCall(p.systemPrompt, roundContext);
          const inputTokens = estimateTokens(p.systemPrompt) + estimateTokens(roundContext);
          const outputTokens = estimateTokens(response);
          tokensUsed += inputTokens + outputTokens;
          // Check if response references known data (simple heuristic)
          const grounded = p.knowledge.some(k => {
            const words = k.split(' ').filter(w => w.length > 5).slice(0, 3);
            return words.some(w => response.toLowerCase().includes(w.toLowerCase()));
          });
          return { personaId: p.id, personaName: p.name, personaType: p.type, action: response, active: true, grounded };
        }),
      );
      for (const r of results) {
        if (r.status === 'fulfilled') actions.push(r.value);
      }
    }

    // Inactive personas
    for (const p of personas) {
      if (!actions.some(a => a.personaId === p.id)) {
        actions.push({ personaId: p.id, personaName: p.name, personaType: p.type, action: '', active: false, grounded: false });
      }
    }

    // Extract state bullets
    const newBullets = extractBullets(actions.filter(a => a.active));
    stateBullets.push(...newBullets);
    while (stateBullets.length > maxBullets) stateBullets.shift();

    // Summary
    const active = actions.filter(a => a.active);
    const summary = active.length <= 3
      ? active.map(a => `${a.personaName}: ${a.action.slice(0, 100)}`).join('. ')
      : `${active.length} acted. ${active.slice(0, 2).map(a => `${a.personaName}: ${a.action.slice(0, 80)}`).join('; ')}`;

    // Consensus
    const roundConsensus = detectConsensus(active.map(a => a.action));
    trendHistory.push(roundConsensus || 'mixed');
    if (roundConsensus && roundConsensus === lastConsensus) {
      consensusStreak++;
      if (consensusStreak >= 3 && round >= roundCount * 0.5) convergenceRound = round;
    } else {
      consensusStreak = Math.max(0, consensusStreak - 1); // decay, don't reset
    }
    lastConsensus = roundConsensus || lastConsensus;

    rounds.push({ round, actions, summary, stateBullets: [...stateBullets], consensus: roundConsensus, eventInjected, activeCount: active.length, totalCount: personas.length });

    // Early stop: converged AND no more events pending
    if (convergenceRound && round >= convergenceRound + 2 && !events.some(e => e.round > round)) break;
  }

  return {
    simulationId, question, variables, events, rounds, finalState: stateBullets,
    emergentConsensus: lastConsensus || 'No clear consensus emerged.',
    convergenceRound, trendHistory,
    personas: personas.map(p => ({ id: p.id, name: p.name, type: p.type, role: p.role, memoryCount: p.memoryCount })),
    tokensUsed, roundsCompleted: rounds.length, roundsPlanned: roundCount,
    aborted, durationMs: Date.now() - startTime,
  };
}

// ── Helpers ──

function estimateTokens(text: string): number { return Math.ceil(text.length / 3); }

function extractBullets(actions: RoundAction[]): string[] {
  const bullets: string[] = [];
  for (const a of actions) {
    const sentences = a.action.split(/[.!]\s+/).filter(s => s.length > 20 && s.length < 200);
    for (const s of sentences) {
      if (/\b(would|will|decide|switch|leave|stay|increase|decrease|launch|cancel|respond|react|announce|invest|cut|raise|delay)\b/i.test(s)) {
        const prefix = a.grounded ? '' : '[est] ';
        bullets.push(`${prefix}${a.personaName}: ${s.trim().replace(/\n/g, ' ')}`);
        if (bullets.length >= 3) return bullets;
      }
    }
  }
  if (bullets.length === 0 && actions.length > 0) {
    const first = actions[0];
    const s = first.action.split(/[.!]\s+/)[0] || first.action.slice(0, 150);
    bullets.push(`${first.personaName}: ${s.trim()}`);
  }
  return bullets.slice(0, 3);
}

function detectConsensus(actions: string[]): string | null {
  if (actions.length < 3) return null;
  const keywords = new Map<string, number>();
  for (const a of actions) {
    const words = a.toLowerCase().match(/\b(leave|stay|switch|increase|decrease|positive|negative|risk|opportunity|churn|retain|grow|decline|wait|accelerate|cancel|delay|invest|cut)\b/g) || [];
    for (const w of words) keywords.set(w, (keywords.get(w) || 0) + 1);
  }
  const threshold = actions.length * 0.5;
  const dominant = [...keywords.entries()].filter(([, c]) => c >= threshold).sort((a, b) => b[1] - a[1]);
  return dominant.length > 0 ? `Majority trend: ${dominant.map(([w]) => w).join(', ')}` : null;
}

function extractRecentConsensus(rounds: RoundResult[]): string {
  const recent = rounds.slice(-3).map(r => r.consensus).filter(Boolean);
  return recent[recent.length - 1] || 'mixed signals';
}

function seededRandom(seed: number): () => number {
  let s = seed;
  return () => { s = (s * 1664525 + 1013904223) & 0xffffffff; return (s >>> 0) / 0xffffffff; };
}
