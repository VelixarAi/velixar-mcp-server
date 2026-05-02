// ── Velixar MCP Server — Workflow Prompts ──
// 18 cognitive workflow prompts across 7 groups.
// Each prompt defines: purpose, trigger, tool order, reasoning rules,
// output form, stop conditions, and escalation.

export interface WorkflowPrompt {
  name: string;
  description: string;
  version: string; // S4: Prompt versioning — bump when content changes
  arguments?: Array<{ name: string; description: string; required?: boolean }>;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
}

// S7: Single source of truth for cognitive mode → tool mapping.
// Used by both prompts.ts (constitution prompt) and resources.ts (constitution resource).
export const COGNITIVE_MODES = [
  { mode: 'Orientation', question: '"Understand the situation broadly"', tool: 'velixar_context' },
  { mode: 'Retrieval', question: '"I know what I\'m looking for"', tool: 'velixar_search' },
  { mode: 'Deep Retrieval', question: '"I need comprehensive coverage"', tool: 'velixar_multi_search' },
  { mode: 'Structure', question: '"Understand connections"', tool: 'velixar_graph_traverse' },
  { mode: 'Continuity', question: '"How did this evolve?"', tool: 'velixar_timeline' },
  { mode: 'Conflict', question: '"Something contradicts"', tool: 'velixar_contradictions' },
  { mode: 'Consolidation', question: '"Preserve what matters"', tool: 'velixar_distill' },
  { mode: 'Verification', question: '"Is my context complete?"', tool: 'velixar_coverage_check' },
  { mode: 'Construction', question: '"Assemble what I need to answer"', tool: 'velixar_prepare_context' },
  { mode: 'Personalization', question: '"What do I know about this user?"', tool: 'velixar_identity' },
  { mode: 'Inference', question: '"What patterns hold across these memories?"', tool: 'velixar_patterns' },
  { mode: 'Stewardship', question: '"Will future sessions need this work?"', tool: 'velixar_store' },
] as const;

export function renderModesTable(): string {
  const rows = COGNITIVE_MODES.map(m => `| ${m.mode} | ${m.question} | ${m.tool} |`).join('\n');
  return `| Mode | Question | First Tool |\n|------|----------|------------|\n${rows}`;
}

// ── Group 1: Orientation ──

const cognitive_constitution: WorkflowPrompt = {
  name: 'cognitive_constitution',
  description: 'Core behavioral rules, cognitive modes, anti-patterns, error handling, and justification policy. Read this first.',
  version: '1.2.0',
  arguments: [],
  messages: [{
    role: 'user',
    content: `Apply the Velixar Cognitive Constitution for this session.

## Core Principle
Prefer the smallest tool that answers the current cognitive question.

## Cognitive Modes
${renderModesTable()}

## Master Pattern: Orient Then Narrow
1. Start with velixar_context for broad orientation
2. Identify the cognitive mode from the user's question
3. Narrow with the specialized tool for that mode
4. Stop when the question is answered — do not chain unnecessarily

## Two-Tool Path for Complex Synthesis
For complex questions requiring comprehensive, verified context:
1. velixar_context — orient (what exists?)
2. velixar_prepare_context — assemble verified context with gap declaration
This handles multi-angle search, coverage verification, and temporal analysis internally.
Use velixar_search for simple factual lookups — do not over-engineer simple questions.

## Search Capabilities (KG-Merged)
Search results are automatically enhanced by the knowledge graph:
- Recency-weighted scoring: recent memories rank higher (recency * 0.3 in KG weight)
- Graph-boosted retrieval: 2-hop traversal from top vector hits injects related memories
- Chain neighbors: temporal chain links are included in results
- Access count feedback: frequently-recalled memories surface more over time
- You do NOT need to manually traverse the graph after searching — it's built in

## Batch Operations
When multiple independent searches or stores are needed, prefer batch tools:
- velixar_multi_search with merge:false: run up to 5 queries in one call (replaces batch_search)
- velixar_batch_store: store up to 20 memories in one call

## Error Handling
If a tool returns an error or empty result:
- Do NOT retry the same call with the same parameters
- Report what you know and what failed
- Suggest an alternative approach if one exists
- Never fabricate data to fill gaps from failed calls

## Anti-Patterns
- Never dump raw memory lists without synthesis
- Never present inferred content as retrieved fact
- Never ignore contradictions — surface them explicitly
- Never leak data across workspaces

## Justification Rules
- Retrieved facts: assert confidently
- Inferred/synthesized claims: qualify with confidence
- Speculative claims: present as exploratory or do not assert
- Contradictions reduce confidence regardless of evidence strength`,
  }],
};

const recall_prior_reasoning: WorkflowPrompt = {
  name: 'recall_prior_reasoning',
  description: 'Recall and reconstruct prior reasoning about a topic. Use when resuming work or verifying past decisions.',
  version: '1.1.0',
  arguments: [{ name: 'topic', description: 'Topic or decision to recall reasoning for', required: true }],
  messages: [{
    role: 'user',
    content: `Recall prior reasoning about: {{topic}}

Stop conditions (check BEFORE each step):
- If you already have a clear picture of the reasoning, stop and synthesize.
- If the topic has no stored memories, say so — do not speculate.

Suggested approach (use at most 3 tool calls):
1. Start with velixar_context(topic="{{topic}}") for broad orientation.
2. If the context is insufficient, try velixar_search for specific memories.
3. If temporal evolution matters, try velixar_timeline(topic="{{topic}}").

Rules:
- Synthesize a coherent narrative, not a raw memory dump
- Cite specific memories by ID when making claims
- Flag any contradictions or uncertainty

Output: Brief form (summary, relevant facts, open issues, confidence)`,
  }],
};

const build_project_context: WorkflowPrompt = {
  name: 'build_project_context',
  description: 'Build comprehensive context for a project or workspace. Use when starting work on a project.',
  version: '1.1.0',
  arguments: [{ name: 'project', description: 'Project name or topic', required: false }],
  messages: [{
    role: 'user',
    content: `Build project context for: {{project}}.

Stop conditions (check BEFORE each step):
- If velixar_context gives a clear workspace picture, stop there.
- If you have enough to start working, stop — don't exhaustively map everything.

Suggested approach (use at most 4 tool calls):
1. Start with velixar_context for workspace overview.
2. If key entities are identified, try velixar_graph_traverse on the most important one.
3. If recurring patterns would help, try velixar_patterns.
4. If user preferences matter for this project, try velixar_identity.

Rules:
- Prioritize actionable context over exhaustive history
- Highlight active contradictions and knowledge gaps
- Include entity relationships that inform current work

Output: Brief form (summary, relevant facts, open issues, confidence)`,
  }],
};

const profile_entity: WorkflowPrompt = {
  name: 'profile_entity',
  description: 'Build a comprehensive profile of a specific entity (person, technology, concept).',
  version: '1.0.0',
  arguments: [{ name: 'entity', description: 'Entity to profile', required: true }],
  messages: [{
    role: 'user',
    content: `Profile entity: {{entity}}

Stop conditions (check BEFORE each step):
- If graph traversal gives a complete picture, stop there.
- If the entity is sparse (few connections), say so rather than over-fetching.

Suggested approach (use at most 3 tool calls):
1. Start with velixar_graph_traverse(entity="{{entity}}") to find connections.
2. If more context is needed, try velixar_search for memories mentioning this entity.
3. If temporal evolution matters, try velixar_timeline(topic="{{entity}}").

Rules:
- Build a structured profile: what it is, how it connects, how it changed
- Distinguish facts (from stored memories) from inferences (from patterns)
- Flag if entity data is sparse — suggest what to store

Output: Brief form`,
  }],
};

const orient_then_narrow: WorkflowPrompt = {
  name: 'orient_then_narrow',
  description: 'Master reasoning pattern — broad orientation then targeted narrowing. Use for any task where context is broad or uncertain.',
  version: '1.1.0',
  arguments: [{ name: 'question', description: 'The question or task to address', required: true }],
  messages: [{
    role: 'user',
    content: `Address this using orient-then-narrow: {{question}}

Stop conditions (check BEFORE each step):
- If velixar_context alone answers the question, stop there.
- If one specialized tool answers it, stop — do not chain all of them.

Suggested approach (use at most 2 tool calls):
1. Start with velixar_context to orient broadly.
2. From the context, identify which cognitive mode fits (see the Cognitive Modes table in the cognitive_constitution prompt) and use ONE specialized tool for that mode.

Rules:
- Always start broad, then narrow — never skip orientation
- Pick exactly ONE specialized tool after context
- Respect justification: qualify inferred claims, assert retrieved facts
- Note: velixar_search already includes KG-boosted results (graph neighbors, chain links, recency weighting) — you do NOT need to manually traverse after searching
- If multiple independent lookups are needed, use velixar_multi_search instead of sequential calls

Output: Matches the cognitive mode's output form`,
  }],
};

// ── Group 2: Conflict & Uncertainty ──

const resolve_contradiction: WorkflowPrompt = {
  name: 'resolve_contradiction',
  description: 'Investigate and resolve a contradiction between stored beliefs or facts.',
  version: '1.0.0',
  arguments: [{ name: 'topic', description: 'Topic area of the contradiction', required: false }],
  messages: [{
    role: 'user',
    content: `Resolve contradictions about: {{topic}}.

Stop conditions (check BEFORE each step):
- If contradictions are clear and resolution is obvious, stop after inspecting both sides.
- If no contradictions exist, say so immediately.

Suggested approach (use at most 4 tool calls):
1. Start with velixar_contradictions to surface active conflicts.
2. For each high-severity contradiction, inspect both memory IDs with velixar_inspect.
3. If temporal context would help, try velixar_timeline to trace when beliefs diverged.
4. If this might be a preference shift, try velixar_identity.

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
  version: '1.0.0',
  arguments: [{ name: 'domain', description: 'Domain to check for gaps', required: false }],
  messages: [{
    role: 'user',
    content: `Identify knowledge gaps in: {{domain}}.

Stop conditions (check BEFORE each step):
- If context reveals clear gaps, report them — don't keep searching.
- This is a diagnostic workflow — identify gaps, don't fix them.

Suggested approach (use at most 3 tool calls):
1. Start with velixar_context for current state of knowledge.
2. If entity relationships matter, try velixar_graph_traverse on key entities — look for disconnected or sparse nodes.
3. If conflicts indicate uncertain areas, try velixar_contradictions.

Rules:
- Distinguish "no data" from "low confidence data" from "conflicting data"
- Prioritize gaps that block current work
- Suggest specific memories to store to fill critical gaps

Output: Gap Report form (knowns, unknowns, blockers, next questions)`,
  }],
};

// ── Group 3: Time & Continuity ──

const trace_belief_evolution: WorkflowPrompt = {
  name: 'trace_belief_evolution',
  description: 'Trace how a belief, preference, or understanding changed over time.',
  version: '1.0.0',
  arguments: [{ name: 'belief', description: 'Belief or topic to trace', required: true }],
  messages: [{
    role: 'user',
    content: `Trace the evolution of: {{belief}}

Stop conditions (check BEFORE each step):
- If timeline shows a clear evolution with change points, stop and narrate.
- If data is sparse, say so — don't over-fetch to fill gaps.

Suggested approach (use at most 3 tool calls):
1. Start with velixar_timeline(topic="{{belief}}") for temporal ordering.
2. If more memories are needed, try velixar_search for related content.
3. If conflicts exist at change points, try velixar_contradictions.

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
  version: '1.0.0',
  arguments: [
    { name: 'session_id', description: 'Previous session ID (if known)', required: false },
    { name: 'topic', description: 'Topic to resume', required: false },
  ],
  messages: [{
    role: 'user',
    content: `Resume previous session (session: {{session_id}}) about: {{topic}}.

Stop conditions (check BEFORE each step):
- If session_resume gives a complete picture, stop there — it's designed for this.
- If the user just needs to know where they left off, one call is enough.

Suggested approach (use at most 2 tool calls):
1. Start with velixar_session_resume — it handles chunking and assembly in one call.
2. If you need current workspace state beyond the session, try velixar_context.

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
  version: '1.0.0',
  arguments: [{ name: 'decision', description: 'Decision to reconstruct', required: true }],
  messages: [{
    role: 'user',
    content: `Reconstruct the decision path for: {{decision}}

Stop conditions (check BEFORE each step):
- If timeline shows the decision with clear context, stop and narrate.
- If the decision memory is self-explanatory, one inspect may suffice.

Suggested approach (use at most 3 tool calls):
1. Start with velixar_timeline(topic="{{decision}}") to find the decision point.
2. If the decision memory needs detail, try velixar_inspect on it.
3. If surrounding context is needed, try velixar_search.

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
  version: '1.1.0',
  arguments: [{ name: 'session_summary', description: 'Summary of what happened this session (optional — if omitted, auto-recalls current session)', required: false }],
  messages: [{
    role: 'user',
    content: `Distill this session: {{session_summary}}

Stop conditions (check BEFORE each step):
- If there's only one memory-worthy takeaway, one velixar_distill call is enough.
- If content is transient chatter with nothing durable, say so and stop.

Suggested approach (use at most 4 tool calls):
1. If no session summary was provided, call velixar_session_recall to retrieve the current session content first.
2. Identify memory-worthy content: decisions, preferences, bugs solved, patterns discovered.
3. Call velixar_distill for each distinct takeaway (it handles duplicate detection). For multiple takeaways, use velixar_batch_store if they are independent facts.
4. If tags need refinement, try velixar_retag. If memories overlap, try velixar_consolidate.

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
  version: '1.0.0',
  arguments: [{ name: 'topic', description: 'Topic to consolidate', required: true }],
  messages: [{
    role: 'user',
    content: `Consolidate memories about: {{topic}}

Stop conditions (check BEFORE each step):
- If search finds fewer than 2 memories, consolidation isn't needed — say so.
- If memories don't overlap enough to merge, say so rather than forcing a merge.

Suggested approach (use at most 3 tool calls):
1. Start with velixar_search for all memories about this topic.
2. If candidates are found, call velixar_consolidate with the memory IDs and a synthesized summary.
3. If the consolidated memory needs better tags, try velixar_retag.

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
  version: '1.0.0',
  arguments: [{ name: 'count', description: 'Number of recent memories to review (default 10)', required: false }],
  messages: [{
    role: 'user',
    content: `Review and retag recent memories (up to {{count}} or 10).

Stop conditions (check BEFORE each step):
- If all tags look accurate after listing, say so and stop.
- Only retag memories that actually need it — don't change tags for the sake of it.

Suggested approach (use at most 2 tool calls):
1. Start with velixar_list to get recent memories and review their tags.
2. For memories with missing, wrong, or overly generic tags, call velixar_retag.

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
  version: '1.0.0',
  arguments: [],
  messages: [{
    role: 'user',
    content: `Summarize user identity for this workspace.

Stop conditions (check BEFORE each step):
- If velixar_identity returns a complete profile, stop there.
- If identity is empty, say so and suggest what to store — don't over-fetch.

Suggested approach (use at most 3 tool calls):
1. Start with velixar_identity to get the current profile.
2. If the profile is sparse, try velixar_search for memories tagged with preferences, expertise, or goals.
3. If entity relationships would enrich the profile, try velixar_graph_traverse on identity-related entities.

Rules:
- Distinguish stored facts from inferred patterns
- Flag areas where identity data is sparse or contradictory
- Present as a structured profile, not a memory dump

Output: Brief form`,
  }],
};

const detect_preference_shift: WorkflowPrompt = {
  name: 'detect_preference_shift',
  description: 'Detect if user preferences or beliefs have shifted over time.',
  version: '1.0.0',
  arguments: [{ name: 'area', description: 'Preference area to check (e.g., "coding style", "tools")', required: false }],
  messages: [{
    role: 'user',
    content: `Detect preference shifts in: {{area}}.

Stop conditions (check BEFORE each step):
- If identity shows clear shifts with timestamps, stop and narrate.
- If no shifts are detected, say so — don't search for shifts that aren't there.

Suggested approach (use at most 3 tool calls):
1. Start with velixar_identity to get current profile and any recorded shifts.
2. If temporal context would help, try velixar_timeline with the preference area as topic.
3. If conflicts exist, try velixar_contradictions to find conflicting preference statements.

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
  version: '1.0.0',
  arguments: [],
  messages: [{
    role: 'user',
    content: `Check and align to user communication preferences.

Stop conditions (check BEFORE each step):
- One tool call is enough. Do not chain further.

Suggested approach (1 tool call):
1. Call velixar_identity to get communication_style and preferences.

Rules:
- Apply the user's stated preferences to your response style
- If no preferences are stored, use neutral professional style
- Do not over-personalize — respect stated boundaries

Output: Brief form (just the relevant style preferences)`,
  }],
};

// ── Group 6: Enterprise ──

const org_knowledge_review: WorkflowPrompt = {
  name: 'org_knowledge_review',
  description: 'Review org-level knowledge: cross-workspace patterns, promotion candidates, isolation checks.',
  version: '1.1.0',
  arguments: [{ name: 'focus', description: 'Specific area to review (optional)', required: false }],
  messages: [{
    role: 'user',
    content: `Review org-level knowledge for: {{focus}}.

Stop conditions (check BEFORE each step):
- If context shows clear org state, stop and summarize.
- If no org-level memories exist, say so and suggest candidates for promotion.

Suggested approach (use at most 3 tool calls):
1. Start with velixar_context to get workspace overview including org-tier memories.
2. If cross-workspace patterns matter, try velixar_patterns(topic="org knowledge").
3. If contradictions exist between workspace and org knowledge, try velixar_contradictions.

Rules:
- Distinguish workspace-local knowledge from org-level knowledge
- Identify memories that should be promoted from workspace → org (Tier 2 → Tier 3)
- Flag any workspace isolation violations
- Suggest consolidation of duplicate knowledge across workspaces

Output: Gap Report form (org knowns, workspace-only knowns, promotion candidates, isolation issues)`,
  }],
};

const evaluate_product_fit: WorkflowPrompt = {
  name: 'evaluate_product_fit',
  description: 'Evaluate whether a domain/company is a good fit for a product or service. Synthesizes knowledge graph data about the domain.',
  version: '1.1.0',
  arguments: [
    { name: 'domain', description: 'Company domain or name to evaluate', required: true },
    { name: 'product', description: 'Product or service to evaluate fit for', required: false },
  ],
  messages: [{
    role: 'user',
    content: `Evaluate product fit for: {{domain}} (product: {{product}})

Stop conditions (check BEFORE each step):
- If search and graph give enough signal, stop and evaluate — don't exhaust all tools.
- If no data exists about this domain, say so and suggest what to gather.

Suggested approach (use at most 4 tool calls):
1. Start with velixar_search for any existing memories about {{domain}}.
2. If entities exist, try velixar_graph_traverse(entity="{{domain}}") for relationships.
3. If broader context would help, try velixar_context(topic="{{domain}} evaluation").
4. If adoption patterns are relevant, try velixar_patterns(topic="enterprise adoption").

Evaluate:
- Team size signals (mentions of teams, departments, org structure)
- Technical maturity (CI/CD, tooling, LLM integration mentions)
- Pain points the product solves
- Engagement signals (API usage frequency, memory volume, feature requests)

Output form:
- fit_score: 1-10
- signals: list of positive/negative indicators
- recommended_tier: free | pro | teams | enterprise
- next_action: suggested outreach or nurture step
- gaps: what information is missing to make a confident assessment`,
  }],
};

// ── Group 7: Stewardship ──
// The "recall first, store after, verify the store" discipline contract.
// Spec: RECALL-FIRST-MODE-TASKS.md (incl. 7-Whys forward analysis R1-R7).

const recall_first: WorkflowPrompt = {
  name: 'recall_first',
  description: 'Stewardship workflow. Use BEFORE finalizing any non-trivial code change, decision, or design that future sessions will need. Enforces a recall → act → persist → verify loop.',
  version: '1.0.0',
  arguments: [
    { name: 'intent', description: 'One-line description of what you are about to do.', required: true },
  ],
  messages: [{
    role: 'user',
    content: `You are operating in Stewardship mode for this task.

Intent: {{intent}}

This is the recall_first contract. Honor all four phases in order. None are optional.

## Phase 1 — RECALL (before acting)

Query velixar memory for any prior decision, hardening row, incident, or constraint that bears on this work.

- Use velixar_context for broad orientation, or velixar_search for a specific topic.
- Run multiple narrow queries SEQUENTIALLY, not in parallel — parallel batched queries can trip auth-failure rate limits and produce silent partial failures.
- Capture the substance of what you found.

## Phase 2 — ACT (perform the change)

Do the work: write code, propose the design, update infra. Local-only; nothing committed yet.

- Required: explicitly cite at least one recalled fact from Phase 1, OR explicitly state "no prior context found relevant to this change" if your recall returned nothing material.
- This requirement exists because recall without engagement is theater. The point of recall is to surface conflicts before acting; if the LLM dismisses what it found, the contract failed.

## Phase 3 — PERSIST (substantive store)

Store a substantive summary of the change to velixar memory.

- Use velixar_store SEQUENTIALLY (not parallel). Batched parallel stores have a documented partial-success failure mode where only the first call lands.
- Tag the memory with the work's domain (e.g. session-YYYY-MM-DD plus topic plus layer-or-component).
- Reference the recalled context from Phase 1 in the stored summary so future sessions can audit the lineage.

## Phase 4 — VERIFY (read back)

Confirm the store actually persisted. Do not trust the store-tool's success response alone — past incidents include WAF rejections silently dropping stores while the response said 200.

- Verify via velixar_search for a distinctive 3+ word phrase from the stored content (vector-search hot path, synchronous), OR via velixar_inspect by ID (direct lookup, definitely synchronous).
- Do NOT verify via KG or entity lookups — those are async-indexed and will false-fail at T+0s.
- If verification returns no hits, retry once with a 2-second backoff. If still empty, treat it as a real persistence failure: re-store, log to local auto-memory, and surface the incident before continuing.

## When to use this workflow

USE WHEN:
- Non-trivial code change (multi-file edit, security-touching, infra-touching, deploy-affecting)
- Architectural decision or design doc
- Incident response, hardening work, post-migration follow-up
- Anything the user describes with words like "remember this for next time" or "future sessions"

DO NOT USE WHEN:
- Trivial lookups (grep, ls, single-file reads)
- Conversational turns without code or design output
- Pure read-only commands
- One-shot ad-hoc explanations

## Stop conditions

- Phase 1 returns nothing relevant → state that explicitly in Phase 2; do not skip the citation step.
- Phase 4 fails twice → STOP. Surface the persistence failure to the user. Do not silently proceed.
- The work outgrows a single store (multi-day project) → use recall_first per logical unit of progress; aggregate stores at session-end via distill_session.

References:
- velixar-mcp-server/RECALL-FIRST-MODE-TASKS.md (spec + 7-Whys forward analysis)
- Cognitive constitution at velixar://constitution`,
  }],
};

// ── Export ──

export const allPrompts: WorkflowPrompt[] = [
  // Group 0: Foundation
  cognitive_constitution,
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
  // Group 6: Enterprise
  org_knowledge_review,
  evaluate_product_fit,
  // Group 7: Stewardship
  recall_first,
];

export function getPromptList() {
  return {
    prompts: allPrompts.map(p => ({
      name: p.name,
      description: p.description,
      version: p.version,
      arguments: p.arguments,
    })),
  };
}

export function getPrompt(name: string, promptArgs: Record<string, string> = {}) {
  const prompt = allPrompts.find(p => p.name === name);
  if (!prompt) throw new Error(`Unknown prompt: ${name}`);

  const messages = prompt.messages.map(m => {
    let content = m.content;
    // Replace provided args
    for (const [key, value] of Object.entries(promptArgs)) {
      content = content.replaceAll(`{{${key}}}`, value);
    }
    // Strip unresolved optional placeholders: "{{key}}" → "" and clean up dangling labels
    const optionalNames = (prompt.arguments || []).filter(a => !a.required).map(a => a.name);
    for (const opt of optionalNames) {
      if (content.includes(`{{${opt}}}`)) {
        // Remove lines that are ONLY the placeholder with a label prefix (e.g., " about: {{topic}}")
        content = content.replace(new RegExp(`\\s*(?:about|for|in|session):\\s*\\{\\{${opt}\\}\\}`, 'g'), '');
        content = content.replace(new RegExp(`\\s*\\(session:\\s*\\{\\{${opt}\\}\\}\\)`, 'g'), '');
        content = content.replaceAll(`{{${opt}}}`, '');
      }
    }
    return { role: m.role as 'user' | 'assistant', content: { type: 'text' as const, text: content.trim() } };
  });

  return { description: prompt.description, messages };
}
