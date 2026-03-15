# Velixar MCP Server — Tool Disambiguation Matrix

> Required by `~/MCP-SERVER-STRATEGY.md` §Tool Disambiguation Matrix
> Every tool must fill this table before implementation begins.

---

## CRUD Tools

### `velixar_store`

| Field | Value |
|-------|-------|
| Cognitive purpose | Persist a new durable memory |
| Use when | A fact, decision, preference, or insight is worth remembering across sessions |
| Do NOT use when | Content is transient conversation filler; use `velixar_distill` for session extraction |
| Inputs | `content` (required), `tags`, `tier` (0=pinned, 1=session, 2=semantic, 3=org) |
| Output shape | `{ id, stored }` → normalized to `VelixarResponse<{ id: string }>` |
| Follow-up tools | `velixar_search` (verify), `velixar_inspect` (review) |
| Failure semantics | `backend_error` on API failure; no partial state |
| Closest neighbor | `velixar_distill` |
| Why it still exists | Store is explicit single-memory write; distill is batch extraction from session content |

### `velixar_search`

| Field | Value |
|-------|-------|
| Cognitive purpose | Find memories relevant to a known topic or query |
| Use when | You know what you're looking for — a specific fact, decision, or preference |
| Do NOT use when | Broad orientation (use `velixar_context`); finding contradictions (use `velixar_contradictions`) |
| Inputs | `query` (required), `limit` |
| Output shape | `{ memories[], count }` → normalized to `VelixarResponse<{ items: MemoryItem[], count }>` |
| Follow-up tools | `velixar_inspect` (deep dive), `velixar_timeline` (evolution) |
| Failure semantics | `no_data` if zero results; `backend_error` on API failure (503, no silent fallback) |
| Closest neighbor | `velixar_context` |
| Why it still exists | Search is targeted retrieval by query; context is synthesized orientation brief |

### `velixar_list`

| Field | Value |
|-------|-------|
| Cognitive purpose | Browse recent memories chronologically |
| Use when | Need to see what's been stored, find IDs for update/delete, or paginate through history |
| Do NOT use when | Looking for specific content (use `velixar_search`); need synthesized overview (use `velixar_context`) |
| Inputs | `limit`, `cursor` |
| Output shape | `{ memories[], count, cursor }` → normalized to `VelixarResponse<{ items: MemoryItem[], count, cursor? }>` |
| Follow-up tools | `velixar_update`, `velixar_delete`, `velixar_inspect` |
| Failure semantics | `no_data` if empty; `backend_error` on API failure |
| Closest neighbor | `velixar_search` |
| Why it still exists | List is chronological browse; search is semantic relevance ranking |

### `velixar_update`

| Field | Value |
|-------|-------|
| Cognitive purpose | Modify an existing memory's content or tags |
| Use when | A memory needs correction, refinement, or retagging |
| Do NOT use when | Creating new memories (use `velixar_store`); merging duplicates (use `velixar_distill`) |
| Inputs | `id` (required), `content`, `tags` |
| Output shape | `{ updated }` → normalized to `VelixarResponse<{ id: string }>` |
| Follow-up tools | `velixar_inspect` (verify) |
| Failure semantics | `backend_error` on API failure; 404 if ID not found |
| Closest neighbor | `velixar_store` |
| Why it still exists | Update modifies in-place preserving ID and provenance; store creates new |

### `velixar_delete`

| Field | Value |
|-------|-------|
| Cognitive purpose | Remove a memory permanently |
| Use when | Memory is wrong, outdated, or explicitly requested for removal |
| Do NOT use when | Memory just needs correction (use `velixar_update`) |
| Inputs | `id` (required) |
| Output shape | `{ deleted }` → normalized to `VelixarResponse<{ id: string }>` |
| Follow-up tools | None |
| Failure semantics | `backend_error` on API failure; 404 if ID not found |
| Closest neighbor | `velixar_update` |
| Why it still exists | Delete is permanent removal; update preserves the memory |

---

## Flagship Cognitive Tools

### `velixar_context`

| Field | Value |
|-------|-------|
| Cognitive purpose | Synthesize the best working brief for current workspace |
| Use when | Broad orientation needed — starting a task, resuming work, unclear what's relevant |
| Do NOT use when | You know the exact entity to inspect; you have a specific search query |
| Inputs | `topic` (optional), `compact` (boolean, default true) |
| Output shape | Brief form → `VelixarResponse<{ summary, relevant_facts[], open_issues[], confidence, contradiction_flags[], pattern_hints[] }>` |
| Follow-up tools | `velixar_search` (narrow), `velixar_inspect` (deep dive), `velixar_graph_traverse` (relationships) |
| Failure semantics | `no_data` if workspace empty; `partial` if some tiers unavailable; `backend_error` on failure |
| Closest neighbor | `velixar_search` |
| Why it still exists | Context synthesizes across tiers into a brief; search returns raw ranked results for a specific query |

### `velixar_identity`

| Field | Value |
|-------|-------|
| Cognitive purpose | User profile — preferences, expertise, communication style, goals, constraints |
| Use when | Need to understand who the user is, personalize responses, or check stable preferences |
| Do NOT use when | Looking for project facts (use `velixar_search`); broad orientation (use `velixar_context`) |
| Inputs | `action` ('get' | 'update'), `fields` (for update) |
| Output shape | `VelixarResponse<IdentityProfile>` |
| Follow-up tools | `velixar_context` (apply identity to task), `velixar_contradictions` (identity conflicts) |
| Failure semantics | `no_data` if no identity stored; `backend_error` on failure |
| Closest neighbor | `velixar_context` |
| Why it still exists | Identity is stable user-level profile; context is workspace-level task brief |

### `velixar_graph_traverse`

| Field | Value |
|-------|-------|
| Cognitive purpose | Walk relationships from an entity — "what connects to X?" |
| Use when | Question is about relationships, dependencies, or connections from a known focal entity |
| Do NOT use when | Broad topic briefing with no focal entity (use `velixar_context`); searching by content (use `velixar_search`) |
| Inputs | `entity` (required), `depth` (default 1), `direction` ('outbound' | 'inbound' | 'both') |
| Output shape | `VelixarResponse<GraphTraversalResult>` |
| Follow-up tools | `velixar_inspect` (examine connected entity), `velixar_timeline` (entity evolution) |
| Failure semantics | `no_data` if entity not found; `partial` if graph incomplete; `backend_error` on failure |
| Closest neighbor | `velixar_search` |
| Why it still exists | Graph traverse follows structural relationships; search finds content by semantic similarity |

### `velixar_contradictions`

| Field | Value |
|-------|-------|
| Cognitive purpose | Surface conflicting beliefs, preferences, or facts |
| Use when | Conflict suspected, flagged by another tool, or proactive consistency check needed |
| Do NOT use when | Ordinary recall with no inconsistency signal; first-pass orientation |
| Inputs | `topic` (optional), `memory_ids` (optional — check specific memories) |
| Output shape | Resolution form → `VelixarResponse<{ contradictions: ContradictionResult[], count }>` |
| Follow-up tools | `velixar_inspect` (examine conflicting memories), `velixar_timeline` (when did beliefs diverge) |
| Failure semantics | `no_data` if no contradictions found (this is good); `backend_error` on failure |
| Closest neighbor | `velixar_inspect` |
| Why it still exists | Contradictions surfaces conflicts across memories; inspect shows detail of a single memory |

### `velixar_timeline`

| Field | Value |
|-------|-------|
| Cognitive purpose | Show how a topic, entity, or belief evolved over time |
| Use when | Sequence or historical change matters — "how did X evolve?" |
| Do NOT use when | Broad context with no temporal question; searching for current state only |
| Inputs | `topic` or `memory_id` (one required), `limit` |
| Output shape | Timeline form → `VelixarResponse<{ entries: TimelineEntry[], phases[], current_state, uncertainty }>` |
| Follow-up tools | `velixar_inspect` (examine a specific point), `velixar_contradictions` (belief changes) |
| Failure semantics | `no_data` if no temporal chain; `partial` if chain has gaps; `backend_error` on failure |
| Closest neighbor | `velixar_list` |
| Why it still exists | Timeline follows temporal chains with change-point analysis; list is flat chronological browse |

### `velixar_distill`

| Field | Value |
|-------|-------|
| Cognitive purpose | Extract durable memories from session content |
| Use when | Task complete, decision made, bug solved, preference clarified — natural memory-worthy breakpoints |
| Do NOT use when | Continuous storage of transient chatter; single explicit fact (use `velixar_store`) |
| Inputs | `content` (required — session text to distill), `tags` (optional) |
| Output shape | Distillation Set form → `VelixarResponse<DistillationResult>` |
| Follow-up tools | `velixar_inspect` (verify stored memories), `velixar_search` (confirm retrievability) |
| Failure semantics | `partial` if some candidates fail to store; `backend_error` on failure |
| Closest neighbor | `velixar_store` |
| Why it still exists | Distill is batch extraction with dedup/contradiction detection; store is explicit single write |

### `velixar_inspect`

| Field | Value |
|-------|-------|
| Cognitive purpose | Deep inspection of a specific memory — raw content, provenance, relations, justification chain |
| Use when | Need to explain or debug a specific recall; verify a memory's source and confidence |
| Do NOT use when | Broad search or orientation; finding memories (use `velixar_search` first) |
| Inputs | `memory_id` (required) |
| Output shape | `VelixarResponse<{ memory: MemoryItem, relations[], chain_links[], justification: JustificationResult }>` |
| Follow-up tools | `velixar_timeline` (temporal context), `velixar_contradictions` (conflicts), `velixar_update` (fix) |
| Failure semantics | `no_data` if ID not found; `backend_error` on failure |
| Closest neighbor | `velixar_search` |
| Why it still exists | Inspect is deep single-memory analysis with provenance; search is multi-result retrieval |

### `velixar_patterns`

| Field | Value |
|-------|-------|
| Cognitive purpose | Surface recurring problem/solution motifs from memory |
| Use when | Current problem may match prior patterns; looking for repeated behaviors or solutions |
| Do NOT use when | First-pass orientation (use `velixar_context`); specific fact lookup (use `velixar_search`) |
| Inputs | `topic` (optional), `limit` |
| Output shape | `VelixarResponse<{ patterns: PatternResult[], count }>` |
| Follow-up tools | `velixar_inspect` (examine supporting memories), `velixar_search` (find related) |
| Failure semantics | `no_data` if no patterns detected; `low_confidence` if patterns are weak; `backend_error` on failure |
| Closest neighbor | `velixar_context` |
| Why it still exists | Patterns surfaces repeated motifs requiring multiple observations; context is one-shot orientation |
