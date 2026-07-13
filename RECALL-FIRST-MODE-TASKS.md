# Recall-First Mode (Stewardship) — Task & Spec

**Date:** 2026-05-01
**Status:** Spec landed; cognitive mode + workflow prompt ready to ship.
**Related:** Velixar MCP server `src/prompts.ts` (cognitive modes), `tool-contracts.json`, MULTI-POSITION-RETRIEVAL-TASK.md (existing cognitive cycle work).

---

## 1. The problem this solves

The "verify with velixar before finalizing" + "verify velixar_store calls" + "store progress as you go" rules from 2026-04-30 / 2026-05-01 are **discipline contracts** Claude (or any LLM agent) is asked to honor across every code-change task. Empirically they've been honored *most* of the time but not all — failure modes observed in-session include:

- AWS→GCP migration was missed because `MEMORY.md` was 84 days stale and velixar memory wasn't queried first
- A batch-parallel `velixar_store` call landed only 1 of 3 memories (the other two failures were silent)
- A `velixar_store` timed out at 30s with no record created (caller didn't verify, would have been silently lost)
- A 2026-03-21 incident (memory `0c2bb293`): WAF rejected a store, the LLM's session summary "hallucinated success"

**Instructions alone are insufficient for a security-bearing discipline.** When the discipline is structural (a typed mode + a workflow prompt the MCP host advertises on every session boot), the LLM cannot easily forget it because the contract is in the tool surface itself.

## 2. Naming

Two names, two places:

- **Cognitive mode: `Stewardship`** — added to `src/prompts.ts:COGNITIVE_MODES`. The conceptual frame. Matches existing single-word capitalized modes (`Orientation`, `Retrieval`, `Construction`).
  - Question: *"Will future sessions need this work?"*
  - First tool: `velixar_act` (when implemented) or fall back to the `recall_first` workflow prompt.
- **Workflow prompt: `recall_first`** — added to `src/prompts.ts` `WorkflowPrompts` list. The runtime contract. Action-oriented; what an LLM agent actually invokes.

The user's preferred name was `recall_first`; reserving it as the *workflow* name preserves it. `Stewardship` is the *mode* the workflow embodies — a name that fits the existing taxonomy.

## 3. The Recall-First contract (what the workflow enforces)

Four phases, in order, all required:

1. **Recall** — query velixar memory for any prior decision, hardening row, incident, or constraint that bears on the work about to be done. Tool: `velixar_context` (orientation) or `velixar_search` (specific). Capture findings in working memory.
2. **Act** — perform the change (write code, propose a design, update infra). Local-only; nothing committed.
3. **Persist** — `velixar_store` a substantive summary tagged with the work's domain. Sequential, not parallel — batched parallel stores have a documented partial-success failure mode.
4. **Verify** — read the just-stored memory back via `velixar_search` (distinctive 3+ word phrase), `velixar_list` (top entry), or `velixar_inspect` (by ID). If the verification fails, re-store; surface a real persistence failure to the user before continuing.

The workflow prompt makes these explicit; future tooling (Section 5) makes them inescapable.

## 4. 7-Whys Forward Risk Analysis on this design

Each chain anticipates a failure mode of the proposed system. Hardening rows feed back into Section 5.

### F1 — LLM ignores the workflow prompt

| # | Q | A |
|---|---|---|
| 1 | What if the LLM doesn't read the prompt? | Workflow prompts are advisory in the MCP spec; the host can show them but the LLM may not consult them on every tool call. |
| 2 | Why might it not? | Long context drift — the prompt was loaded at session start but pushed out of attention. Or the LLM is in another mode and didn't switch. |
| 3 | Mitigation? | Re-inject the workflow prompt at every `velixar_store` call via the existing `cognitive_constitution` resource pattern (S7). LLM sees the contract every time it stores. |
| 4 | What if even that fails? | **Promote the contract from prompt to code.** A `velixar_act(intent, body_fn)` tool that orchestrates the four phases server-side cannot be skipped — the LLM physically cannot store without verify because the verify happens inside the tool's response, before it returns to the LLM. |

→ **Hardening row R1:** Ship the workflow prompt now (cheap, hours). Then ship `velixar_act` as a follow-up (Section 6) that elevates the contract from advisory to enforced.

### F2 — `velixar_store` succeeds but `velixar_search` doesn't surface the just-stored memory yet (eventual consistency)

| # | Q | A |
|---|---|---|
| 1 | Could the verify step false-fail? | Yes — if Qdrant indexing or KG enrichment is async, the search probe at T+0s may not see the ID stored at T-0s. |
| 2 | What's the actual indexing latency? | Per existing roadmap memory: store_memory writes to Qdrant immediately; KG extraction is SQS/Pub-Sub async (60s+). Vector search is instant. Distinctive-phrase substring search is instant. |
| 3 | Verification choice? | Verify via `velixar_search` for a distinctive phrase from the content (vector-search hot path) OR `velixar_inspect` by ID (direct lookup, definitely synchronous) — NOT KG entity search. |
| 4 | Belt-and-suspenders? | Workflow prompt explicitly tells the LLM: "If verification returns no hits within ~2s, retry once, then if still empty, log a persistence failure." Prevents transient false-negatives from being treated as real failures. |

→ **Hardening row R2:** Verification uses `velixar_search` (distinctive phrase) or `velixar_inspect` (by ID); never KG/entity probes. Single retry with backoff before declaring failure.

### F3 — Mode contract becomes prompt-bloat

| # | Q | A |
|---|---|---|
| 1 | What if every change tries to invoke recall_first? | Trivial conversational turns ("what does this function do?") don't need the contract — recall + verify add latency for no benefit. |
| 2 | Risk of always-on? | LLM either ignores the mode (Chain F1 again) or wastes tokens on premature stores. |
| 3 | Mitigation? | Mode declaration explicitly states `do_not_use_when` — same pattern as existing contracts (`velixar_context`, `velixar_search`). The workflow prompt also includes a "When NOT to use" section. |
| 4 | Default? | OPT-IN per task. The agent decides whether the work qualifies for stewardship. Some workspaces (the velixar-internal one) can opt-default-on via `.velixar.json`, but that's a workspace decision, not a global mandate. |

→ **Hardening row R3:** Workflow prompt includes explicit `do_not_use_when` and `use_when` clauses; default is opt-in per task; per-workspace default overrides via `.velixar.json:default_mode`.

### F4 — Store-then-verify loop introduces token bloat / cost

| # | Q | A |
|---|---|---|
| 1 | How much extra token cost per stewarded change? | Recall: ~1 search call (small), Persist: 1 store (the work product, sized regardless), Verify: 1 search returning ≤2 results. Total: 3 small tool calls per change. |
| 2 | At scale? | A heavy session shipping 10 stewarded changes adds ~30 tool calls. Each is a few hundred tokens. ~5K-10K extra tokens per session — small relative to the work itself. |
| 3 | Net? | Acceptable. The cost of *missing* a store (one of the 2026-04-30 in-session failures) is way higher than the cost of the verify probe. |

→ **Hardening row R4:** Cost is acceptable; no mitigation needed beyond the `do_not_use_when` filter.

### F5 — `velixar_act` tool would break compositionality

| # | Q | A |
|---|---|---|
| 1 | If `velixar_act` becomes the only blessed change-storage path, does it break tools that legitimately want to store without orchestration? | Yes — would force every legitimate store through the wrapper, even one-shot batch ingest tools, harness tooling, etc. |
| 2 | Mitigation? | `velixar_store` stays as a primitive. `velixar_act` is the *workflow* tool for stewarded changes. The CI/lint side of the contract goes only as far as documentation — we don't ban raw `velixar_store` (it has legitimate non-stewardship uses). |
| 3 | What do we ban? | Nothing structurally. The discipline is enforced *for stewardship work* via the workflow prompt; raw stores remain valid for batch import, harness tools, etc. |

→ **Hardening row R5:** `velixar_act` orchestrates; `velixar_store` stays raw. No CI gate banning raw stores.

### F6 — Workflow prompt drifts from `tool-contracts.json` mode definition

| # | Q | A |
|---|---|---|
| 1 | What if the prompt and the contract disagree about what "Stewardship" means? | Confusion + LLM may get conflicting guidance. |
| 2 | Mitigation? | `COGNITIVE_MODES` array in `prompts.ts` is already the documented S7 source-of-truth. Add a test that asserts the contract entries reference modes that exist in `COGNITIVE_MODES`. Catches drift at CI. |

→ **Hardening row R6:** CI test asserts contract↔mode consistency.

### F7 — Recall-first becomes performative

| # | Q | A |
|---|---|---|
| 1 | What if LLM does the recall but ignores its findings? | The whole point of recall is to surface conflicts before acting. If the LLM queries memory and then proceeds against what it found, the rule is theater. |
| 2 | Why might that happen? | The recall returned something subtle the LLM dismissed; the LLM treated recall as a checkbox; the LLM optimized for completing the task over respecting prior decisions. |
| 3 | Mitigation? | Workflow prompt requires the LLM to **explicitly cite** at least one recalled fact (or explicitly assert "no relevant prior context found") before proceeding to Act. Forces the LLM to engage with the recall, not just perform it. |
| 4 | Verification? | The persist step's stored memory should reference the recalled context, creating a lineage trail. Future sessions can audit whether stewardship was honored or performed. |

→ **Hardening row R7:** Workflow prompt requires explicit citation of recalled context (or explicit assertion of no relevant context) in the Act phase. Stored memory references the recall lineage.

## 5. Implementation plan

### Step 1 — Add `Stewardship` mode (this PR)

`src/prompts.ts:COGNITIVE_MODES` — append:
```ts
{ mode: 'Stewardship', question: '"Will future sessions need this work?"', tool: 'velixar_store' }
```

Until `velixar_act` ships (Section 6), the first-tool entry points at `velixar_store` — the LLM is expected to follow the `recall_first` workflow prompt around it.

### Step 2 — Add `recall_first` workflow prompt (this PR)

`src/prompts.ts` — new `WorkflowPrompt` named `recall_first`. Content describes:
- Trigger: any non-trivial code change, decision, design doc, or work future sessions need
- 4-phase contract (recall → act → persist → verify)
- Required: cite at least one recalled fact in the act phase (R7)
- Required: verify via `velixar_search` (distinctive phrase) or `velixar_inspect` (by ID) — never KG (R2)
- Required: store sequentially, never parallel (documented batch-store failure)
- `do_not_use_when`: trivial lookups, conversational turns, pure read-only commands (R3)

### Step 3 — Add contract entry to `tool-contracts.json` (this PR)

```json
"velixar_act": {
  "cognitive_mode": "stewardship",
  "use_when": "non-trivial change that future sessions will need to know about",
  "do_not_use_when": "trivial lookups, conversational turns, pure read-only commands",
  "disambiguate_from": ["velixar_store"],
  "signal_words": ["recall first", "stewardship", "verify after", "remember this for next time"]
}
```

The contract is forward-declared — points to a tool that doesn't exist yet (`velixar_act`). Acceptable because tool-contracts.json is documentation; the contract reads naturally even when the tool is "coming soon" and the workflow prompt covers the manual path until then.

### Step 4 — Tests (this PR)

`tests/test_recall_first.test.js`:
- `Stewardship` is in `COGNITIVE_MODES`
- `recall_first` workflow prompt exists, has all required phases mentioned
- Workflow prompt content includes `velixar_search` AND `velixar_inspect` (R2)
- Workflow prompt content includes "sequentially" (R5: parallel-store ban)
- Workflow prompt content includes "do not use" / "trivial" guidance (R3)
- Contract entry references a mode that exists (R6)

### Step 5 — Workspace default surfacing (this PR)

`.velixar.json` schema gets a new optional field `default_mode`. When set to `"stewardship"`, the MCP server's `cognitive_constitution` resource highlights it as the default for the workspace. The velixar-internal workspace can opt in.

### Step 6 — Server-enforced `velixar_act` tool (FOLLOW-UP, separate task)

The advisory→enforced transition. Backend route + MCP tool wrapper that:
1. Receives the intent string
2. Returns the recalled context
3. Caller does the work
4. Server-side store with auto-verify; throws `StoreVerificationFailed` if the read-back fails

Out of scope for this PR. Tracked as `velixar_act-server-enforcement.md` follow-up.

## 6. Acceptance criteria

- [ ] `Stewardship` mode appears in `COGNITIVE_MODES` and rendered in `velixar://constitution` resource
- [ ] `recall_first` workflow prompt is registered and includes all 4 phases
- [ ] `tool-contracts.json` has the contract entry
- [ ] All R1-R7 hardening rows reflected in prompt content or test
- [ ] CI test asserts contract↔mode consistency
- [ ] All existing MCP server tests still green
- [ ] Documentation in this file is the canonical source for the workflow

## 7. Out of scope (follow-ups)

- `velixar_act` server-enforced wrapper (Section 5, Step 6) — own task
- `.velixar.json:default_mode` — handled in Step 5 of this PR but client-side adoption per workspace is its own roll-out
- Updating Velixar's `cognitive_constitution` prompt to reference `Stewardship` in the recommended-workflow examples — included in this PR's prompt edits
