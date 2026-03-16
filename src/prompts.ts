// ── Velixar MCP Server — Workflow Prompts ──
// 15 cognitive workflow prompts across 5 groups.
// Each prompt defines: purpose, trigger, tool order, reasoning rules,
// output form, stop conditions, and escalation.

export interface WorkflowPrompt {
  name: string;
  description: string;
  arguments?: Array<{ name: string; description: string; required?: boolean }>;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
}

// ── Group 1: Orientation ──

const recall_prior_reasoning: WorkflowPrompt = {
  name: 'recall_prior_reasoning',
  description: 'Recall and reconstruct prior reasoning about a topic. Use when resuming work or verifying past decisions.',
  arguments: [{ name: 'topic', description: 'Topic or decision to recall reasoning for', required: true }],
  messages: [{
    role: 'user',
    content: `Recall prior reasoning about: {{topic}}

Workflow:
1. Call velixar_context with topic="{{topic}}" for broad orientation
2. Call velixar_search for specific memories about this topic
3. Call velixar_timeline with topic="{{topic}}" to see how thinking evolved
4. If a specific memory needs detail, call velixar_inspect on it

Rules:
- Synthesize a coherent narrative of prior reasoning, not a raw memory dump
- Cite specific memories by ID when making claims
- Flag any contradictions or uncertainty
- Stop when you have a clear picture — do not over-fetch

Output: Brief form (summary, relevant facts, open issues, confidence)`,
  }],
};

const build_project_context: WorkflowPrompt = {
  name: 'build_project_context',
  description: 'Build comprehensive context for a project or workspace. Use when starting work on a project.',
  arguments: [{ name: 'project', description: 'Project name or topic', required: false }],
  messages: [{
    role: 'user',
    content: `Build project context${`{{project}}` !== '{{project}}' ? ' for: {{project}}' : ''}.

Workflow:
1. Call velixar_context for workspace overview
2. Call velixar_graph_traverse on key entities to map relationships
3. Call velixar_patterns to surface recurring motifs
4. Call velixar_identity to understand user preferences for this workspace

Rules:
- Prioritize actionable context over exhaustive history
- Highlight active contradictions and knowledge gaps
- Include entity relationships that inform current work
- Stop after patterns — do not chain further unless gaps are critical

Output: Brief form (summary, relevant facts, open issues, confidence)`,
  }],
};

const profile_entity: WorkflowPrompt = {
  name: 'profile_entity',
  description: 'Build a comprehensive profile of a specific entity (person, technology, concept).',
  arguments: [{ name: 'entity', description: 'Entity to profile', required: true }],
  messages: [{
    role: 'user',
    content: `Profile entity: {{entity}}

Workflow:
1. Call velixar_graph_traverse with entity="{{entity}}" to find connections
2. Call velixar_search for memories mentioning this entity
3. Call velixar_timeline with topic="{{entity}}" to trace its evolution

Rules:
- Build a structured profile: what it is, how it connects, how it changed
- Distinguish facts (from stored memories) from inferences (from patterns)
- Flag if entity data is sparse — suggest what to store
- Stop after timeline — do not over-fetch

Output: Brief form`,
  }],
};

const orient_then_narrow: WorkflowPrompt = {
  name: 'orient_then_narrow',
  description: 'Master reasoning pattern — broad orientation then targeted narrowing. Use for any task where context is broad or uncertain.',
  arguments: [{ name: 'question', description: 'The question or task to address', required: true }],
  messages: [{
    role: 'user',
    content: `Address this using orient-then-narrow: {{question}}

Workflow:
1. Call velixar_context to orient broadly
2. From the context, identify which cognitive mode fits:
   - Retrieval → velixar_search
   - Structure → velixar_graph_traverse
   - Continuity → velixar_timeline
   - Conflict → velixar_contradictions
   - Consolidation → velixar_distill
3. Call the specialized tool for that mode
4. Stop when the question is answered

Rules:
- Always start broad, then narrow — never skip orientation
- Pick exactly ONE specialized tool after context — do not chain all of them
- If context alone answers the question, stop there
- Respect justification: qualify inferred claims, assert retrieved facts

Output: Matches the cognitive mode's output form`,
  }],
};

// ── Group 2: Conflict & Uncertainty ──

const resolve_contradiction: WorkflowPrompt = {
  name: 'resolve_contradiction',
  description: 'Investigate and resolve a contradiction between stored beliefs or facts.',
  arguments: [{ name: 'topic', description: 'Topic area of the contradiction', required: false }],
  messages: [{
    role: 'user',
    content: `Resolve contradictions${`{{topic}}` !== '{{topic}}' ? ' about: {{topic}}' : ' in this workspace'}.

Workflow:
1. Call velixar_contradictions to surface active conflicts
2. For each high-severity contradiction, call velixar_inspect on both memory IDs
3. Call velixar_timeline to trace when beliefs diverged
4. Call velixar_identity to check if this reflects a preference shift

Rules:
- Present both sides with evidence before suggesting resolution
- A contradiction may be valid (beliefs genuinely changed) — don't force resolution
- If resolution is clear, suggest updating the outdated memory via velixar_update
- Flag unresolvable conflicts explicitly

Output: Resolution form (conflict summary, evidence, likely interpretation, next step)`,
  }],
};

const identify_knowledge_gaps: WorkflowPrompt = {
  name: 'identify_knowledge_gaps',
  description: 'Find what is missing or incomplete in the workspace knowledge.',
  arguments: [{ name: 'domain', description: 'Domain to check for gaps', required: false }],
  messages: [{
    role: 'user',
    content: `Identify knowledge gaps${`{{domain}}` !== '{{domain}}' ? ' in: {{domain}}' : ''}.

Workflow:
1. Call velixar_context for current state of knowledge
2. Call velixar_graph_traverse on key entities — look for disconnected or sparse nodes
3. Call velixar_contradictions — unresolved conflicts indicate uncertain areas

Rules:
- Distinguish "no data" from "low confidence data" from "conflicting data"
- Prioritize gaps that block current work
- Suggest specific memories to store to fill critical gaps
- Stop after contradictions — this is a diagnostic workflow, not a fix

Output: Gap Report form (knowns, unknowns, blockers, next questions)`,
  }],
};

// ── Group 3: Time & Continuity ──

const trace_belief_evolution: WorkflowPrompt = {
  name: 'trace_belief_evolution',
  description: 'Trace how a belief, preference, or understanding changed over time.',
  arguments: [{ name: 'belief', description: 'Belief or topic to trace', required: true }],
  messages: [{
    role: 'user',
    content: `Trace the evolution of: {{belief}}

Workflow:
1. Call velixar_timeline with topic="{{belief}}" for temporal ordering
2. Call velixar_search for all memories related to this belief
3. Call velixar_contradictions to find where beliefs conflicted

Rules:
- Present as a chronological narrative with clear change points
- Identify what triggered each change (new information, decision, preference shift)
- Mark the current state clearly
- Flag uncertainty where timeline is sparse

Output: Timeline form (phases, key change points, current state, uncertainty)`,
  }],
};

const resume_previous_session: WorkflowPrompt = {
  name: 'resume_previous_session',
  description: 'Resume work from a previous session. Use when returning to a project after a break.',
  arguments: [
    { name: 'session_id', description: 'Previous session ID (if known)', required: false },
    { name: 'topic', description: 'Topic to resume', required: false },
  ],
  messages: [{
    role: 'user',
    content: `Resume previous session${`{{session_id}}` !== '{{session_id}}' ? ' (session: {{session_id}})' : ''}${`{{topic}}` !== '{{topic}}' ? ' about: {{topic}}' : ''}.

Workflow:
1. Call velixar_session_recall with session_id or topic to find prior session context
2. Call velixar_context to get current workspace state
3. Call velixar_search for any updates since the last session

Rules:
- Summarize where the user left off
- Highlight what changed since the last session
- Surface any new contradictions or patterns
- Keep it concise — the user wants to resume, not review everything

Output: Brief form`,
  }],
};

const reconstruct_decision_path: WorkflowPrompt = {
  name: 'reconstruct_decision_path',
  description: 'Reconstruct the reasoning path that led to a specific decision.',
  arguments: [{ name: 'decision', description: 'Decision to reconstruct', required: true }],
  messages: [{
    role: 'user',
    content: `Reconstruct the decision path for: {{decision}}

Workflow:
1. Call velixar_timeline with topic="{{decision}}" to find the decision point
2. Call velixar_inspect on the decision memory and surrounding memories
3. Call velixar_search for context that informed the decision

Rules:
- Present the reasoning chain: context → options considered → decision → rationale
- Cite specific memories as evidence
- Flag if the reasoning chain has gaps
- Note if circumstances have changed since the decision

Output: Timeline form`,
  }],
};

// ── Group 4: Memory Lifecycle ──

const distill_session: WorkflowPrompt = {
  name: 'distill_session',
  description: 'Extract and store durable memories from the current session. Use at session end or natural breakpoints.',
  arguments: [{ name: 'session_summary', description: 'Summary of what happened this session', required: true }],
  messages: [{
    role: 'user',
    content: `Distill this session: {{session_summary}}

Workflow:
1. Identify memory-worthy content: decisions, preferences, bugs solved, patterns discovered
2. Call velixar_distill for each distinct takeaway (it handles duplicate detection)
3. Call velixar_retag on stored memories if tags need refinement
4. Call velixar_consolidate if multiple memories cover the same topic

Rules:
- Only distill content worth remembering long-term — skip transient chatter
- Each distilled memory should be self-contained and searchable
- Prefer semantic memories (durable facts) over episodic (event-specific)
- Report what was stored, skipped (duplicate), and flagged (contradiction)

Output: Distillation Set form`,
  }],
};

const consolidate_topic_memory: WorkflowPrompt = {
  name: 'consolidate_topic_memory',
  description: 'Merge scattered memories about a topic into a unified semantic memory.',
  arguments: [{ name: 'topic', description: 'Topic to consolidate', required: true }],
  messages: [{
    role: 'user',
    content: `Consolidate memories about: {{topic}}

Workflow:
1. Call velixar_search for all memories about this topic
2. Call velixar_consolidate with the found memory IDs and a synthesized summary
3. Call velixar_retag on the consolidated memory with clean tags

Rules:
- The consolidated memory should capture the current understanding, not history
- Preserve original memory IDs as provenance (consolidate does this automatically)
- If memories contradict, note the conflict in the consolidated summary
- Show before (scattered) and after (unified) state

Output: Distillation Set form`,
  }],
};

const retag_recent_memories: WorkflowPrompt = {
  name: 'retag_recent_memories',
  description: 'Review and improve tags on recent memories for better organization and retrieval.',
  arguments: [{ name: 'count', description: 'Number of recent memories to review (default 10)', required: false }],
  messages: [{
    role: 'user',
    content: `Review and retag recent memories (up to {{count}} or 10).

Workflow:
1. Call velixar_list to get recent memories
2. For each memory, evaluate if tags are accurate and complete
3. Call velixar_retag to fix tags that are missing, wrong, or too generic

Rules:
- Tags should be specific enough to aid retrieval but not so specific they're unique
- Add domain tags (e.g., "architecture", "bugfix", "decision") where missing
- Remove redundant or overly generic tags
- Report what was changed and why

Output: Distillation Set form`,
  }],
};

// ── Group 5: Identity & Personalization ──

const summarize_user_identity: WorkflowPrompt = {
  name: 'summarize_user_identity',
  description: 'Build a comprehensive summary of the user identity for this workspace.',
  arguments: [],
  messages: [{
    role: 'user',
    content: `Summarize user identity for this workspace.

Workflow:
1. Call velixar_identity to get the current profile
2. Call velixar_search for memories tagged with preferences, expertise, or goals
3. Call velixar_graph_traverse on identity-related entities

Rules:
- Distinguish stored facts from inferred patterns
- Flag areas where identity data is sparse or contradictory
- Present as a structured profile, not a memory dump
- Note if identity differs from other workspaces (if visible)

Output: Brief form`,
  }],
};

const detect_preference_shift: WorkflowPrompt = {
  name: 'detect_preference_shift',
  description: 'Detect if user preferences or beliefs have shifted over time.',
  arguments: [{ name: 'area', description: 'Preference area to check (e.g., "coding style", "tools")', required: false }],
  messages: [{
    role: 'user',
    content: `Detect preference shifts${`{{area}}` !== '{{area}}' ? ' in: {{area}}' : ''}.

Workflow:
1. Call velixar_identity to get current profile
2. Call velixar_timeline with topic matching the preference area
3. Call velixar_contradictions to find conflicting preference statements

Rules:
- A preference shift is valid — don't treat it as an error
- Present the evolution: old preference → trigger → new preference
- Suggest updating identity if a shift is confirmed
- Flag if the shift is ambiguous (might be context-dependent, not a true change)

Output: Resolution form`,
  }],
};

const align_response_style: WorkflowPrompt = {
  name: 'align_response_style',
  description: 'Check user communication preferences and align response style accordingly.',
  arguments: [],
  messages: [{
    role: 'user',
    content: `Check and align to user communication preferences.

Workflow:
1. Call velixar_identity to get communication_style and preferences

Rules:
- Apply the user's stated preferences to your response style
- If no preferences are stored, use neutral professional style
- Do not over-personalize — respect stated boundaries
- This is a quick check, not a deep analysis — one tool call is enough

Output: Brief form (just the relevant style preferences)`,
  }],
};

// ── Group 6: Enterprise & Sales ──

const evaluate_enterprise_fit: WorkflowPrompt = {
  name: 'evaluate_enterprise_fit',
  description: 'Evaluate whether a domain/company is a good fit for Velixar enterprise. Synthesizes knowledge graph data about the domain.',
  arguments: [
    { name: 'domain', description: 'Company domain or name to evaluate', required: true },
  ],
  messages: [{
    role: 'user',
    content: `Evaluate enterprise fit for: {{domain}}

Workflow:
1. Call velixar_search for any existing memories about {{domain}}
2. Call velixar_graph_traverse with entity="{{domain}}" to find related entities
3. Call velixar_context with topic="{{domain}} enterprise evaluation"
4. Call velixar_patterns with topic="enterprise adoption" for adoption patterns

Evaluate:
- Team size signals (mentions of teams, departments, org structure)
- Technical maturity (CI/CD, MCP usage, LLM integration mentions)
- Pain points that Velixar solves (context loss, knowledge silos, decision tracking)
- Engagement signals (API usage frequency, memory volume, feature requests)

Output form:
- fit_score: 1-10
- signals: list of positive/negative indicators
- recommended_tier: free | pro | teams | enterprise
- next_action: suggested outreach or nurture step
- gaps: what information is missing to make a confident assessment`,
  }],
};

// ── Export ──

export const allPrompts: WorkflowPrompt[] = [
  // Group 1: Orientation
  recall_prior_reasoning,
  build_project_context,
  profile_entity,
  orient_then_narrow,
  // Group 2: Conflict & Uncertainty
  resolve_contradiction,
  identify_knowledge_gaps,
  // Group 3: Time & Continuity
  trace_belief_evolution,
  resume_previous_session,
  reconstruct_decision_path,
  // Group 4: Memory Lifecycle
  distill_session,
  consolidate_topic_memory,
  retag_recent_memories,
  // Group 5: Identity & Personalization
  summarize_user_identity,
  detect_preference_shift,
  align_response_style,
  // Group 6: Enterprise & Sales
  evaluate_enterprise_fit,
];

export function getPromptList() {
  return {
    prompts: allPrompts.map(p => ({
      name: p.name,
      description: p.description,
      arguments: p.arguments,
    })),
  };
}

export function getPrompt(name: string, promptArgs: Record<string, string> = {}) {
  const prompt = allPrompts.find(p => p.name === name);
  if (!prompt) throw new Error(`Unknown prompt: ${name}`);

  const messages = prompt.messages.map(m => {
    let content = m.content;
    for (const [key, value] of Object.entries(promptArgs)) {
      content = content.replaceAll(`{{${key}}}`, value);
    }
    return { role: m.role as 'user' | 'assistant', content: { type: 'text' as const, text: content } };
  });

  return { description: prompt.description, messages };
}
