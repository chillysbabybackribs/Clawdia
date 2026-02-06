# Implementation Diff Specification

## Commit 1 — Phase 0 scaffolding
- **Objective**: Introduce the Router module, move heuristics/constants, and add regression tests without altering existing flows.
- **Changes**:
  - Add `src/main/llm/router.ts` containing heuristics, prompt, LLM parsing, and Router class (mirrors current Intake behavior).
  - Keep `src/main/llm/intake.ts` as a thin façade (exporting `Router` or delegating) so existing imports stay valid.
  - Add `src/main/llm/__tests__/router.spec.ts` with router heuristics/unit tests and the integration harness for representative prompts.
  - Update `tsconfig.main.json` / vitest config if needed to include new test files.
- **Done when**:
  - `npm run test` passes (including new Router tests).
  - No changes to `main.ts` logic yet (Router module unused beyond tests).

## Commit 2 — Phase 1 integration
- **Objective**: Wire Router into `IPC.CHAT_SEND`, replacing `Intake` usage while keeping behavior unchanged.
- **Changes**:
  - Replace `Intake` instantiation in `src/main/main.ts` with `Router`, adjust imports, and rename variables for clarity.
  - Ensure `Router.classify` returns the same shape as the previous `Intake.process`, so `handleResearchRoute` remains untouched.
  - Update any type imports (`RouteType`, `TaskSpec`) if routed through Router.
  - Run existing tests to ensure no regressions.
- **Done when**:
  - `npm run build:main` succeeds.
  - `npm run test` passes unchanged.
  - Router module is now the sole owner of classification logic.

## Future commits (Phase 2+)
- While not in scope for this increment, future commits should follow a similar small-commit approach:
  1. Introduce Planner module / TaskSpec.v2 (phase 2).
  2. Refactor Executor to remove heartbeat dependency (phase 3).
  3. Delete Intake and clean up references (phase 4).
- Each commit should include targeted tests and “Done when” criteria before moving to the next phase.
