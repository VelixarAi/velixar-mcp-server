# Release Gate Checklist

> Reusable per tool, resource, or workflow. All gates must pass before merge.

## Artifact: _______________
## Version: _______________
## Date: _______________

### Gate 1: Contract Compliance
- [ ] Tool/resource matches its contract in TOOL-CONTRACTS.md
- [ ] Input schema matches contract specification
- [ ] Output matches the designated standard output form
- [ ] Layer 3 routing hint present in description

### Gate 2: Schema Compliance
- [ ] Returns `VelixarResponse<T>` envelope
- [ ] All fields match types.ts definitions
- [ ] `absence_reason` populated when `data_absent: true`
- [ ] Naming rules enforced (items, relevance, id, summary)

### Gate 3: Justification Pipeline
- [ ] Synthesized claims carry `JustificationResult`
- [ ] Claim type correctly classified
- [ ] Presentation mode matches claim type × confidence
- [ ] No inferred content presented as retrieved fact

### Gate 4: Workspace Isolation
- [ ] `workspace_id` passed on every API call
- [ ] No cross-workspace data leakage
- [ ] Ambiguous workspace → error, not guess

### Gate 5: Degraded Mode
- [ ] Graceful handling when backend unreachable
- [ ] Cached/stale results returned with staleness warning
- [ ] Error responses use `VelixarError` schema

### Gate 6: Benchmark Thresholds
- [ ] Recall precision @5 ≥ baseline
- [ ] Context Relevance Score ≥ baseline (if applicable)
- [ ] Tool selection accuracy ≥ baseline (if applicable)
- [ ] Token efficiency ≥ baseline (if applicable)

### Gate 7: Documentation
- [ ] Tool description is accurate and complete
- [ ] TOOL-CONTRACTS.md updated if behavior changed
- [ ] CHANGELOG entry added

### Gate 8: No Regressions
- [ ] Existing tools still pass their contracts
- [ ] No new TypeScript compiler errors
- [ ] Build succeeds clean

### Gate 9: Prompt Impact (S3)
- [ ] If API behavior changed: reviewed prompts that reference affected tools (check tool-prompt-matrix.json)
- [ ] If new tool added: added to tool-prompt-matrix.json and referenced in relevant prompts
- [ ] If tool removed: removed from all prompts and tool-prompt-matrix.json
- [ ] Prompt freshness test passes (`node tests/prompt-freshness.test.js`)
- [ ] Prompt integration test passes (`node tests/prompt-integration.test.js`)

## Sign-off
- [ ] All gates passed
- Reviewer: _______________
