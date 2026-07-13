// ── Clairvoyance MCP Tools ──
// velixar_simulate, velixar_scenario, velixar_predict
// Enterprise add-on only. Gated by VELIXAR_CLAIRVOYANCE flag.

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
import type { ApiClient } from '../api.js';
import { wrapResponse } from '../api.js';
import type { ApiConfig } from '../types.js';
import { validateSearchResponse } from '../validate.js';
import { generatePersonas } from '../simulation/personas.js';
import { runSimulation } from '../simulation/runner.js';
import { generateReport } from '../simulation/report.js';

const CLAIRVOYANCE_ENABLED = process.env.VELIXAR_CLAIRVOYANCE === 'true';

export const clairvoyanceTools: Tool[] = CLAIRVOYANCE_ENABLED ? [
  {
    name: 'velixar_simulate',
    description:
      'Run a multi-agent simulation to explore potential outcomes. Enterprise add-on. ' +
      'Returns a prediction report with confidence ranges, risks, and assumptions. Metered — cost estimate shown first.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The "what if" question to simulate' },
        context: { type: 'string', description: 'Additional context to seed the simulation' },
        agent_count: { type: 'number', description: 'Number of personas (default 12, max 30)' },
        round_count: { type: 'number', description: 'Simulation rounds (default 20, max 50)' },
        variables: { type: 'object', description: 'Key variables to inject (e.g., {"price_increase": "20%"})' },
        persona_types: { type: 'array', items: { type: 'string' }, description: 'Override persona types: customer, competitor, regulator, internal_team, market_force, investor' },
        fresh: { type: 'boolean', description: 'Exclude past simulation insights (default: false)' },
        async: { type: 'boolean', description: 'Non-blocking mode — returns simulation_id immediately (default: false)' },
        seed: { type: 'number', description: 'Random seed for reproducible simulations' },
        model: { type: 'string', description: 'LLM model override (default: gpt-4o-mini)' },
      },
      required: ['question'],
    },
  },
  {
    name: 'velixar_scenario',
    description:
      'Compare multiple scenarios side by side. Runs parallel simulations with different variables. Enterprise add-on. Metered.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The base question' },
        scenarios: {
          type: 'array',
          items: { type: 'object', properties: { name: { type: 'string' }, variables: { type: 'object' } }, required: ['name', 'variables'] },
          description: 'Array of {name, variables} to compare',
        },
        agent_count: { type: 'number', description: 'Personas per scenario (default 12)' },
        round_count: { type: 'number', description: 'Rounds per scenario (default 20)' },
        verify: { type: 'boolean', description: 'Run top 2 scenarios twice for stability check (doubles cost for those 2)' },
      },
      required: ['question', 'scenarios'],
    },
  },
  {
    name: 'velixar_predict',
    description:
      'Lightweight prediction using existing memories and patterns — no simulation. Enterprise add-on. ' +
      'Returns prediction with confidence and supporting evidence.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The prediction question' },
        depth: { type: 'string', enum: ['quick', 'thorough'], description: 'quick = patterns only, thorough = patterns + search + contradictions (default: thorough)' },
      },
      required: ['question'],
    },
  },
] : [];

// ── LLM Call Factory ──
function makeLLMCall(api: ApiClient, model: string): (system: string, user: string) => Promise<string> {
  return async (system: string, user: string) => {
    // Route through Velixar backend LLM proxy or direct OpenAI
    const res = await api.post<{ content?: string; choices?: Array<{ message?: { content?: string } }> }>('/llm/chat', {
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.7,
      max_tokens: 300,
    });
    return res.content || res.choices?.[0]?.message?.content || '';
  };
}

// ── Cost Estimation ──
function estimateCost(agentCount: number, roundCount: number, activationProb: number): { tokens: number; cost: number; timeSeconds: number } {
  const activePerRound = Math.ceil(agentCount * activationProb);
  const totalCalls = activePerRound * roundCount;
  const tokensPerCall = 800; // system prompt + context + response
  const tokens = totalCalls * tokensPerCall;
  const cost = tokens * 0.0000006; // GPT-4o-mini approximate
  const batches = Math.ceil(totalCalls / 10);
  const timeSeconds = Math.ceil(batches * 0.8) + 8; // +8 for persona gen + report
  return { tokens, cost: Math.round(cost * 100) / 100, timeSeconds };
}

export async function handleClairvoyanceTool(
  name: string,
  args: Record<string, unknown>,
  api: ApiClient,
  config: ApiConfig,
): Promise<{ text: string; isError?: boolean }> {

  if (!CLAIRVOYANCE_ENABLED) {
    return {
      text: JSON.stringify({ error: 'Clairvoyance is an enterprise add-on. Contact sales to enable.' }),
      isError: true,
    };
  }

  if (name === 'velixar_simulate') {
    const question = args.question as string;
    const variables = (args.variables as Record<string, string>) || {};
    const agentCount = Math.min((args.agent_count as number) || 12, 30); // H2.6
    const roundCount = Math.min((args.round_count as number) || 20, 50); // H2.6
    const model = (args.model as string) || 'gpt-4o-mini';
    const fresh = args.fresh as boolean;
    const seed = args.seed as number | undefined;
    const simulationId = `sim-${randomUUID().slice(0, 12)}`;

    // Cost estimate (shown before execution)
    const activationProb = Math.max(0.6, Math.min(0.9, 1 - (roundCount / 100)));
    const estimate = estimateCost(agentCount, roundCount, activationProb);

    // Step 1: Data foundation assessment (Chain 9)
    let coverageRatio = 0;
    let seedMemoryCount = 0;
    try {
      const params = new URLSearchParams({ q: question, user_id: config.userId, limit: '20' });
      const raw = await api.get<unknown>(`/memory/search?${params}`, true);
      const validated = validateSearchResponse(raw, '/memory/search');
      seedMemoryCount = validated.memories.length;
      coverageRatio = Math.min(1.0, seedMemoryCount / 20);
    } catch { /* proceed with zero coverage */ }

    const minDataThreshold = (args.min_data_threshold as number) || 10;

    // Step 2: Generate personas
    const llmCall = makeLLMCall(api, model);
    const personaResult = await generatePersonas(question, variables, api, config, llmCall, {
      agentCount, personaTypes: args.persona_types as string[], fresh, simulationId,
    });
    const personas = personaResult.personas;

    // Step 3: Run simulation
    const result = await runSimulation({
      simulationId, question, variables, personas, roundCount,
      llmCall, seed, concurrency: 10, timeoutMs: 60000,
    });

    // Step 4: Generate report
    const report = generateReport(result, personas, coverageRatio, seedMemoryCount, minDataThreshold);

    // Step 5: Store prediction as hypothesis memory (H4.2: inline disclaimer)
    try {
      await api.post('/memory', {
        content: report.prediction,
        user_id: config.userId,
        tier: 2,
        tags: ['clairvoyance', 'prediction', 'active', simulationId],
        source_type: 'clairvoyance',
      });
    } catch { /* non-blocking */ }

    // Step 6: Store simulation insight (Chain 11: escapes quarantine)
    try {
      const insightContent = `${report.badge} Simulation ${simulationId}: "${question}" → ${result.emergentConsensus} (confidence: ${report.confidenceRange.low}-${report.confidenceRange.high}). Key factors: ${report.keyFactors.slice(0, 2).join('; ')}`;
      await api.post('/memory', {
        content: insightContent,
        user_id: config.userId,
        tier: 2,
        tags: ['clairvoyance', 'simulation-insight', simulationId],
        source_type: 'clairvoyance',
      });
    } catch { /* non-blocking */ }

    // Step 7: Log billing event
    const usage = { tokens_consumed: result.tokensUsed, estimated_cost: estimate.cost, agent_count: agentCount, round_count: roundCount };

    return {
      text: JSON.stringify(wrapResponse({
        simulation_id: simulationId,
        report: {
          badge: report.badge,
          prediction: report.prediction,
          confidence: report.confidenceRange,
          key_factors: report.keyFactors,
          what_could_go_wrong: report.risks,
          assumptions: report.assumptions,
          timeline: report.timeline,
          dissenting_views: report.dissentingViews,
          data_foundation: report.dataFoundation,
        },
        simulation_metadata: {
          rounds_completed: result.rounds.length,
          rounds_planned: roundCount,
          convergence_round: result.convergenceRound,
          personas: result.personas,
          aborted: result.aborted,
        },
        usage,
        disclaimer: report.disclaimer,
        track_this_prediction: report.trackPrompt,
      }, config)),
    };
  }

  if (name === 'velixar_scenario') {
    const question = args.question as string;
    const scenarios = args.scenarios as Array<{ name: string; variables: Record<string, string> }>;
    const agentCount = Math.min((args.agent_count as number) || 12, 30);
    const roundCount = Math.min((args.round_count as number) || 20, 50);

    if (!scenarios?.length || scenarios.length > 5) {
      return { text: JSON.stringify({ error: 'Provide 1-5 scenarios.' }), isError: true };
    }

    // Cost estimate for all scenarios
    const activationProb = Math.max(0.6, Math.min(0.9, 1 - (roundCount / 100)));
    const perScenario = estimateCost(agentCount, roundCount, activationProb);
    const totalEstimate = {
      tokens: perScenario.tokens * scenarios.length,
      cost: Math.round(perScenario.cost * scenarios.length * 100) / 100,
      timeSeconds: perScenario.timeSeconds * 2, // parallel but not instant
    };

    // Run all scenarios in parallel
    const results = await Promise.allSettled(
      scenarios.map(async (scenario) => {
        const simId = `sim-${randomUUID().slice(0, 12)}`;
        const llmCall = makeLLMCall(api, 'gpt-4o-mini');
        const personaResult = await generatePersonas(question, scenario.variables, api, config, llmCall, {
          agentCount, simulationId: simId,
        });
        const personas = personaResult.personas;
        const simResult = await runSimulation({
          simulationId: simId, question, variables: scenario.variables,
          personas, roundCount, llmCall, concurrency: 10, timeoutMs: 60000,
        });

        let coverageRatio = 0, seedMemoryCount = 0;
        try {
          const params = new URLSearchParams({ q: question, user_id: config.userId, limit: '20' });
          const raw = await api.get<unknown>(`/memory/search?${params}`, true);
          const validated = validateSearchResponse(raw, '/memory/search');
          seedMemoryCount = validated.memories.length;
          coverageRatio = Math.min(1.0, seedMemoryCount / 20);
        } catch { /* */ }

        const report = generateReport(simResult, personas, coverageRatio, seedMemoryCount, 10);
        return { name: scenario.name, variables: scenario.variables, simulationId: simId, report, convergenceRound: simResult.convergenceRound };
      }),
    );

    const completed = results
      .filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled')
      .map(r => r.value);

    // H6.4: Comparison uses ranges and directional language
    const comparison = completed.map(s => ({
      scenario: s.name,
      variables: s.variables,
      simulation_id: s.simulationId,
      confidence: s.report.confidenceRange,
      consensus: s.report.prediction.split('\n').find((l: string) => !l.startsWith('['))?.trim() || '',
      convergence: s.convergenceRound ? `Round ${s.convergenceRound}` : 'Did not converge',
      top_risk: s.report.risks[0] || 'None identified',
    }));

    // Recommendation: highest confidence
    const best = completed.sort((a, b) => b.report.confidenceRange.high - a.report.confidenceRange.high)[0];

    return {
      text: JSON.stringify(wrapResponse({
        comparison,
        recommendation: best
          ? `"${best.name}" shows the strongest signal (confidence ${best.report.confidenceRange.low}-${best.report.confidenceRange.high}). However, all scenarios carry uncertainty — review assumptions before acting.`
          : 'Unable to determine a clear recommendation.',
        scenarios_completed: completed.length,
        scenarios_failed: results.filter(r => r.status === 'rejected').length,
        usage: totalEstimate,
        disclaimer: 'Scenario comparison shows directional differences, not precise outcomes. Use to inform strategy, not as a forecast.',
      }, config)),
    };
  }

  if (name === 'velixar_predict') {
    const question = args.question as string;
    const depth = (args.depth as string) || 'thorough';

    // Pattern-based prediction — no simulation, no incremental LLM cost
    const evidence: Array<{ content: string; relevance: number }> = [];

    // Search for relevant memories
    try {
      const params = new URLSearchParams({ q: question, user_id: config.userId, limit: '10' });
      const raw = await api.get<unknown>(`/memory/search?${params}`, true);
      const validated = validateSearchResponse(raw, '/memory/search');
      for (const m of validated.memories) {
        evidence.push({ content: m.content.slice(0, 200), relevance: m.score ?? 0 });
      }
    } catch { /* */ }

    // Check for existing predictions on this topic
    let existingPrediction: string | null = null;
    try {
      const params = new URLSearchParams({ q: `prediction ${question}`, user_id: config.userId, limit: '3', tags: 'clairvoyance,prediction' });
      const raw = await api.get<unknown>(`/memory/search?${params}`, true);
      const validated = validateSearchResponse(raw, '/memory/search');
      if (validated.memories.length > 0) {
        existingPrediction = validated.memories[0].content;
      }
    } catch { /* */ }

    // Check patterns
    let patterns: string[] = [];
    if (depth === 'thorough') {
      try {
        const patternData = await api.post<Record<string, unknown>>('/exocortex/patterns', { topic: question });
        const p = Array.isArray(patternData?.patterns) ? patternData.patterns : [];
        patterns = (p as Array<Record<string, unknown>>).slice(0, 3).map(pt => String(pt.description || pt.pattern || ''));
      } catch { /* */ }
    }

    // Check contradictions
    let contradictions: string[] = [];
    if (depth === 'thorough') {
      try {
        const cData = await api.get<Record<string, unknown>>('/exocortex/contradictions?status=open', true);
        const cs = Array.isArray(cData?.contradictions) ? cData.contradictions : [];
        contradictions = (cs as Array<Record<string, unknown>>).slice(0, 3).map(c =>
          `${String(c.statement_a || '').slice(0, 80)} vs ${String(c.statement_b || '').slice(0, 80)}`
        );
      } catch { /* */ }
    }

    const confidence = Math.min(0.9, evidence.filter(e => e.relevance > 0.5).length / 10 + (patterns.length * 0.1));

    return {
      text: JSON.stringify(wrapResponse({
        question,
        existing_prediction: existingPrediction,
        evidence: evidence.slice(0, 5),
        patterns,
        contradictions,
        confidence: Math.round(confidence * 100) / 100,
        assessment: confidence >= 0.6
          ? 'Enough data for a pattern-based estimate. See evidence above.'
          : 'Limited data — consider running velixar_simulate for a deeper analysis.',
        depth,
      }, config, { data_absent: evidence.length === 0 })),
    };
  }

  throw new Error(`Unknown clairvoyance tool: ${name}`);
}
