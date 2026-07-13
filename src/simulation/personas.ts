// ── Persona Generator v2 ──
// Upgraded based on MiroFish comparison: richer profiles, behavioral depth,
// activity patterns, LLM-generated personas instead of templates.

import type { ApiClient } from '../api.js';
import type { ApiConfig } from '../types.js';
import { validateSearchResponse } from '../validate.js';

export interface Persona {
  id: string;
  name: string;
  role: string;
  type: 'data_grounded' | 'archetype' | 'devils_advocate';
  bio: string;
  goals: string;
  behavior: string;
  sensitivity: 'high' | 'medium' | 'low';
  personality: { traits: string[]; decisionStyle: string; riskTolerance: string };
  knowledge: string[];
  relationships: string[];
  activityLevel: number; // 0-1, how often they act
  systemPrompt: string;
  memoryCount: number;
}

export interface PersonaGenerationResult {
  personas: Persona[];
  dataFoundation: { totalMemories: number; kgEntities: number; groundedCount: number; archetypeCount: number };
}

const ROLE_DEFAULTS: Record<string, { goals: string; traits: string[]; riskTolerance: string }> = {
  customer: { goals: 'Maximize value, minimize cost, evaluate alternatives', traits: ['price-aware', 'comparison-driven', 'loyalty-conditional'], riskTolerance: 'medium' },
  competitor: { goals: 'Capture market share, exploit weaknesses', traits: ['aggressive', 'opportunistic', 'fast-moving'], riskTolerance: 'high' },
  regulator: { goals: 'Ensure fairness, protect consumers, enforce rules', traits: ['rule-based', 'slow-moving', 'precedent-driven'], riskTolerance: 'low' },
  internal_team: { goals: 'Hit targets while retaining customers', traits: ['revenue-focused', 'risk-averse', 'data-driven'], riskTolerance: 'low' },
  market_force: { goals: 'Reflect macro trends and industry dynamics', traits: ['impersonal', 'trend-driven', 'cyclical'], riskTolerance: 'neutral' },
  investor: { goals: 'Maximize returns, evaluate growth vs profitability', traits: ['metrics-driven', 'benchmark-comparing', 'impatient'], riskTolerance: 'high' },
  media: { goals: 'Amplify narratives, drive engagement', traits: ['attention-seeking', 'narrative-driven', 'reactive'], riskTolerance: 'high' },
  partner: { goals: 'Protect joint value, maintain relationship', traits: ['collaborative', 'contract-aware', 'long-term-oriented'], riskTolerance: 'low' },
};

type LLMCall = (system: string, user: string) => Promise<string>;

export async function generatePersonas(
  question: string,
  variables: Record<string, string>,
  api: ApiClient,
  config: ApiConfig,
  llmCall: LLMCall,
  opts: { agentCount?: number; personaTypes?: string[]; fresh?: boolean; simulationId: string },
): Promise<PersonaGenerationResult> {
  const count = Math.min(opts.agentCount || 12, 30);
  const types = opts.personaTypes?.length ? opts.personaTypes : inferTypes(question);

  // Gather workspace context in parallel
  const [memories, kgEntities] = await Promise.all([
    searchWorkspace(question, variables, api, config, opts.fresh),
    traverseKG(question, api),
  ]);

  const personas: Persona[] = [];
  const perType = Math.max(1, Math.floor(count / types.length));
  const sensitivities: Array<'high' | 'medium' | 'low'> = ['high', 'medium', 'low'];

  for (const role of types) {
    for (let i = 0; i < perType && personas.length < count; i++) {
      const sensitivity = sensitivities[i % 3];
      const roleMemories = memories.filter(m =>
        m.content.toLowerCase().includes(role) || m.relevance > 0.6
      ).slice(0, 8);
      const roleKG = kgEntities.filter(e =>
        e.toLowerCase().includes(role) || role.includes(e.split(' ')[0].toLowerCase())
      ).slice(0, 3);

      const persona = await buildPersonaWithLLM(
        role, i, sensitivity, question, variables,
        roleMemories, roleKG, llmCall, opts.simulationId,
      );
      personas.push(persona);
    }
  }

  return {
    personas,
    dataFoundation: {
      totalMemories: memories.length,
      kgEntities: kgEntities.length,
      groundedCount: personas.filter(p => p.type === 'data_grounded').length,
      archetypeCount: personas.filter(p => p.type === 'archetype').length,
    },
  };
}

export function generateDevilsAdvocates(consensus: string, simId: string): Persona[] {
  const base = { type: 'devils_advocate' as const, goals: '', behavior: '', sensitivity: 'high' as const, knowledge: [], relationships: [], activityLevel: 1.0, memoryCount: 0 };
  return [
    { ...base, id: `${simId}-da-1`, name: 'The Skeptic', role: 'devils_advocate', bio: 'Challenges consensus by finding unstated assumptions.',
      personality: { traits: ['contrarian', 'analytical', 'thorough'], decisionStyle: 'evidence-demanding', riskTolerance: 'seeks-risk-in-consensus' },
      systemPrompt: `You are "The Skeptic." The emerging consensus is: "${consensus}". Find the strongest argument AGAINST it. Focus on unstated assumptions, historical precedents where similar consensus was wrong, and hidden risks. Be specific — name what could go wrong and why. 2-4 sentences.` },
    { ...base, id: `${simId}-da-2`, name: 'The Edge Case', role: 'devils_advocate', bio: 'Identifies tail risks and black swan scenarios.',
      personality: { traits: ['creative', 'paranoid', 'scenario-oriented'], decisionStyle: 'worst-case-first', riskTolerance: 'assumes-tail-risk' },
      systemPrompt: `You are "The Edge Case." The emerging consensus is: "${consensus}". Identify the scenario where this completely breaks down. Think: what external shock, competitor move, or customer behavior would make this prediction catastrophically wrong? Be specific. 2-4 sentences.` },
  ];
}

// ── Internal ──

async function searchWorkspace(
  question: string, variables: Record<string, string>,
  api: ApiClient, config: ApiConfig, fresh?: boolean,
): Promise<Array<{ content: string; relevance: number }>> {
  const queries = [
    question.slice(0, 100),
    Object.values(variables).join(' ').slice(0, 100),
    ...(fresh ? [] : ['simulation insight']),
  ].filter(Boolean);

  const results: Array<{ content: string; relevance: number; id: string }> = [];
  const seen = new Set<string>();

  const fetches = await Promise.allSettled(
    queries.map(q => {
      const params = new URLSearchParams({ q, user_id: config.userId, limit: '10' });
      return api.get<unknown>(`/memory/search?${params}`, true);
    }),
  );

  for (const r of fetches) {
    if (r.status !== 'fulfilled') continue;
    try {
      const v = validateSearchResponse(r.value, '/memory/search');
      for (const m of v.memories) {
        if (seen.has(m.id) || (m.score ?? 0) < 0.3) continue;
        seen.add(m.id);
        results.push({ content: m.content.slice(0, 400), relevance: m.score ?? 0, id: m.id });
      }
    } catch { /* skip */ }
  }

  return results.sort((a, b) => b.relevance - a.relevance).slice(0, 30);
}

async function traverseKG(question: string, api: ApiClient): Promise<string[]> {
  try {
    const data = await api.post<Record<string, unknown>>('/graph/traverse', {
      entity: question.split(' ').slice(0, 3).join(' '), max_hops: 2,
    });
    const nodes = Array.isArray(data?.nodes) ? data.nodes : [];
    return (nodes as Array<Record<string, unknown>>).map(n => String(n.label || n.content || '')).filter(Boolean).slice(0, 10);
  } catch { return []; }
}

function inferTypes(question: string): string[] {
  const q = question.toLowerCase();
  const types: string[] = [];
  if (/pric|cost|fee|rate|revenue|churn/.test(q)) types.push('customer', 'competitor', 'internal_team');
  if (/regulat|compliance|law|policy|government/.test(q)) types.push('regulator');
  if (/market|industry|trend|economy|macro/.test(q)) types.push('market_force');
  if (/invest|fund|valuation|growth|ipo/.test(q)) types.push('investor');
  if (/press|media|public|reputation|brand/.test(q)) types.push('media');
  if (/partner|channel|integration|alliance/.test(q)) types.push('partner');
  if (types.length === 0) types.push('customer', 'competitor', 'internal_team');
  if (!types.includes('customer') && types.length < 4) types.unshift('customer');
  return [...new Set(types)];
}

async function buildPersonaWithLLM(
  role: string, index: number, sensitivity: 'high' | 'medium' | 'low',
  question: string, variables: Record<string, string>,
  memories: Array<{ content: string; relevance: number }>,
  kgEntities: string[],
  llmCall: LLMCall, simId: string,
): Promise<Persona> {
  const defaults = ROLE_DEFAULTS[role] || ROLE_DEFAULTS.customer;
  const id = `${simId}-${role}-${index}`;
  const grounded = memories.length >= 3;
  const variableStr = Object.entries(variables).map(([k, v]) => `${k}: ${v}`).join(', ');

  // Use LLM to generate a rich persona (like MiroFish's profile generator)
  let bio: string, behavior: string, name: string;
  try {
    const raw = await llmCall(
      'You generate concise character profiles for business simulations. Respond in JSON only.',
      `Create a ${role.replace(/_/g, ' ')} persona for this scenario: "${question}" (variables: ${variableStr}).
Sensitivity to the scenario: ${sensitivity}.
${memories.length > 0 ? `Context from real data:\n${memories.slice(0, 5).map(m => `- ${m.content.slice(0, 150)}`).join('\n')}` : 'No specific data available — use general knowledge.'}
${kgEntities.length > 0 ? `Related entities: ${kgEntities.join(', ')}` : ''}

Return JSON: {"name":"<realistic name>","bio":"<1 sentence>","behavior":"<2 sentences: how they react to this scenario specifically>","traits":["<3 traits>"],"decision_style":"<one phrase>"}`,
    );
    const parsed = JSON.parse(raw.replace(/```json?\n?/g, '').replace(/```/g, '').trim());
    name = parsed.name || `${role} ${index + 1}`;
    bio = parsed.bio || `A ${role} stakeholder.`;
    behavior = parsed.behavior || defaults.goals;
  } catch {
    name = `${role.replace(/_/g, ' ')} ${index + 1}`.replace(/\b\w/g, c => c.toUpperCase());
    bio = `A ${role.replace(/_/g, ' ')} stakeholder in this scenario.`;
    behavior = defaults.goals;
  }

  const knowledgeLines = memories.map(m => m.content.slice(0, 300));
  const relationshipLines = kgEntities.map(e => `Connected to: ${e}`);

  const systemPrompt = [
    `You are "${name}" — ${bio}`,
    `Role: ${role.replace(/_/g, ' ')}. Sensitivity to scenario variables: ${sensitivity}.`,
    `Behavior: ${behavior}`,
    '',
    `SCENARIO: ${question}`,
    `VARIABLES: ${variableStr || 'None specified.'}`,
    '',
    knowledgeLines.length > 0
      ? `YOUR KNOWLEDGE (from real data):\n${knowledgeLines.slice(0, 8).map((k, i) => `${i + 1}. ${k}`).join('\n')}`
      : 'You have no specific data — reason from general knowledge about your role.',
    relationshipLines.length > 0 ? `\nRELATIONSHIPS:\n${relationshipLines.join('\n')}` : '',
    '',
    'Respond with a specific action or reaction (2-4 sentences). State what you DO and WHY. Reference specific facts from your knowledge when possible.',
  ].filter(Boolean).join('\n');

  return {
    id, name, role, bio,
    type: grounded ? 'data_grounded' : 'archetype',
    goals: defaults.goals,
    behavior,
    sensitivity,
    personality: { traits: defaults.traits, decisionStyle: 'contextual', riskTolerance: defaults.riskTolerance },
    knowledge: knowledgeLines,
    relationships: relationshipLines,
    activityLevel: sensitivity === 'high' ? 0.9 : sensitivity === 'medium' ? 0.7 : 0.5,
    systemPrompt,
    memoryCount: memories.length,
  };
}
