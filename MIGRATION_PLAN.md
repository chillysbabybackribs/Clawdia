# Phase Migration Plan (Router → Planner → Executor)

## Current Flow Analysis
- **Call chain (IPC.CHAT_SEND → research)**
  1. `src/main/main.ts:IPC.CHAT_SEND` handles user submission, appends the user message, fetches API key, and instantiates `Intake`.
  2. `src/main/llm/intake.ts:Intake.process` runs `heuristicRoute` on just the latest user message; `chat` and `browse` heuristics short-circuit to those routes, while everything else lands in `llmIntake`.
  3. `llmIntake` drives an LLM call (same prompt as future Router) that returns `route` plus a `TaskSpec`, then normalizes actions, success criteria, and deliverable schema before returning to `main.ts`.
  4. `main.ts` switches on the route: `handleChatRoute`, `handleBrowseRoute`, or `handleResearchRoute` (planner/executor testify inside the latter).
- **Intake responsibilities to split**
  - `heuristicRoute`, `URL_PATTERN`, `BROWSE_VERBS`, etc. (classification logic) → Router.
  - `INTAKE_PROMPT`, LLM call + JSON parsing → Router for classification + future planner signals.
  - `validateTaskSpec` (sanitizing queries, targeted OpenClaw injections, budgets, fallback search) → Planner.
- **Shared data structures to introduce**
  - `RouterContext` (optionally contains a conversation slice, defaults to latest user message).
  - `RouteDecision` / `RouterResult` (includes route, confidence, reasoning, optional raw TaskSpec payload).
  - `TaskSpecV2` and version metadata (Phase 2 will extend the schema), but for now the shared `TaskSpec` interface remains; we will version in shared types and permit backwards compatibility wrappers.

## Phase 0 — Scaffolding (no behavior change)
- **Goals**: Provide structure for Router/Planner/Executor split without altering behavior; keep `Intake` as legacy passtrough.
- **Files**:
  - `src/shared/types.ts`: add `RouterContext`, `RouteDecision`, `TaskSpecVersion` placeholders; keep `TaskSpec` as is (Phase 2 will extend).
  - `src/main/llm/router.ts`: new module to house heuristics, prompts, and Router class; initially mirrors current `Intake` logic.
  - `src/main/llm/intake.ts`: reduce to a thin façade that re-exports Router for now (keeps existing import paths intact until Phase 4).
  - `vitest` test files: create `src/main/llm/__tests__/router.spec.ts` for router heuristics/sampling.
- **Interfaces**:
  - `RouterContext` (optional `messages: Message[]`, `latestMessage: string`), default to latest message only.
  - `RouteDecision` (route, confidence, reasoning, optional `TaskSpec` payload for research) returned by Router.
- **Tests**:
  - Router heuristic unit tests verifying `heuristicRoute` yields chat/browse/research for representative prompts.
  - Lightweight integration test comparing Router output to current Intake expectations for short prompts, explicit URLs, research keywords, and OpenClaw targeted injection.
- **Success criteria**:
  - No behavior/regression change when replacing `Intake` with Router in `main.ts`.
  - Tests pass (existing + newly added ones).
- **Risks**:
  - Duplicate logic between Intake/Router if not carefully refactored; mitigate by leaving Intake as façade.
  - Tests requiring Anthropic mock; design Router with injectable client.
- **Rollback**: revert commit; existing `Intake` file untouched.

## Phase 1 — Router extraction + wiring into CHAT_SEND
- **Goals**: Router replaces Intake as the entry point for classification, still returning `TaskSpec` for research to preserve behavior.
- **Files to change**:
  - `src/main/main.ts`: import `Router`, instantiate once per request, remove `Intake` usage.
  - `src/main/llm/router.ts`: ensure it exports the same `IntakeResult` shape, uses heuristics/LLM exactly, and exposes `RouterContext` for future enhancements.
  - `src/main/llm/intake.ts`: keep as a compatibility wrapper re-exporting Router until Phase 4 deletion.
- **Interfaces**:
  - `Router.classify(context: RouterContext): Promise<RouteDecision>` keeps returning `TaskSpec` and route.
  - `RouteDecision` includes `taskSpec?: TaskSpec` to avoid refitting `handleResearchRoute` yet.
- **Tests**:
  - Router unit tests (existing from Phase 0). Add integration harness verifying that Router yields identical results for the four key prompts.
- **Success criteria**:
  - Chat/browse/research behavior is statistically identical; no extra warnings.
  - Router is now the place for classification logic, paving the way for Planner extraction.
- **Risks**:
  - Subtle behavior shift if heuristics branch is miswired; mitigate with regression tests.
  - Anthropic call still part of Router; ensure API usage unchanged.
- **Rollback**: revert `main.ts` back to `Intake` usage.

## Phase 2 — Planner extraction, TaskSpec.v2, backward compatibility
- **Goals**: Move TaskSpec creation off the router, version the schema, and enable iterative expansion when the evidence gate fails.
- **Files**:\n  - `src/shared/types.ts`: add `TaskSpecV2` schema including `phase` markers (`discovery`, `deep_dive`, `gaps`, `synthesis`), `version: number`, and optional `extensions`. Provide type guards that allow accepting both `TaskSpecV1` (legacy) and V2.\n  - `src/main/llm/planner.ts`: new module responsible for `TaskSpec` creation from the Router-decided route; reuses the existing `validateTaskSpec` logic for now but wraps in a `Planner` class. Planner will expose `createPlan(context: RouterContext, raw?: any): TaskSpecV2` with hooks for future iterative expansion.\n  - `src/main/main.ts`: after Router sorts the route, call the Planner to produce `TaskSpec` before `handleResearchRoute`. Preserve existing `TaskSpec`-shaped payload until later phases guarantee V2 adoption.\n  - `src/main/llm/router.ts`: remove `TaskSpec` creation logic once the Planner owns it, but keep backward compatibility (Router can optionally return a preliminary spec when heuristics rely on the old prompt). Possibly have Router hand Planner a raw `Intake` payload.\n+- **Interfaces**:\n  - `Planner.createPlan(context: RouterContext, fallback?: unknown): Promise<TaskSpecV2>` returning a normalized schema with `version: 2` and phases array.\n  - `TaskSpecV2` extends `TaskSpec` with `version` and `phases: Array<{ name: 'discovery'|'deep_dive'|'gaps'|'synthesis'; actions: PlannedAction[] }>` to support future iterative expansion.\n+- **Tests**:\n  - Unit tests for Planner validating `TaskSpecV2` defaults, budget enforcement, and targeted injection.\n  - Regression tests that feed a legacy V1 spec and assert Planner normalizes it into V2 while keeping the old budget semantics.\n+- **Success criteria**:\n  - `handleResearchRoute` still receives budgets/actions identical to prior behavior.\n  - Router no longer owns TaskSpec sanitation logic (moved to Planner).\n+- **Risks**:\n  - Mis-specified type guards dropping actions; add tests.\n  - Additional async path introducing new failure surface; keep Router fallback path intact for now.\n+- **Rollback**: Keep TaskSpec generation inside Router temporarily and restore `main.ts` to call Router directly in research flow.\n 
## Phase 3 — Executor changes (heartbeat removal, deterministic loop)
- **Goals**: Stop relying on the heartbeat LLM, make execution deterministic (coupling to budgets, recovery logic), and surface recovery plans via deterministic heuristics rather than new LLM calls.
- **Files**:\n  - `src/main/executor/runner.ts`: add an `enableHeartbeat` flag (default `false`). When disabled, skip the LLM call, use deterministic decisions (e.g., gate status + budgets) to continue or stop, and reuse `attemptRecovery` without invoking Claude.\n  - `src/main/executor/actions.ts`: ensure deterministic behaviour by reusing follow-up candidates without additional heuristics that require LLM.\n  - `src/main/main.ts`: pass the heartbeat flag (default false) to the Executor to keep API calls down.\n+- **Interfaces**:\n  - `ExecutorRunnerOptions` with `enableHeartbeat?: boolean` and `maxDepth?: number` to control future expansion.\n+- **Tests**:\n  - Executor integration test that runs a small TaskSpec and asserts no heartbeat LLM call is issued when `enableHeartbeat=false`.\n  - Recovery logic unit tests ensuring `attemptRecovery` triggers when the gate fails and respects `remainingActions`.\n+- **Success criteria**:\n  - Research route no longer hits Anthropic for heartbeat by default.\n  - Recovery actions still inserted deterministically when the gate lacks required sources.\n+- **Risks**:\n  - Without heartbeat, the executor might stop too early; we keep gate/retry logic intact for now and monitor via tests.\n  - Removing the heartbeat call could hide a latent dependency; guard with a feature flag.\n+- **Rollback**: Re-enable `enableHeartbeat` flag by default and ensure the LLM call is invoked again.\n 
## Phase 4 — Cleanup / delete Intake logic\n+- **Goals**: Remove the legacy `Intake` class/files and rely solely on Router/Planner/Executor pipeline.\n+- **Files**:\n  - Delete `src/main/llm/intake.ts` entirely.\n  - Update any references (should already point to Router/Planner from earlier phases).\n+- **Tests**:\n  - Resurrect any suppressed Intake regression tests to ensure Router/Planner still behave identically.\n+- **Success criteria**:\n  - No references to `Intake` remain.\n  - Compiler passes without the old file.\n+- **Risks**:\n  - Forgotten import causing runtime errors; rerun `npm run build:main` and `npm run test`.\n+- **Rollback**: Reintroduce `intake.ts` (possibly by copying Router logic back) and revert imports.\nEOF
