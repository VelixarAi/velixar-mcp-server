# Multi-Position Vector Retrieval — Task Specification

> **Goal:** Enable LLMs to traverse vector DBs from multiple positions with temporal chain awareness, eliminating hallucination during context construction.
>
> **Created:** 2026-03-31
> **Status:** Planning
> **Depends on:** velixar-mcp-server v1.1.0 (batch_search fix landed)

---

## Problem Statement

Current retrieval is single-shot: one query → one embedding → one cosine-ranked list. This causes three failure modes:

1. **Vocabulary mismatch** — "outreach plan status" misses memories stored as "Composio partnership" or "Month 2 demo targets"
2. **No coverage signal** — LLM gets 5 results with no way to know if 30 more exist, fills gaps with hallucination
3. **Temporal conflation** — March 22 draft plan and March 27 final plan merge as equals; superseded beliefs contaminate current state

---

## 7 Whys Hardening Protocol

Each build is stress-tested with 7 levels of "why" to expose hidden assumptions, failure modes, and integration risks before a line of code is written.

### Build #8: `temporal_merge.ts` — Shared Temporal Logic

| Why | Question | Answer | Hardening Action |
|-----|----------|--------|------------------|
| 1 | Why do we need a shared module? | Multi-search, neighborhood, coverage, and context upgrade all need chain detection + temporal decay. Duplicating = drift. | Single module, re-exported. All 4 consumers import from here. |
| 2 | Why detect chains from `previous_memory_id` instead of timestamps alone? | Timestamps show *when*, chains show *what replaced what*. Two memories 5 days apart on different topics aren't supersession. | Chain detection uses `previous_memory_id` / `derived_from`. Timestamp decay is a separate, additive signal. |
| 3 | Why use exponential decay instead of a hard cutoff? | Hard cutoffs create cliff edges — a 15-day-old memory isn't categorically different from a 14-day-old one. Exponential is smooth. | Decay formula: `exp(-0.02 * days)`. Configurable decay rate constant. |
| 4 | Why demote superseded memories to 0.3× instead of removing them? | Removal destroys provenance. LLM may need historical context ("what changed?"). Demotion keeps them visible but clearly secondary. | Superseded memories get `_superseded: true`, `_superseded_by: <id>`, relevance × 0.3. |
| 5 | Why not let the LLM figure out temporal ordering itself? | LLMs are unreliable at comparing ISO timestamps under token pressure. They hallucinate recency. The tool must do this work. | Response explicitly groups `current` vs `superseded`. LLM never has to compare dates. |
| 6 | Why not just use the contradictions system for this? | Contradictions detect *conflicting beliefs*. Supersession is *updated beliefs* — not a conflict, an evolution. Different semantics. | Supersession is temporal (chain-linked updates). Contradictions are semantic (incompatible claims). Both signals surfaced independently. |
| 7 | What if `previous_memory_id` chains are broken or missing? | Older memories pre-date chain tracking. Fallback: if two memories on the same topic are >7 days apart, flag as "possible supersession" with lower confidence. | Two-tier detection: explicit chains (high confidence) + timestamp heuristic (low confidence, flagged as inferred). |

### Build #9: `validate_multi_search.ts` — Response Validators

| Why | Question | Answer | Hardening Action |
|-----|----------|--------|------------------|
| 1 | Why new validators instead of reusing `validateSearchResponse`? | Multi-search returns `{ results: [{ query, memories }] }` — different shape than single search `{ memories }`. | New `validateMultiSearchResponse` and `validateCoverageResponse`. Follow existing validator patterns exactly. |
| 2 | Why not just use `as unknown` and safe extraction like we did in the bug fixes? | That was a fix for existing code. New code should be built right from the start — typed validators catch schema drift at runtime. | Every new endpoint gets a dedicated validator. No `as any`, no raw type assertions on API responses. |
| 3 | Why validate per-query results inside multi-search? | One query might succeed while another hits a backend error. Partial results are better than total failure. | Per-query try/catch inside the validator. Failed queries return `{ query, memories: [], error }`. |
| 4 | Why not validate on the backend and trust the response? | We just fixed 15 bugs caused by trusting backend response shapes. The MCP layer must validate independently. | Validators are the contract boundary. Backend can change shape; validators catch it before it becomes silent data loss. |
| 5 | What if the backend adds new fields we don't expect? | Validators should be additive — unknown fields are ignored, not rejected. Only missing required fields cause errors. | Validators extract known fields, pass through unknown ones. No strict-mode rejection of extra properties. |
| 6 | What if the coverage endpoint doesn't exist yet? | Build #3 (backend) may not be ready when MCP tools are built. Tools must degrade gracefully. | Coverage check falls back to client-side approximation: broad search + set difference against provided IDs. |
| 7 | How do we prevent validator drift from the actual backend schema? | Same way we prevent it now — the `check-schema-contracts.ts` script. | Add new endpoints to schema contract checks. CI fails if validator shape diverges from backend OpenAPI spec. |

### Build #4: `velixar_multi_search` — Fan-Out Search Tool

| Why | Question | Answer | Hardening Action |
|-----|----------|--------|------------------|
| 1 | Why not just tell the LLM to call `velixar_search` multiple times? | Token cost. 5 sequential search calls = 5 round trips, 5 response parses, 5× context window usage. One multi-search = 1 round trip, deduplicated results. | Single tool call, parallel backend queries, merged + deduplicated response. |
| 2 | Why offer 3 merge strategies (union/intersection/weighted)? | Different use cases. Exploration = union (cast wide net). Confirmation = intersection (only high-confidence multi-angle hits). Default = weighted (balanced). | Default is `weighted`. LLM picks strategy based on intent. Description explains when to use each. |
| 3 | Why cap at 5 queries instead of 10 like batch_search? | Multi-search does dedup + merge + temporal analysis per result. 10 queries × 10 results = 100 memories to process. 5 × 10 = 50 is the sweet spot for latency. | Hard cap at 5 queries. If LLM needs more angles, it calls the tool twice. |
| 4 | Why boost score by `1 + 0.2 * (hitCount - 1)` specifically? | A memory matching 3 of 5 queries is more likely relevant than one matching 1 of 5. But the boost must be gentle — a perfect single-query match shouldn't lose to a mediocre multi-match. | 0.2 per additional hit. A 3-hit memory at 0.8 base scores 0.96. A 1-hit at 0.95 stays at 0.95. Tunable constant. |
| 5 | What if all 5 queries return the same top-3 memories? | That's a signal — the topic is narrow and well-covered. The response should say so. | Response includes `diversity_score`: ratio of unique memories to total slots. Low diversity = "topic is well-covered from all angles." |
| 6 | What if the LLM generates bad sub-queries that dilute results? | Garbage queries return low-relevance results that get naturally suppressed in weighted merge. But intersection mode would return nothing. | Weighted mode is default precisely because it's robust to 1-2 bad queries. Intersection requires explicit opt-in. |
| 7 | How does this interact with the existing KG-merged search described in the constitution? | The backend already does 2-hop KG traversal on each search. Multi-search amplifies this — 5 queries × 2-hop each = broader KG coverage automatically. | No special KG handling needed in multi-search. The backend's existing KG merge applies per-query. Document this in the tool description so LLMs don't redundantly call graph_traverse after multi-search. |

### Build #5: `velixar_search_neighborhood` — Vector Space Exploration

| Why | Question | Answer | Hardening Action |
|-----|----------|--------|------------------|
| 1 | Why search by vector instead of generating a new text query? | Text queries go through embedding, which is a lossy transformation. Searching from the anchor's actual vector finds the true geometric neighbors — no vocabulary mismatch. | Backend endpoint accepts `memory_id`, fetches its stored embedding, searches with it directly. |
| 2 | Why classify results as forward/backward/lateral? | Without classification, the LLM sees a flat list and can't distinguish "this updates the anchor" from "this is historical context" from "this is a related but independent topic." | Classification uses chain links (forward/backward) and absence of chain link (lateral). Explicit in response. |
| 3 | Why allow `exclude_ids`? | After multi-search returns 10 results, neighborhood exploration from one of them would re-return the other 9. Exclude list prevents redundancy. | `exclude_ids` parameter filters before returning. Excluded memories still count toward the search limit internally (so we don't just shift the window). |
| 4 | What if the anchor memory's embedding was never stored? | Older memories or imported memories might lack embeddings. | Fallback: embed the anchor's text content on-the-fly and search with that. Flag in response: `anchor_embedding: 'stored' | 'generated'`. |
| 5 | What does "radius" mean in cosine space? | Cosine similarity ranges 0-1. Radius 0.3 means "return memories with similarity ≥ 0.7 to the anchor." But this is unintuitive. | Rename to `similarity_threshold` internally. Keep `radius` in the API for simplicity but document: "0.1 = very tight cluster, 0.5 = broad exploration." |
| 6 | What if the neighborhood is empty? | The anchor memory is isolated — no semantically similar memories exist. This is useful information. | Return `{ neighbors: [], isolation_signal: true, suggestion: 'This memory has no close neighbors. It may cover a unique topic.' }` |
| 7 | How does this chain with multi-search and coverage? | Typical flow: multi-search → find interesting cluster → neighborhood on a cluster member → coverage check on all gathered IDs. | Document the chaining pattern in the tool description and in the `orient_then_narrow` prompt. |

### Build #6: `velixar_coverage_check` — Anti-Hallucination Guardrail

| Why | Question | Answer | Hardening Action |
|-----|----------|--------|------------------|
| 1 | Why does the LLM need a coverage signal at all? | Without it, the LLM has no way to distinguish "I found everything" from "I found 20% of what exists." It fills the 80% gap with hallucination. | Coverage ratio is the primary output. LLM sees `0.4` and knows to keep searching or explicitly flag gaps. |
| 2 | Why not just return total memory count and let the LLM infer coverage? | Total count includes irrelevant memories. "You have 500 memories and retrieved 5" is meaningless. Coverage must be *topic-scoped*. | Backend does a broad search for the topic, counts relevant results, compares against provided IDs. |
| 3 | Why include `suggested_queries` in the response? | If coverage is low, the LLM needs actionable next steps, not just a number. Suggested queries come from uncovered memories' content — they're grounded, not hallucinated. | Extract key terms from uncovered memories, deduplicate against original queries, return as suggestions. |
| 4 | Why check KG entities separately from vector coverage? | Vector search finds semantically similar text. KG entities represent structured relationships. A topic might have full text coverage but miss a key entity relationship. | Cross-reference topic's KG neighbors against entities mentioned in retrieved memories. Uncovered entities = structural gaps. |
| 5 | What if the coverage check itself is expensive? | Broad search + KG traversal + set operations. Could be 500ms+. | Cache the broad search result for 60s (same as existing cache TTL). Second coverage check on same topic is near-instant. |
| 6 | What if coverage is 1.0 but the memories are all outdated? | 100% coverage of stale data is worse than 50% coverage of fresh data. | `temporal_health` section in response: median age, staleness warning, evolution detection. Coverage ratio alone is insufficient — temporal health is the second axis. |
| 7 | Can the LLM game this by passing all memory IDs? | Yes — if it passes every ID from a broad search, coverage will be 1.0 trivially. But that defeats the purpose. | The tool checks IDs against the *topic-scoped* search, not all memories. Passing unrelated IDs doesn't inflate coverage. Document intended usage: "pass only IDs you've actually read and plan to use in your response." |

### Build #7: `velixar_context` Upgrade — Triangulated Retrieval

| Why | Question | Answer | Hardening Action |
|-----|----------|--------|------------------|
| 1 | Why upgrade context instead of just adding new tools? | `velixar_context` is the entry point — the constitution says "start here." If it returns incomplete context, the LLM starts from a bad foundation and every subsequent tool call is compensating. | Context becomes the first consumer of multi-search + temporal merge. Better foundation = fewer follow-up calls. |
| 2 | Why 3 angles (direct, decisions, problems) specifically? | These cover the three things an LLM needs to orient: what exists (direct), what was decided (decisions), and what's broken (problems). Covers ~80% of orientation needs. | Angles are configurable but default to these 3. Topic-less context uses: recent context, open decisions, unresolved issues. |
| 3 | Why not just call multi_search internally? | We should. Context upgrade is a consumer of the multi-search logic, not a reimplementation. | Context calls `handleLifecycleTool('velixar_multi_search', ...)` internally or shares the merge logic via `temporal_merge.ts`. |
| 4 | What if the 3-angle search is slower than the current single search? | Current context does 4 parallel fetches (search, list, overview, contradictions). Adding 2 more search angles adds ~200ms if parallelized. | All 3 angle searches run in parallel via `Promise.allSettled`. Total latency = max(single search) not sum. |
| 5 | Why add coverage metadata to context response? | So the LLM knows whether to dig deeper or trust the brief. Current context gives no completeness signal. | Add `coverage_estimate` to response: `{ ratio, total_relevant, gaps_available }`. LLM can call coverage_check if ratio is low. |
| 6 | What if the user just wants a quick answer and 3-angle search is overkill? | `compact: true` (the default) should stay fast. | Compact mode: 2 angles instead of 3, limit 3 per angle. Full mode: 3 angles, limit 5 per angle. Compact adds ~100ms over current. |
| 7 | How do we avoid breaking existing LLM behavior that depends on current context response shape? | Response shape must be backward compatible. New fields are additive. | Existing fields (`relevant_facts`, `recent_activity`, `open_issues`, etc.) keep their shape. New fields: `temporal_grouping`, `coverage_estimate`, `search_angles_used`. |

---

## Build Sequence

```
Phase 1 — Foundations (no backend dependency)
  #8  temporal_merge.ts        Shared temporal chain + decay logic
  #9  validate_multi_search.ts New response validators

Phase 2 — Backend Endpoints (parallel)
  #1  POST /memory/search_by_vector   Search using stored embedding
  #2  POST /memory/multi_search       Parallel multi-query search
  #3  POST /memory/coverage            Topic-scoped coverage analysis

Phase 3 — MCP Tools (parallel, after Phase 1 + Phase 2)
  #4  velixar_multi_search             Fan-out search + temporal merge
  #5  velixar_search_neighborhood      Vector neighborhood exploration
  #6  velixar_coverage_check           Anti-hallucination guardrail

Phase 4 — Integration
  #7  velixar_context upgrade          Triangulated retrieval
  #10 Matrix, prompts, contracts       Documentation + CI
```

### Dependency Graph

```
#8 temporal_merge ─────┬──→ #4 multi_search ──────┐
                       ├──→ #5 neighborhood ───────┤
                       ├──→ #6 coverage_check ─────┤
                       └──→ #7 context upgrade ────┤
#9 validators ─────────┬──→ #4, #5, #6            │
                       │                           │
#1 search_by_vector ───┴──→ #5                     │
#2 multi_search (BE) ─────→ #4                     ├──→ #10 matrix/prompts
#3 coverage (BE) ─────────→ #6                     │
                                                   │
#7 context upgrade ────────────────────────────────┘
```

### Critical Path

```
#8 + #9 + #1 + #2 + #3  (all parallel)
  → #4 + #5 + #6        (all parallel)
  → #7
  → #10
```

Estimated: 4 sequential phases. Phases 1-2 fully parallelizable.

---

## Release Gate Requirements Per Build

Every build must pass the existing [RELEASE-GATE-CHECKLIST.md](./RELEASE-GATE-CHECKLIST.md) plus:

### Additional Gates for This Project

- [ ] **Temporal correctness**: Superseded memories never appear in `current` group
- [ ] **Chain integrity**: Broken chains detected and flagged, not silently ignored
- [ ] **Coverage accuracy**: Coverage ratio matches manual count on test fixtures
- [ ] **No hallucination regression**: Benchmark messy-fixture.json recall@5 ≥ baseline
- [ ] **Latency budget**: compact context ≤ 1.5s p95, full context ≤ 3s p95
- [ ] **Backward compatibility**: Existing context response shape unchanged (additive only)

---

## Tool Contracts (New)

### velixar_multi_search

```json
{
  "cognitive_mode": "retrieval",
  "use_when": "single query might miss relevant context, vocabulary mismatch suspected, need comprehensive coverage",
  "do_not_use_when": "simple factual lookup with known terminology",
  "disambiguate_from": ["velixar_search", "velixar_batch_search"],
  "signal_words": ["comprehensive", "all angles", "thorough search", "might be missing"]
}
```

### velixar_search_neighborhood

```json
{
  "cognitive_mode": "retrieval",
  "use_when": "found a relevant memory and want to discover related context nearby in vector space",
  "do_not_use_when": "no anchor memory identified yet",
  "disambiguate_from": ["velixar_search", "velixar_graph_traverse"],
  "signal_words": ["related to this", "nearby", "similar to", "more like this"]
}
```

### velixar_coverage_check

```json
{
  "cognitive_mode": "verification",
  "use_when": "about to synthesize an answer and need to verify completeness",
  "do_not_use_when": "still in early exploration phase",
  "disambiguate_from": ["velixar_search", "velixar_context"],
  "signal_words": ["complete", "missing anything", "coverage", "thorough enough", "before I answer"]
}
```

---

## Cognitive Mode Update

Current modes table gains one entry:

| Mode | Question | First Tool |
|------|----------|------------|
| Orientation | "Understand the situation broadly" | velixar_context |
| Retrieval | "I know what I'm looking for" | velixar_search |
| Deep Retrieval | "I need comprehensive coverage" | velixar_multi_search |
| Structure | "Understand connections" | velixar_graph_traverse |
| Continuity | "How did this evolve?" | velixar_timeline |
| Conflict | "Something contradicts" | velixar_contradictions |
| Consolidation | "Preserve what matters" | velixar_distill |
| **Verification** | **"Is my context complete?"** | **velixar_coverage_check** |

---

## Test Fixtures Required

1. **Temporal chain fixture**: 5 memories forming 2 chains (one 3-link, one 2-link) + 2 unchained. Verify supersession detection, decay scoring, current/superseded grouping.

2. **Multi-angle fixture**: 10 memories about "outreach plan" stored with different vocabulary (partner names, dates, financial terms). Verify that multi-search from 3 angles retrieves ≥8 of 10 while single search retrieves ≤5.

3. **Coverage gap fixture**: 15 memories on a topic, retrieve 6 via search. Verify coverage_check returns ratio ~0.4, identifies the other 9 as gaps, suggests queries that would find them.

4. **Neighborhood fixture**: Cluster of 5 semantically similar memories + 3 outliers. Verify neighborhood from cluster member returns other 4, not the outliers.

5. **Backward compatibility fixture**: Current context response shape captured as snapshot. Verify upgraded context includes all existing fields unchanged.

---

---

## Phase 5 — Context Construction & Injection

### Build #11: `velixar_prepare_context` — Task-Aware Context Assembly

Assembles retrieval results into a token-budgeted, strategy-prioritized context package with explicit gap declaration. This is the capstone — the consumer of every retrieval tool.

**Why it exists:** Hallucination happens at the assembly boundary, not the retrieval boundary. Perfect retrieval + LLM-side assembly = lossy compression, dropped superseded flags, gap-filling with inference. Server-side assembly eliminates this.

**Input:**
- `intent` (string, required) — What the LLM is about to do. Drives section prioritization.
- `token_budget` (number, default 4000) — Max tokens for the context package.
- `strategy` (enum: `task_answer`, `decision_support`, `historical_review`, `exploration`) — Shapes section priority within budget.
- `include_ids` (string[]) — Memory IDs that MUST be included.
- `exclude_ids` (string[]) — Memory IDs to exclude (already in conversation).

**Strategy-driven section priority:**

| Strategy | Section Priority (high → low) |
|----------|-------------------------------|
| `task_answer` | Current state → Decisions → Gaps/unknowns → History |
| `decision_support` | Contradictions → Current state → Alternatives → Precedents |
| `historical_review` | Timeline → Evolution chains → Superseded versions → Current |
| `exploration` | Broad coverage → Related entities → Patterns → Gaps |

**Output:**
- `context_package.sections[]` — Pre-assembled narrative sections with labels, memory_ids (provenance), confidence scores, and truncation flags.
- `retrieval_metadata` — Memories considered/included/excluded, coverage ratio, temporal span, chain count.
- `anti_hallucination` — Explicit gaps, low-confidence sections, active contradictions, and a plain-text instruction: "Do NOT fill gaps listed above with inference."
- `context_id` — Unique ID for use with `refine_context`.

**7 Whys:**

| Why | Question | Answer | Hardening Action |
|-----|----------|--------|------------------|
| 1 | Why not let the LLM assemble context from raw tool results? | Assembly is where hallucination happens. LLMs drop superseded flags, fill gaps with inference, reorder events. | All ordering, truncation, gap declaration, and confidence scoring is server-side. LLM receives pre-assembled sections. |
| 2 | Why a token budget? | Without a budget, the tool returns everything and the LLM silently drops content during generation. | Budget defaults to 4000. Sections prioritized by strategy, truncated from lowest priority up. Truncated sections flagged. |
| 3 | Why strategies instead of letting the LLM decide priority? | The LLM doesn't know what it doesn't know. The tool enforces priority deterministically. | 4 strategies cover ~95% of use cases. LLM picks one word, tool handles the rest. |
| 4 | Why include an `anti_hallucination` section? | Without it, the LLM sees well-structured context and assumes it's complete. | `explicit_gaps` lists what's missing. `instruction` is a plain-text directive. LLM has no excuse to fabricate. |
| 5 | What if the intent is vague? | Vague intent → broad retrieval → lower confidence → more gaps declared. Degrades gracefully. | Default strategy is `exploration` when intent is <20 chars. Confidence thresholds lower, gap tolerance higher. |
| 6 | What if `include_ids` conflicts with `exclude_ids`? | Include wins — explicit inclusion is a stronger signal. | Include list processed first, exclude list applied to remaining candidates only. |
| 7 | Does this replace `velixar_context`? | No. Context = orientation ("what's going on?"). Prepare_context = execution ("give me exactly what I need to answer X"). | Both tools coexist. Constitution updated to reflect two-step flow. |

### Build #12: `velixar_refine_context` — Iterative Context Refinement

Lightweight tool for mid-generation course correction. Expands a section, fills a declared gap, or adds a new topic to an existing context package without full re-retrieval.

**Why it exists:** The first context assembly is a best guess. The LLM may realize mid-answer it needs more on a specific sub-topic. Without this, it restarts the entire retrieval cycle.

**Input:**
- `context_id` (string, required) — ID from `prepare_context` response.
- `action` (enum: `expand_section`, `fill_gap`, `add_topic`, required) — What to do.
- `target` (string, required) — Section label, gap name, or new topic.
- `additional_budget` (number, default 1000) — Extra tokens to allocate.

**Output:**
- Updated section(s) with new content appended.
- Updated `anti_hallucination` — gaps that were filled are removed from the list.
- Updated `retrieval_metadata` — new memories considered/included.
- `refinement_log` — What changed and why.

**7 Whys:**

| Why | Question | Answer | Hardening Action |
|-----|----------|--------|------------------|
| 1 | Why not just call prepare_context again? | Full re-retrieval is expensive (multi-search + coverage + assembly). Refinement is a targeted delta — one search, one section update. | Refinement reuses the cached retrieval state from the original context_id. Only fetches new memories for the target. |
| 2 | Why require a context_id? | Refinement without context is just another search. The ID links to the assembly state — what's already included, what's excluded, what gaps exist. | Context state cached server-side for 10 minutes (keyed by context_id). Expired ID → error with hint to call prepare_context again. |
| 3 | What if `fill_gap` can't find data for the gap? | The gap is real — no data exists. This is useful information. | Response: `{ filled: false, reason: 'no_data', gap_persists: true }`. Gap stays in anti_hallucination list. |
| 4 | What if `expand_section` exceeds the original token budget? | Additional budget is additive. Original 4000 + 1000 refinement = 5000 total. | Track cumulative budget. Warn if total exceeds 8000 (diminishing returns for most LLMs). |
| 5 | What if the LLM calls refine 10 times? | Diminishing returns + latency accumulation. | Max 5 refinements per context_id. After 5, return hint: "Consider calling prepare_context with a more specific intent." |
| 6 | Can `add_topic` introduce contradictions with existing sections? | Yes — new topic might conflict with current state. | Run contradiction check on new memories vs existing context. Flag in response if detected. |
| 7 | What happens to provenance when sections are refined? | Each refinement adds to the provenance chain, not replaces it. | `assembly_decisions` log appended with refinement entries. Full audit trail preserved. |

### Build #13: Context Provenance System

Every `prepare_context` and `refine_context` call produces a provenance record tracing exactly how context was constructed.

**Provenance record:**
```
{
  context_id: 'ctx-abc123',
  created_at: '2026-03-31T...',
  intent: '...',
  strategy: 'task_answer',
  retrieval_steps: [
    { tool: 'multi_search', queries: [...], results: 14 },
    { tool: 'coverage_check', ratio: 0.85, gaps: 2 },
  ],
  assembly_decisions: [
    { action: 'superseded', memory_id: '...', reason: 'replaced by ...' },
    { action: 'truncated', section: 'history', tokens_cut: 800 },
    { action: 'excluded_budget', memory_ids: ['...', '...'] },
  ],
  refinements: [
    { action: 'fill_gap', target: 'Month 3 targets', filled: true, memories_added: 2 },
  ],
}
```

**Why it exists:** Debugging ("why did the LLM miss X?" → check provenance → "excluded for budget") and trust ("how is this answer grounded?" → every section traces to memory IDs through documented assembly chain).

**7 Whys:**

| Why | Question | Answer | Hardening Action |
|-----|----------|--------|------------------|
| 1 | Why not just log this server-side? | Provenance must be accessible to the LLM and the user, not buried in logs. It's part of the response. | Provenance returned in every prepare/refine response. Also stored as a memory tagged `context_provenance` for later audit. |
| 2 | Why track assembly_decisions? | "Memory X was excluded" is the answer to "why did the LLM hallucinate about X?" Without this, debugging is guesswork. | Every exclusion, truncation, and supersession logged with reason. |
| 3 | Why store provenance as a memory? | So future sessions can answer "how did I arrive at that conclusion last time?" | Stored as tier-1 (session) memory. Auto-expires after 7 days unless promoted. |
| 4 | What if provenance records accumulate? | They will — one per prepare_context call. | Tier-1 with TTL. Consolidation can merge them. Tag-based cleanup in quarterly review. |
| 5 | Is provenance included in the token budget? | No — it's metadata, not context content. | Provenance is in `retrieval_metadata`, outside `context_package.sections`. Doesn't consume content budget. |
| 6 | Can provenance leak sensitive info? | It contains memory IDs and query strings. Same sensitivity as search results. | Same security mode applies. Strict mode redacts query strings in provenance. |
| 7 | Does the LLM need to read provenance? | Usually no — it's for debugging and audit. But the LLM CAN read it to explain its reasoning. | Provenance is always returned but the constitution doesn't instruct the LLM to cite it unless asked. |

---

## Updated Build Sequence

```
Phase 1 — Foundations (no backend dependency)
  #8  temporal_merge.ts            Shared temporal chain + decay logic
  #9  validate_multi_search.ts     New response validators

Phase 2 — Backend Endpoints (parallel)
  #1  POST /memory/search_by_vector    Search using stored embedding
  #2  POST /memory/multi_search        Parallel multi-query search
  #3  POST /memory/coverage            Topic-scoped coverage analysis

Phase 3 — MCP Retrieval Tools (parallel, after Phase 1 + 2)
  #4  velixar_multi_search             Fan-out search + temporal merge
  #5  velixar_search_neighborhood      Vector neighborhood exploration
  #6  velixar_coverage_check           Anti-hallucination guardrail

Phase 4 — Retrieval Integration
  #7  velixar_context upgrade          Triangulated retrieval

Phase 5 — Context Construction (after Phase 3 + 4)
  #11 velixar_prepare_context          Task-aware context assembly
  #12 velixar_refine_context           Iterative refinement loop
  #13 Context provenance system        Audit trail for assembly decisions

Phase 6 — Behavioral Integration
  #10 Matrix, prompts, contracts       Documentation + CI
  #14 Constitution update              4-phase cognitive cycle
```

### Updated Dependency Graph

```
#8 temporal_merge ─────┬──→ #4 multi_search ──────┐
                       ├──→ #5 neighborhood ───────┤
                       ├──→ #6 coverage_check ─────┤
                       └──→ #7 context upgrade ────┤
#9 validators ─────────┬──→ #4, #5, #6            │
                       ├──→ #11, #12               │
#1 search_by_vector ───┴──→ #5                     │
#2 multi_search (BE) ─────→ #4                     │
#3 coverage (BE) ─────────→ #6                     │
                                                   │
#4 + #6 ──────────────────→ #11 prepare_context ───┤
#11 ──────────────────────→ #12 refine_context ────┤
#11 + #12 ────────────────→ #13 provenance ────────┤
                                                   │
#7 + #11 + #12 + #13 ────→ #10 matrix/prompts ────┤
                          → #14 constitution ──────┘
```

### Updated Critical Path

```
#8 + #9 + #1 + #2 + #3     (all parallel)
  → #4 + #5 + #6           (all parallel)
  → #7 + #11               (parallel — context upgrade + prepare_context)
  → #12 + #13              (parallel — refine + provenance)
  → #10 + #14              (docs + constitution)
```

6 sequential phases. Phases 1-2 and 3 fully parallelizable.

---

## Updated Cognitive Flow — Constitution Change (#14)

Current constitution: "Orient then narrow."

New constitution: **Orient → Retrieve → Verify → Construct → Answer.**

```
┌─────────┐    ┌──────────┐    ┌────────┐    ┌───────────┐    ┌────────┐
│ Orient  │───→│ Retrieve │───→│ Verify │───→│ Construct │───→│ Answer │
│         │    │          │    │        │    │           │    │        │
│ context │    │ multi_   │    │coverage│    │ prepare_  │    │ LLM    │
│         │    │ search   │    │_check  │    │ context   │    │ output │
│         │    │ neighbor │    │        │    │ refine_   │    │        │
│         │    │ timeline │    │        │    │ context   │    │        │
└─────────┘    └──────────┘    └────────┘    └───────────┘    └────────┘
                                   │
                              coverage < 0.7?
                              ┌─────┴─────┐
                              │ YES       │ NO
                              │ retrieve  │ proceed to
                              │ more OR   │ construct
                              │ declare   │
                              │ gaps      │
                              └───────────┘
```

**Key behavioral rule:** Do not proceed from Verify to Construct if coverage < 0.7 unless gaps are explicitly declared in the anti_hallucination section. This is the enforcement mechanism — the tools enable it, the constitution mandates it.

**Cognitive mode table (final):**

| Mode | Question | First Tool |
|------|----------|------------|
| Orientation | "Understand the situation broadly" | velixar_context |
| Retrieval | "I know what I'm looking for" | velixar_search |
| Deep Retrieval | "I need comprehensive coverage" | velixar_multi_search |
| Structure | "Understand connections" | velixar_graph_traverse |
| Continuity | "How did this evolve?" | velixar_timeline |
| Conflict | "Something contradicts" | velixar_contradictions |
| Consolidation | "Preserve what matters" | velixar_distill |
| Verification | "Is my context complete?" | velixar_coverage_check |
| Construction | "Assemble what I need to answer" | velixar_prepare_context |

---

## Tool Contracts (New — Phase 5)

### velixar_prepare_context

```json
{
  "cognitive_mode": "construction",
  "use_when": "about to generate an answer and need assembled, token-budgeted context with explicit gaps",
  "do_not_use_when": "still exploring or orienting — use context or multi_search first",
  "disambiguate_from": ["velixar_context", "velixar_multi_search"],
  "signal_words": ["prepare", "assemble", "ready to answer", "build context", "what do I need"]
}
```

### velixar_refine_context

```json
{
  "cognitive_mode": "construction",
  "use_when": "mid-generation, realized more detail needed on a specific section or gap",
  "do_not_use_when": "no prior prepare_context call — start there first",
  "disambiguate_from": ["velixar_prepare_context", "velixar_search"],
  "signal_words": ["more on", "expand", "fill gap", "dig deeper into"]
}
```

---

## Additional Test Fixtures (Phase 5)

6. **Context assembly fixture**: 20 memories across 3 topics with 2 chains and 1 contradiction. Verify prepare_context with `task_answer` strategy produces sections in correct priority order, superseded memories excluded from `current_state`, gaps declared in `anti_hallucination`.

7. **Token budget fixture**: Same 20 memories, budget of 1000 tokens. Verify lowest-priority sections are truncated first, truncation flags set, high-priority sections intact.

8. **Refinement fixture**: Prepare context with 2 declared gaps. Call refine_context to fill one gap. Verify gap removed from anti_hallucination list, new memories added to provenance, other gap persists.

9. **Provenance audit fixture**: Prepare + 2 refinements. Verify provenance chain captures all retrieval steps, assembly decisions, and refinement actions in order.

---

## Success Criteria

1. **Recall@10 improvement**: Multi-search retrieves ≥30% more unique relevant memories than single search on the multi-angle fixture
2. **Zero temporal conflation**: Superseded memories never appear in `current` group across all test fixtures
3. **Coverage accuracy**: Coverage ratio within ±0.1 of manual count on coverage gap fixture
4. **Hallucination reduction**: LLM explicitly flags gaps (via coverage data) instead of filling them, measured on messy-fixture benchmark
5. **Latency**: Compact context p95 ≤ 1.5s (current baseline ~800ms, budget for 2 additional parallel searches)
6. **Backward compatibility**: All existing tests pass without modification
7. **Context assembly correctness**: prepare_context sections match strategy priority order on assembly fixture
8. **Budget compliance**: Token count never exceeds budget. Truncation applied to lowest-priority sections first.
9. **Refinement accuracy**: fill_gap action removes filled gaps from anti_hallucination list; unfilled gaps persist
10. **Provenance completeness**: Every memory in context_package traces back to a retrieval step in provenance. No orphaned references.


---

## Integration Breakage Analysis — 7 Whys

Every integration surface in the existing codebase reviewed. For each, 7 levels of "how could the new builds break this?" with preventive actions.

### Surface 1: `server.ts` — Tool Registration & Routing

The server imports tool arrays from each module, concatenates them into `allTools`, and routes `CallToolRequest` by matching tool names against handler sets.

| Why | How It Breaks | Preventive Action |
|-----|---------------|-------------------|
| 1 | New tools in `lifecycle.ts` (multi_search, neighborhood, coverage_check, prepare_context, refine_context) aren't imported → they don't appear in `ListTools` response → LLM never sees them. | New tools go in existing `lifecycleTools` array OR a new `retrievalTools` array. If new file, add import + handler entry in `server.ts`. |
| 2 | New tool file (e.g., `retrieval.ts`) added but `toolHandlers` array in server.ts not updated → tool listed but `CallToolRequest` returns "Unknown tool." | CI test: every tool in `allTools` must have exactly one matching handler in `toolHandlers`. Add to `prompt-freshness.test.js` check. |
| 3 | `detectAntiPattern()` doesn't know about new tools → gives bad advice. E.g., `velixar_search` after `velixar_multi_search` triggers "use batch_search" hint, which is wrong. | Update anti-pattern rules: `multi_search` should suppress the "sequential search" warning. Add `multi_search` and `prepare_context` to the "search-like" tool set. |
| 4 | `mutationTools` set doesn't include new tools → `refreshRelevantMemories` not triggered after `prepare_context` stores provenance. | `prepare_context` and `refine_context` are read-only (they retrieve, not store). Provenance storage (#13) IS a mutation — add it to the mutation set if it calls `/memory` POST. |
| 5 | `allToolNames` passed to `handleSystemTool` for `velixar_capabilities` → new tools automatically included. But `allPrompts` might not include new workflow prompts. | New prompts must be added to the `allPrompts` export in `prompts.ts`. Existing pattern handles this. |
| 6 | Server version string `'1.1.0'` — should it bump? New tools are additive, not breaking. | Bump to `1.2.0` (minor) when Phase 3 tools land. Bump to `1.3.0` for Phase 5. |
| 7 | HTTP transport sessions — new tools work over stdio but untested over HTTP/SSE. | New tools use same `handleLifecycleTool` pattern. No transport-specific code. But add HTTP integration test for at least one new tool. |

### Surface 2: `prompts.ts` — Constitution & Workflow Prompts

The constitution defines cognitive modes, the master pattern, anti-patterns, and batch operation guidance. 18 workflow prompts reference specific tools.

| Why | How It Breaks | Preventive Action |
|-----|---------------|-------------------|
| 1 | `COGNITIVE_MODES` array is `as const` — adding new modes changes the type. Any code that exhaustively matches modes will fail to compile. | Check: `renderModesTable()` just maps the array — additive is safe. `resources.ts` imports `COGNITIVE_MODES` — also just maps. No exhaustive switch/case exists. Safe to add. |
| 2 | Constitution says "Orient Then Narrow" as the master pattern. New flow is "Orient → Retrieve → Verify → Construct → Answer." If constitution isn't updated, LLMs follow the old pattern and skip Verify + Construct. | Constitution update is Build #14. But it MUST ship with or before the tools. If tools ship without constitution update, LLMs won't know to use them. Gate: #14 must merge in same release as #11. |
| 3 | Constitution says "You do NOT need to manually traverse the graph after searching — it's built in." Multi-search amplifies this. But `search_neighborhood` IS manual traversal. Contradiction in guidance. | Update constitution: "Graph traversal is built into search. Use `search_neighborhood` only for vector-space exploration from a specific anchor — it's geometric, not semantic." |
| 4 | Workflow prompts reference specific tool sequences. E.g., `orient_then_narrow` says "use at most 3 tool calls." With the new flow (context → multi_search → coverage_check → prepare_context), that's 4 calls minimum. | Update affected prompts to allow 4-5 calls. Or: `prepare_context` internally calls multi_search + coverage, so the LLM only calls 2 tools (context → prepare_context). Prefer this — fewer LLM decisions. |
| 5 | `recall_prior_reasoning` prompt says "Suggested approach (use at most 3 tool calls)." If LLM uses `prepare_context` instead of manual search, it's 2 calls (context → prepare_context). Better, not worse. | No breakage — new tools reduce call count for existing workflows. But update prompt text to mention `prepare_context` as an option. |
| 6 | `S4: Prompt versioning` — every prompt has a `version` field. Changed prompts must bump version. Benchmark hashes in `.benchmark-hashes.json` will mismatch. | Bump versions on all changed prompts. Run `check-benchmark-staleness.js` to regenerate hashes. |
| 7 | `check-constitution-ab.js` script may test specific constitution text. If constitution text changes, A/B test baselines break. | Review script — it tests tool selection accuracy against constitution variants. New modes + tools need new test cases added. |

### Surface 3: `resources.ts` — Startup Resources & Constitution Fallback

Resources are fetched at startup and served to hosts. The compact constitution fallback is injected into first tool response if host never reads the resource.

| Why | How It Breaks | Preventive Action |
|-----|---------------|-------------------|
| 1 | `COMPACT_CONSTITUTION` is a hardcoded string mentioning specific modes: "Retrieval→search, Structure→graph_traverse..." Adding new modes without updating this string means the fallback is stale. | Update `COMPACT_CONSTITUTION` to include new modes. Or: generate it from `COGNITIVE_MODES` array instead of hardcoding. Prefer the latter — single source of truth. |
| 2 | `fetchRecall()` does startup fetches with `api.get<{ memories?: MemoryRecord[] }>` — the same bug pattern we just fixed. | These are in `resources.ts`, not in `tools/`. They weren't fixed in the audit because they're not tool handlers. Fix them now as part of this work. |
| 3 | `refreshRelevantMemories()` searches for "important recent context" — a single query. With multi-search available, should this use multi-angle retrieval? | Not yet — startup resources should be fast. Single query is fine for proactive context. But: consider using `prepare_context` logic for the `velixar://memories/relevant` resource in a future iteration. |
| 4 | `CONSTITUTION_VERSION` is `'0.5.0'` — separate from server version `'1.1.0'`. Constitution changes need version bump here too. | Bump `CONSTITUTION_VERSION` when constitution text changes. Add CI check: constitution version must change if constitution text hash changes. |
| 5 | `getConstitutionFallback()` returns the compact constitution once per session. If the LLM reads the full constitution resource later, it has two versions — compact (old) and full (new). | Compact constitution must be a strict subset of the full constitution. Never add guidance to compact that contradicts full. Review both when updating. |
| 6 | `readResource()` for shadow graph uses `api.post<Record<string, unknown>>('/graph/search', ...)` — raw typed call. | Fix this to use safe extraction pattern. Add to the cleanup list. |
| 7 | New resource URIs (e.g., `velixar://context/prepared`) might be needed for `prepare_context` output. | Not needed initially — `prepare_context` is a tool, not a resource. But if hosts want to cache prepared context as a resource, add it in a future phase. |

### Surface 4: `validate.ts` — Response Validators

All tool handlers depend on validators to safely extract data from API responses.

| Why | How It Breaks | Preventive Action |
|-----|---------------|-------------------|
| 1 | New backend endpoints (`/memory/multi_search`, `/memory/search_by_vector`, `/memory/coverage`) return new response shapes. No validators exist for them. | Build #9 creates these validators. Must land before any tool that calls these endpoints. |
| 2 | Existing `validateSearchResponse` assumes `{ memories: [...] }` shape. If the multi_search endpoint returns `{ results: [{ query, memories }] }`, reusing the same validator fails. | New `validateMultiSearchResponse` validator — don't overload the existing one. Each endpoint shape gets its own validator. |
| 3 | `ValidatedRawMemory` interface might need new fields (e.g., `previous_memory_id` is already there, but `chain_position`, `superseded_by` might be needed). | Validators are additive — new optional fields don't break existing code. Add fields to `ValidatedRawMemory` only if the backend actually returns them. Don't speculatively add fields. |
| 4 | `SchemaError` thrown by validators propagates up to `server.ts` catch block → returns generic "Error: ..." to LLM. New validators should follow the same pattern. | New validators use same `SchemaError` class. No change needed in error handling. |
| 5 | `validateGraphResponse` is used by `graph_traverse`. If `search_neighborhood` also returns graph-like data, should it reuse this validator? | No — neighborhood returns memories with classification (forward/backward/lateral), not graph nodes/edges. New validator needed. |
| 6 | Circular dependency risk: `validate.ts` must not import from `api.ts` (noted in file header). New validators must follow this rule. | New validator file (`validate_multi_search.ts`) or additions to existing `validate.ts`. Either way, no `api.ts` imports. |
| 7 | `check-schema-contracts.ts` CI script validates backend response shapes. New endpoints need new checks added. | Add checks for `/memory/multi_search`, `/memory/search_by_vector`, `/memory/coverage` to the script. These checks run against live backend — endpoints must exist first. |

### Surface 5: `tool-contracts.json` + `tool-prompt-matrix.json` + `.benchmark-hashes.json`

Three JSON files that CI scripts validate against source code.

| Why | How It Breaks | Preventive Action |
|-----|---------------|-------------------|
| 1 | `prompt-freshness.test.js` checks every tool in source is in `tool-prompt-matrix.json`. New tools missing from matrix → test fails. | Add all new tools to matrix before merging. We already fixed this pattern for `velixar_upload`. |
| 2 | `prompt-freshness.test.js` scans specific tool files: `['memory.ts', 'recall.ts', 'graph.ts', 'cognitive.ts', 'lifecycle.ts', 'system.ts', 'livedata.ts']`. If new tools go in a new file (e.g., `retrieval.ts`), the test won't find them. | Either: add new tools to existing `lifecycle.ts`, or add the new filename to the test's scan list. Prefer: new file + update test. |
| 3 | `tool-contracts.json` has disambiguation contracts for existing tools. New tools that overlap with existing ones (e.g., `multi_search` vs `search` vs `batch_search`) need contracts or LLMs will pick the wrong tool. | Add contracts for all new tools. Especially critical: `multi_search` vs `search` vs `batch_search` disambiguation. The `check-tool-descriptions.ts` script tests ambiguous pairs — add new pairs. |
| 4 | `.benchmark-hashes.json` tracks description hashes per tool. New tools need entries. Changed descriptions on existing tools (e.g., `velixar_context` upgrade) need hash updates. | Run `check-benchmark-staleness.js` after all changes. It will flag stale hashes. |
| 5 | `check-sdk-parity.ts` compares MCP tools against JS/Python SDK methods. New tools need SDK methods or need to be added to `SDK_EXEMPT` set. | New retrieval tools (`multi_search`, `search_neighborhood`, `coverage_check`, `prepare_context`, `refine_context`) should be SDK-exposed. Add to SDK backlog. For initial release, add to `SDK_EXEMPT` to unblock MCP merge. |
| 6 | `tool-selection-prompts.json` benchmark has expected tool selections for user prompts. New tools change which tool is "correct" for some prompts. E.g., "I need comprehensive coverage" currently maps to `velixar_context` — should now map to `velixar_multi_search`. | Add new benchmark prompts for new tools. Review existing prompts — some may need updated expected values. |
| 7 | `benchmarks/distillation-models.json` and `benchmarks/messy-fixture.json` — do they reference tool names? | Check: `messy-fixture.json` tests recall quality, not tool selection. `distillation-models.json` tests distill quality. Neither references tool names directly. Safe — no changes needed. |

### Surface 6: `api.ts` — API Client, Caching, Circuit Breaker

All tools share one `ApiClient` instance with caching, retry, and circuit breaker.

| Why | How It Breaks | Preventive Action |
|-----|---------------|-------------------|
| 1 | `prepare_context` makes multiple API calls internally (multi_search + coverage + assembly). If any call trips the circuit breaker, the whole context assembly fails. | `prepare_context` must use `Promise.allSettled` for its internal calls and degrade gracefully — return partial context with sections marked as unavailable. Same pattern as `velixar_context`. |
| 2 | Cache TTL is 60 seconds. `prepare_context` → `refine_context` within 60s will hit cached results for the same queries. This is usually good (fast refinement) but could return stale data if memories were stored between calls. | Refinement should bust cache for the specific target query. Or: refinement uses a different query (the gap/section topic), which won't be cached. Likely safe without changes. |
| 3 | Rate limit tracking (`x-ratelimit-remaining` header). `prepare_context` makes 3-5 internal API calls. If rate limit is tight, it could exhaust the budget in one tool call. | Check rate limit before starting multi-call operations. If remaining < 5, fall back to single-query mode. Add rate-limit-aware degradation to `prepare_context`. |
| 4 | `normalizeMemory()` is the single normalization function. New tools must use it — not create their own normalization. | All new tool handlers import and use `normalizeMemory` from `api.ts`. Code review gate: no raw memory objects in tool responses. |
| 5 | `wrapResponse()` adds `meta` envelope with `workspace_id`, `confidence`, `staleness`, etc. New tools must use it. | Same pattern — all new handlers use `wrapResponse`. The `prepare_context` response has additional structure (`context_package`, `anti_hallucination`) but still wraps in `VelixarResponse<T>`. |
| 6 | `makeMeta()` computes `sufficient_answer` based on `data_absent`, `partial_context`, `contradictions_present`, `confidence`. For `prepare_context`, "sufficient" means coverage ≥ 0.7 AND no high-severity contradictions. | Override `sufficient_answer` in `prepare_context` based on coverage ratio, not just data presence. Pass as `overrides` to `wrapResponse`. |
| 7 | Timing tracking (`recordTiming`) — `prepare_context` will show as one long timing entry even though it makes multiple internal calls. Hard to debug which sub-call is slow. | Log sub-call timings separately: `api_timing { path: '/memory/search', parent: 'prepare_context', ... }`. Add `parent` field to timing entries for nested calls. |

### Surface 7: Existing Tool Behavior — Regression Risks

Changes to shared modules (`temporal_merge.ts`, validators) and the `velixar_context` upgrade could break existing tools.

| Why | How It Breaks | Preventive Action |
|-----|---------------|-------------------|
| 1 | `velixar_context` upgrade (#7) changes its internal search from single-query to 3-angle. If the merge logic has a bug, context returns wrong/empty results. Every LLM session starts with context — this is catastrophic. | Feature flag: `VELIXAR_CONTEXT_MULTI_ANGLE=true/false`. Default `false` initially. Flip to `true` after validation. Rollback = env var change, no deploy needed. |
| 2 | `temporal_merge.ts` (#8) is imported by `batch_search` (already fixed), `multi_search`, `neighborhood`, `coverage_check`, and `context`. A bug in temporal_merge breaks 5 tools simultaneously. | Extensive unit tests for temporal_merge in isolation. Test: chain detection, decay scoring, supersession marking, broken chain fallback. Must have 100% branch coverage before any consumer imports it. |
| 3 | `velixar_search` (the existing single-search tool) is unchanged. But if the constitution update (#14) tells LLMs to prefer `multi_search`, existing workflows that work fine with single search get unnecessarily complex. | Constitution should say: "Use `velixar_search` for simple lookups. Use `velixar_multi_search` when you suspect vocabulary mismatch or need comprehensive coverage." Don't deprecate single search. |
| 4 | `velixar_batch_search` (just fixed) — does it become redundant with `multi_search`? If so, LLMs get confused choosing between 3 search tools. | Clear disambiguation: `search` = single query. `batch_search` = multiple independent queries, separate results. `multi_search` = multiple queries, merged + deduplicated + temporally aware results. All three serve different purposes. |
| 5 | `velixar_timeline` already does temporal chain traversal. `temporal_merge.ts` does chain detection. If they use different chain-walking logic, they'll disagree on temporal ordering. | Timeline must import chain detection from `temporal_merge.ts` instead of its own inline logic. Refactor timeline in Phase 4 to use the shared module. |
| 6 | `velixar_contradictions` classifies conflicts as "contradiction" vs "superseded" using a 7-day threshold. `temporal_merge.ts` uses chain links for supersession. If they disagree, the LLM gets conflicting signals. | Align: contradictions tool should import supersession logic from `temporal_merge.ts`. Same threshold, same chain detection. Single source of truth. |
| 7 | `velixar_distill` does duplicate detection via cosine similarity search. If `temporal_merge` changes how memories are scored (decay), the duplicate threshold might need adjustment. | Distill's duplicate detection is based on raw cosine score from the backend, not on MCP-side scoring. Temporal decay is applied after retrieval. No interaction — safe. But document this boundary. |

---

## Pre-Flight Checklist — Before Any Code Is Written

Based on the above analysis, these must be resolved before implementation begins:

### Immediate fixes (carry forward from audit)
- [ ] Fix `resources.ts` raw typed API calls (`api.get<{ memories?: MemoryRecord[] }>`) — same bug pattern we fixed in tools
- [ ] Generate `COMPACT_CONSTITUTION` from `COGNITIVE_MODES` array instead of hardcoding

### Architecture decisions needed
- [ ] New tools in existing `lifecycle.ts` or new `retrieval.ts` file? (Recommendation: new file — lifecycle.ts is already 1000+ lines)
- [ ] `prepare_context` calls multi_search + coverage internally, or expects LLM to call them first? (Recommendation: internally — fewer LLM decisions, more deterministic)
- [ ] Feature flag for context upgrade? (Recommendation: yes — `VELIXAR_CONTEXT_MULTI_ANGLE`)

### CI/test updates needed with every phase
- [ ] `prompt-freshness.test.js` — add new tool file to scan list
- [ ] `tool-prompt-matrix.json` — add all new tools
- [ ] `tool-contracts.json` — add disambiguation contracts for new tools
- [ ] `.benchmark-hashes.json` — regenerate after description changes
- [ ] `check-schema-contracts.ts` — add new backend endpoint checks
- [ ] `check-sdk-parity.ts` — add new tools to `SDK_EXEMPT` (until SDKs catch up)
- [ ] `check-tool-descriptions.ts` — add ambiguous pairs: multi_search vs search, multi_search vs batch_search, prepare_context vs context
- [ ] `tool-selection-prompts.json` — add benchmark prompts for new tools, review existing expected values
- [ ] `server.test.js` — add handler tests for new tools


---

## Deep 7 Whys — Systemic Risk Analysis

Six cross-cutting concerns that span the entire system, not individual builds.

---

### Analysis 1: Cognitive Flow Viability

Does Orient → Retrieve → Verify → Construct → Answer actually work, or does it create overhead that makes LLMs worse?

| Why | Question | Answer | Hardening Action |
|-----|----------|--------|------------------|
| 1 | Why might a 5-phase flow hurt LLM performance? | More phases = more tool calls = more tokens consumed on orchestration instead of answering. A simple question like "what's the outreach plan?" goes from 1 tool call (search) to 4 (context → multi_search → coverage_check → prepare_context). | The flow is a maximum, not a minimum. Constitution must say: "Simple factual lookups → velixar_search, one call. The full flow is for complex synthesis tasks only." Add complexity heuristic to constitution. |
| 2 | Why would LLMs follow a 5-phase flow at all? | They won't reliably. LLMs are bad at multi-step planning. They'll skip Verify, go straight from Retrieve to Answer, and hallucinate. The flow only works if tools enforce it. | `prepare_context` runs coverage_check internally. The LLM doesn't need to remember to verify — it's built into the construction step. Reduce the LLM's decision burden from 5 phases to 2: orient (context) → answer (prepare_context). |
| 3 | Why not just make prepare_context do everything — orient + retrieve + verify + construct? | Then it's a god-tool. Slow, expensive, and the LLM loses the ability to steer retrieval based on what it learns in orientation. | Two-tool flow for complex tasks: `context` (fast orientation, tells LLM what exists) → `prepare_context` (does retrieval + verify + construct internally). LLM makes ONE decision between them: "do I know enough from context, or do I need prepare_context?" |
| 4 | Why would the LLM know when to use the simple path vs the full path? | It won't — unless the tool descriptions make it obvious. Current search description says "Use to find specific factual assertions." That's clear. prepare_context needs equally clear triggering language. | Description: "Use when you're about to synthesize a complex answer and need assembled, verified context. Do NOT use for simple factual lookups — use velixar_search for those." Signal words: "synthesize", "comprehensive", "complex question". |
| 5 | What if the LLM always picks prepare_context even for simple questions? | Wasted latency (~2s vs ~400ms for single search). But the answer quality won't be worse — just slower. This is an efficiency problem, not a correctness problem. | Monitor via telemetry: track prepare_context calls where coverage_ratio is 1.0 and only 1-2 memories are included. If >50% of calls are trivial, the description needs sharpening. |
| 6 | What if the LLM never picks prepare_context? | It falls back to the current behavior — search + manual assembly. Hallucination risk stays at current levels. No regression, just no improvement. | Constitution reinforcement: after 3+ sequential search calls in one session, inject hint: "Consider velixar_prepare_context for complex synthesis." Same pattern as existing anti-pattern detection. |
| 7 | What if different LLM providers (Claude, GPT, Gemini) follow the flow differently? | They will. Claude tends to be methodical (will follow multi-step). GPT tends to shortcut. Gemini varies. One constitution can't optimize for all. | The 2-tool simplification (context → prepare_context) is model-agnostic. Internal orchestration is deterministic regardless of which LLM calls it. Model-specific tuning is a future concern — not a launch blocker. |

**Resolution:** The 5-phase flow is an internal architecture, not an LLM-facing instruction. The LLM sees a 2-tool flow: `context` for orientation, `prepare_context` for complex synthesis. Everything else happens inside prepare_context. Update constitution accordingly.

---

### Analysis 2: Token Economics

Every new tool adds to the ListTools response. Going from 26 to 31 tools. Does the tool description payload crowd out context?

| Why | Question | Answer | Hardening Action |
|-----|----------|--------|------------------|
| 1 | How big is the current ListTools payload? | ~26 tools × ~100 tokens per description = ~2,600 tokens. Adding 5 tools = ~3,100 tokens. That's ~3% of a 100K context window but ~25% of a 12K window (some hosts). | Measure actual token count of ListTools response. If >3,000 tokens, consider description compression. |
| 2 | Do all hosts load all tool descriptions at once? | Yes — MCP ListTools returns everything. The host injects all descriptions into the LLM's system prompt. No lazy loading. | Can't control host behavior. But: keep descriptions concise. Current average is ~80 words per tool. New tools must stay under 80 words. |
| 3 | What if a host has a small context window (8K-12K)? | 3,100 tokens of tool descriptions + constitution (~400 tokens compact) + system prompt = ~4,000 tokens before the user says anything. That's 50% of an 8K window consumed by infrastructure. | Add `VELIXAR_TOOL_TIER` env var. Tier 1 (default): all tools. Tier 2: core tools only (search, store, context, prepare_context, distill — ~10 tools). Hosts with small windows use Tier 2. |
| 4 | Does the constitution duplicate information already in tool descriptions? | Yes — the cognitive modes table lists tools and their purposes, which overlaps with individual tool descriptions. Double-counting. | Constitution should reference modes by name, not re-describe tools. "Use the tool matching the cognitive mode" not "velixar_search finds specific factual assertions..." — that's already in the tool description. |
| 5 | What about the tool-prompt-matrix prompts? Are those loaded too? | Only if the host calls GetPrompt. Most hosts don't — they only read ListTools + ListResources. Prompts are opt-in. | No action needed. Prompts are already lazy-loaded. |
| 6 | Do tool descriptions need to include "Do NOT use when..." clauses? | They currently do — each description has positive and negative guidance. The negative guidance adds ~30% to description length. | Move negative guidance to tool-contracts.json (for CI disambiguation testing) and keep only positive guidance in descriptions. Saves ~30 tokens per tool × 31 tools = ~930 tokens. |
| 7 | What's the actual measured impact on answer quality when tool descriptions consume more context? | Unknown — no benchmark exists for this. But research shows LLMs degrade when >40% of context is system instructions. | Add benchmark: measure answer quality on messy-fixture with 26 tools vs 31 tools vs 10 tools (Tier 2). If quality drops >5% at 31 tools, implement tiering. |

**Resolution:** Implement `VELIXAR_TOOL_TIER` env var now (infrastructure only — no tool changes needed). Measure ListTools token count. Move "Do NOT use when" clauses from descriptions to contracts.json to save ~930 tokens. Benchmark quality impact before adding tools beyond 31.

---

### Analysis 3: prepare_context Internal Orchestration

prepare_context calls multi_search + coverage + assembly internally. What happens when sub-calls fail?

| Why | Question | Answer | Hardening Action |
|-----|----------|--------|------------------|
| 1 | What if multi_search fails entirely? | No memories retrieved. prepare_context returns empty context with `coverage_ratio: 0` and all topics listed as gaps. LLM sees "I have nothing" — better than hallucinating. | Use `Promise.allSettled` for all internal calls. Partial results always returned. Empty retrieval → `anti_hallucination.instruction: "No context available. State that you have no stored information on this topic."` |
| 2 | What if multi_search succeeds but coverage_check fails? | Memories retrieved but no coverage signal. prepare_context can still assemble context — it just can't tell the LLM how complete it is. | Coverage failure → `coverage_ratio: null` (not 0 — null means unknown, 0 means empty). Add `coverage_status: 'unavailable'` flag. LLM sees "context assembled but completeness unknown." |
| 3 | What if one of the 3 multi_search sub-queries fails? | 2 of 3 angles succeed. Weighted merge works with partial results — just less diverse. | Per-query error handling already designed in multi_search (Build #4). prepare_context inherits this. Response includes `search_angles_used: 2` and `search_angles_failed: 1`. |
| 4 | What if assembly takes too long (>5s)? | LLM times out waiting. MCP has no streaming for tool responses — it's all-or-nothing. | Set internal timeout: if retrieval takes >3s, skip coverage_check and assemble with what's available. Add `assembly_mode: 'fast' | 'full'` to response so LLM knows. |
| 5 | What if the token budget is too small for the retrieved memories? | Truncation kicks in — lowest-priority sections cut first. But what if even the highest-priority section exceeds the budget? | Minimum viable context: always include at least the top-1 memory (even if it exceeds budget) + the anti_hallucination gaps section. Budget is a target, not a hard wall, for the first section. |
| 6 | What if multi_search and coverage_check return contradictory signals? | Multi_search finds 10 memories. Coverage says only 3 are relevant to the topic. Which is right? | Coverage is the authority on topic relevance. Multi_search casts a wide net — some results are tangential. Assembly should filter multi_search results through coverage's relevance assessment. If coverage is unavailable, use multi_search relevance scores as fallback. |
| 7 | What if the same prepare_context call is made twice in rapid succession? | Second call hits cache for the search results (60s TTL). Assembly runs again but produces identical output. Wasted compute but not incorrect. | Cache the full context_package by intent hash for 60s. Second call returns cached package instantly. Different intent = different cache key. |

**Resolution:** All internal calls use `Promise.allSettled`. 3-second timeout triggers fast-assembly mode. Coverage is authoritative for relevance filtering. Cache full context_package by intent hash. Minimum viable context always includes top-1 memory + gaps.

---

### Analysis 4: Backward Compatibility During Transition

LLMs that learned the current tool set now have 5 new tools. Does the transition create confusion?

| Why | Question | Answer | Hardening Action |
|-----|----------|--------|------------------|
| 1 | Will LLMs try to use new tools that don't exist yet? | No — tools only appear in ListTools when implemented. LLMs can't call tools they don't see. But the constitution might reference tools before they're implemented. | Constitution update (#14) must ship in the same release as the tools it references. Never reference a tool in the constitution before it's in ListTools. |
| 2 | Will existing workflows break when new tools appear? | Not functionally — existing tools are unchanged. But LLMs might start picking new tools for tasks that worked fine with old tools. E.g., using multi_search where single search was sufficient. | Tool descriptions must make the simple path obvious. "Use velixar_search for simple lookups" should appear before "Use velixar_multi_search for comprehensive coverage." Order in ListTools matters — keep search before multi_search. |
| 3 | What if a host caches the ListTools response? | Old tool list cached → new tools invisible until cache expires. Not a correctness issue — just delayed availability. | MCP spec doesn't define cache headers for ListTools. Hosts that cache will eventually refresh. No action needed. |
| 4 | What about saved prompts/workflows that reference specific tool sequences? | Users who built custom workflows around "context → search → search → distill" will still work. New tools are additive. | No existing tool is removed or renamed. No existing tool's behavior changes (except context, behind feature flag). Zero breaking changes. |
| 5 | What if the LLM uses prepare_context but the backend endpoints (#1, #2, #3) aren't deployed yet? | prepare_context calls multi_search internally, which calls `/memory/multi_search` endpoint. If endpoint doesn't exist → 404 → prepare_context fails. | prepare_context must degrade: if `/memory/multi_search` returns 404, fall back to N parallel `/memory/search` calls (same as current batch_search logic). Backend endpoints are an optimization, not a requirement. |
| 6 | What if we need to roll back a new tool after release? | Remove from tool array → disappears from ListTools. But LLMs in active sessions still have the old ListTools cached. They'll call a tool that no longer exists → "Unknown tool" error. | "Unknown tool" error already handled in server.ts with a clear message. Session-level impact only — next session gets updated ListTools. Acceptable. |
| 7 | What about the JS and Python SDKs? | SDKs expose methods that map to MCP tools. New tools added to SDK_EXEMPT. But SDK users who read the MCP docs might try to call new tools via the SDK and get confused. | SDK changelog must note: "New MCP tools (multi_search, prepare_context, etc.) are not yet available in the SDK. Use the MCP server directly for these features." Add to SDK README. |

**Resolution:** Ship constitution update with tools (same release). Degrade gracefully when backend endpoints missing. Keep existing tools unchanged. SDK exempt list already updated. No breaking changes by design.

---

### Analysis 5: Temporal Merge Algorithm Edge Cases

Exponential decay + chain detection + supersession marking. What produces wrong results?

| Why | Question | Answer | Hardening Action |
|-----|----------|--------|------------------|
| 1 | What if a memory chain forks? Memory A → B and A → C (two updates to the same original). Which is "current"? | Both B and C are chain heads. Neither supersedes the other — they're parallel branches. This is actually a contradiction, not a supersession. | Detect forks: if a memory has multiple children (multiple memories with `previous_memory_id` pointing to it), flag as `chain_fork: true`. Surface both branches. Let contradictions system handle the conflict. |
| 2 | What if the chain is long (A → B → C → D → E)? Does A get demoted to 0.3^4 = 0.008× relevance? | No — supersession is binary, not cumulative. A is superseded by B (0.3×). B is superseded by C (0.3×). Only the immediate predecessor is demoted relative to its successor. A's absolute relevance is 0.3× its original score, same as B's. | Supersession demotion is flat 0.3× per memory, not compounded through the chain. Only the chain head gets full relevance. All others get 0.3× regardless of chain depth. |
| 3 | What if `previous_memory_id` points to a deleted memory? | Chain is broken. The memory looks like a chain head (no predecessor found) but it's actually mid-chain. It gets full relevance when it should be demoted. | When walking chains, if a `previous_memory_id` resolves to 404, mark as `chain_broken: true`. Don't treat as chain head — treat as `uncertain_position`. Apply moderate demotion (0.6× instead of 1.0× or 0.3×). |
| 4 | What if two memories have identical content but different IDs and no chain link? | Deduplication should catch this in multi_search merge. But if they have slightly different content (e.g., one has a typo fix), they're not exact duplicates and both survive. | Content similarity check during merge: if two memories have >0.95 cosine similarity AND are >24h apart, flag the older one as `likely_superseded` with the timestamp heuristic (low confidence). |
| 5 | What about the 7-day timestamp heuristic fallback? Two memories about "outreach plan" 8 days apart — the heuristic says "superseded" but maybe the user just revisited the topic. | The heuristic is wrong in this case. Revisiting ≠ superseding. The 7-day threshold is arbitrary and will produce false positives. | Heuristic-based supersession gets `confidence: 'inferred'` (not `'explicit'`). Response clearly labels: "Possible supersession (timestamp-based, no chain link). May be a revisit." LLM decides whether to treat as superseded. Never auto-demote on heuristic alone. |
| 6 | What about temporal decay on memories that are old but still true? "Company founded in 2024" is 2 years old but permanently valid. | Exponential decay penalizes it: `exp(-0.02 * 730) ≈ 0.00`. A 2-year-old memory is effectively invisible. This is wrong for permanent facts. | Decay applies only to episodic memories (tier 1). Semantic memories (tier 2) and pinned memories (tier 0) are exempt from temporal decay. They represent durable knowledge. Add tier check before applying decay. |
| 7 | What if the decay rate constant (0.02) is wrong for a specific workspace? | A workspace with daily updates needs aggressive decay. A workspace with monthly updates needs gentle decay. One constant doesn't fit all. | Make decay rate configurable: `VELIXAR_TEMPORAL_DECAY_RATE` env var, default 0.02. Document: 0.01 = gentle (half-life ~35 days), 0.02 = moderate (half-life ~17 days), 0.05 = aggressive (half-life ~7 days). |

**Resolution:** Handle chain forks (flag as contradiction). Flat supersession demotion (not compounded). Broken chains get moderate demotion. Heuristic supersession labeled as inferred, never auto-demoted. Temporal decay exempts semantic/pinned memories. Decay rate configurable via env var.

---

### Analysis 6: Multi-Tenant Isolation Under New Tools

prepare_context caches state server-side (context_id). Does this create cross-session or cross-workspace leakage?

| Why | Question | Answer | Hardening Action |
|-----|----------|--------|------------------|
| 1 | Where is context_id state stored? | In-memory on the MCP server process. Each MCP server instance serves one user session (stdio transport) or multiple sessions (HTTP transport). | Stdio: one process per session. No cross-session risk. HTTP: sessions share process memory. context_id state MUST be keyed by session_id, not just context_id. |
| 2 | Can one HTTP session access another session's context_id? | If context_id is a random UUID and the attacker can't guess it — no. But if context_ids are sequential or predictable — yes. | Use `crypto.randomUUID()` for context_ids (already the pattern for session IDs). 128-bit random = unguessable. |
| 3 | What about workspace isolation? Session A (workspace X) and Session B (workspace Y) share the same MCP process over HTTP. Can A's prepare_context leak Y's memories? | prepare_context calls the API with A's API key, which scopes to A's workspace. The API enforces isolation. But the cached context_package in MCP memory contains A's memories — if B somehow gets A's context_id... | Cache key must include workspace_id: `${config.workspaceId}:${contextId}`. Even if B guesses A's context_id, the workspace prefix prevents access. |
| 4 | What about the provenance records stored as memories? | Provenance is stored via `/memory` POST with the session's API key. Workspace-scoped by the backend. No leakage risk. | No additional action — existing workspace isolation applies. |
| 5 | What if the MCP server process crashes and restarts? | In-memory context_id cache is lost. `refine_context` calls with old context_ids fail. | Graceful failure: "Context expired. Call prepare_context again." This is acceptable — context state is ephemeral by design. Don't persist it to disk or database. |
| 6 | What about the temporal_merge module? Does it hold state? | It shouldn't — it's a pure function library. Chain detection, decay scoring, supersession marking are all stateless transforms on input data. | Code review gate: temporal_merge.ts must have zero module-level mutable state. All functions take input and return output. No caches, no singletons. |
| 7 | What about the idempotency cache in lifecycle.ts? It's module-level mutable state shared across sessions in HTTP mode. | Yes — this is an existing risk, not new. If Session A stores "fact X" and Session B stores "fact X" within 5 minutes, B's store is deduplicated against A's. But they're different workspaces — the dedup is wrong. | Idempotency cache key must include workspace_id: `${config.workspaceId}:${contentHash}`. Fix this now — it's a pre-existing bug that the new tools would inherit. |

**Resolution:** Cache keys include workspace_id. context_id uses crypto.randomUUID(). temporal_merge is stateless (enforced by code review). Fix existing idempotency cache to include workspace_id. HTTP sessions share process but not state.
