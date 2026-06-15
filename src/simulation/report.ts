// ── Prediction Report Generator ──
// Build 1.3: Structured report from simulation results.
// H1.3: Confidence = consensus * min(1.0, coverage / 0.7)
// H1.5: Data Foundation section. H1.6: Model limitation disclaimer.
// H7.1: Ranges not points. H7.2: "What could go wrong" prominent.
// Chain 8: Post-hoc fact-check (async annotation).
// Chain 9: Badge system 🔬 vs 📊.

import type { SimulationResult } from './runner.js';
import type { Persona } from './personas.js';

export interface PredictionReport {
  badge: '🔬 THOUGHT EXPERIMENT' | '📊 DATA-INFORMED';
  prediction: string;
  confidenceRange: { low: number; high: number; label: string };
  keyFactors: string[];
  risks: string[];
  assumptions: string[];
  timeline: string;
  dissentingViews: string[];
  dataFoundation: {
    totalMemoriesUsed: number;
    groundedPersonas: number;
    archetypePersonas: number;
    devilsAdvocates: number;
    dataSufficiency: number;
    classification: string;
  };
  disclaimer: string;
  trackPrompt: string;
}

export function generateReport(
  sim: SimulationResult,
  personas: Persona[],
  coverageRatio: number,
  seedMemoryCount: number,
  minDataThreshold: number,
): PredictionReport {
  // Chain 9: Badge system
  const dataInformed = coverageRatio >= 0.4 && seedMemoryCount >= minDataThreshold;
  const badge = dataInformed ? '📊 DATA-INFORMED' : '🔬 THOUGHT EXPERIMENT';

  // H1.3: Confidence includes data sufficiency
  const consensusStrength = sim.convergenceRound
    ? Math.min(1.0, 0.5 + (sim.rounds.length - sim.convergenceRound) * 0.1)
    : 0.4;
  const dataSufficiency = Math.min(1.0, coverageRatio / 0.7);
  const rawConfidence = consensusStrength * dataSufficiency;

  // H7.1: Ranges not points
  const confidenceRange = {
    low: Math.max(0, Math.round((rawConfidence - 0.15) * 100) / 100),
    high: Math.min(1, Math.round((rawConfidence + 0.15) * 100) / 100),
    label: rawConfidence >= 0.7 ? 'moderate-high' : rawConfidence >= 0.4 ? 'moderate' : 'low',
  };

  // Extract key factors from state bullets
  const keyFactors = sim.finalState
    .filter(b => /\b(because|due to|driven by|caused by|result of|key factor)\b/i.test(b))
    .slice(0, 5);
  if (keyFactors.length === 0) {
    // Fallback: use last 3 state bullets
    keyFactors.push(...sim.finalState.slice(-3));
  }

  // H7.2: Risks from devil's advocate actions (prominent, not buried)
  const devilActions = sim.rounds
    .flatMap(r => r.actions.filter(a => a.personaType === 'devils_advocate' && a.active))
    .map(a => a.action)
    .filter(Boolean);
  const risks = devilActions.length > 0
    ? devilActions.slice(0, 3)
    : ['No devil\'s advocate perspectives were generated — risks may be underexplored.'];

  // H7.3: Assumptions
  const assumptions = extractAssumptions(sim);

  // Dissenting views
  const dissentingViews = sim.rounds
    .flatMap(r => r.actions.filter(a => a.active && a.personaType !== 'devils_advocate'))
    .filter(a => {
      const consensus = sim.emergentConsensus.toLowerCase();
      const action = a.action.toLowerCase();
      return consensus.includes('leave') ? action.includes('stay') :
             consensus.includes('stay') ? action.includes('leave') :
             false;
    })
    .map(a => `${a.personaName}: ${a.action.slice(0, 150)}`)
    .slice(0, 3);

  // Data foundation
  const groundedCount = personas.filter(p => p.type === 'data_grounded').length;
  const archetypeCount = personas.filter(p => p.type === 'archetype').length;
  const devilCount = personas.filter(p => p.type === 'devils_advocate').length;

  const dataFoundation = {
    totalMemoriesUsed: seedMemoryCount,
    groundedPersonas: groundedCount,
    archetypePersonas: archetypeCount,
    devilsAdvocates: devilCount,
    dataSufficiency: Math.round(dataSufficiency * 100) / 100,
    classification: dataInformed
      ? `Data-informed: ${seedMemoryCount} relevant memories found, ${groundedCount} personas grounded in real data.`
      : `Thought experiment: only ${seedMemoryCount} relevant memories found (threshold: ${minDataThreshold}). Simulation relies primarily on general patterns.`,
  };

  // Timeline estimate
  const timeline = sim.convergenceRound
    ? `Outcomes likely to materialize within ${Math.ceil(sim.convergenceRound / 5)} decision cycles of the triggering event.`
    : 'Timeline uncertain — simulation did not converge on a clear trajectory.';

  // Prediction text — H7.1: ranges, not points
  const prediction = [
    `[PREDICTION — simulated, not factual]`,
    `Based on a ${sim.rounds.length}-round simulation with ${personas.length} personas (${groundedCount} data-grounded, ${archetypeCount} archetype, ${devilCount} devil's advocate):`,
    '',
    sim.emergentConsensus,
    '',
    `Confidence range: ${confidenceRange.low}-${confidenceRange.high} (${confidenceRange.label}).`,
    sim.aborted ? '⚠️ Simulation was time-limited — results based on partial run.' : '',
  ].filter(Boolean).join('\n');

  // H1.6: Disclaimer
  const disclaimer = 'This is a simulation-based estimate, not a forecast. It reflects patterns in your data as of today. Use as one input to decision-making alongside human judgment, market research, and domain expertise. The simulation is bounded by the AI model\'s training data and may not capture truly novel scenarios.';

  // H1.7: Track prompt
  const trackPrompt = `To track this prediction, note the simulation ID and check back when outcomes are known. Velixar will automatically flag when new data relates to this prediction.`;

  return {
    badge, prediction, confidenceRange, keyFactors, risks, assumptions,
    timeline, dissentingViews, dataFoundation, disclaimer, trackPrompt,
  };
}

function extractAssumptions(sim: SimulationResult): string[] {
  const assumptions: string[] = [];
  // Variable-based assumptions
  for (const [k, v] of Object.entries(sim.variables)) {
    assumptions.push(`Assumes ${k.replace(/_/g, ' ')} is ${v} (as specified).`);
  }
  // Behavioral assumptions
  if (sim.personas.some(p => p.type === 'archetype')) {
    assumptions.push('Some personas are based on general archetypes, not your specific data.');
  }
  assumptions.push('Assumes competitors do not make simultaneous changes (unless specified).');
  assumptions.push('Assumes no major external shocks (regulatory changes, economic events) during the prediction window.');
  return assumptions;
}
