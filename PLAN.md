## Canonical Source & Evidence Quorum Plan

### Context
We need to add deterministic authority handling, canonical GitHub repo resolution, gating, and UI enhancements without rewriting the entire search/execution stack. Breaking the work into smaller deliverables keeps changes manageable and testable.

### Phase 1 – Authority foundation
1. Extend shared types to support granular `sourceKind`, `sourceTier`, eligibility flags, and gate metadata.
2. Implement `src/main/executor/authority.ts` with host normalization, host classification, GitHub scoring, and canonical selection logic plus helper exports.
3. Update the summarizer to rely on the new authority helpers when determining eligible sources so the gate can inspect membership consistently.

### Phase 2 – Canonical GitHub & gating integration
1. Update `ActionExecutor` to parse GitHub repo candidates, run canonical detection, mark previews/evidence appropriately, and discard non-canonical repos.
2. Ensure SERP/search previews are classified as `search_results` with tier D and never eligible.
3. Add gating logic inside `ExecutorRunner` (before synthesis) that enforces ≥3 eligible sources, ≥2 hosts, and at least one canonical/official doc; expose gate status in progress payloads.
4. Emit discard reasons in actions/sources so the renderer can list attempts.

### Phase 3 – UI + recovery/testing
1. Enhance renderer tab/action UI to surface kind/tier badges, gate status, and discard reasons per action.
2. Add deterministic recovery actions for missing primary sources if quorum fails (e.g., try official docs, canonical repo README) and reflect their status in progress.
3. Harden synthesizer to assert gate success and prevent ineligible sources from being used, plus add unit tests for GitHub scoring/canonical selection/quorum gating to guard regression.

### Manual validation
- Run the “Explain OpenClaw…” workflow, confirm 0-star repos are discarded, gate prevents synthesis without canonicals, and the UI lists discard reasons.

