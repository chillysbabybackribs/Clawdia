# Capability Platform Roadmap

Status date: February 13, 2026.

This document tracks implementation status for the Full-Autonomy Capability Platform plan and defines the remaining execution slices.

## Objectives

- Preserve unrestricted UX by default (no per-command prompts in unrestricted mode).
- Enforce safety through runtime boundaries and deterministic policy invariants.
- Keep capability discovery/install/health behavior observable and self-healing.

## Phase Status

| Phase | Scope | Status |
| --- | --- | --- |
| 0 | Baseline contracts and event schema | Implemented |
| 1 | Capability registry + command resolver | Implemented |
| 2 | Policy engine (allow/rewrite/deny) | Implemented |
| 3 | Container execution plane | Partial |
| 4 | Install/download orchestrator | Implemented |
| 5 | Checkpoint + rollback | Implemented |
| 6 | MCP runtime manager | Implemented |
| 7 | UX + telemetry surfaces | In progress |
| 8 | Hardening + gradual rollout | In progress |

## What Is Implemented

1. Capability lifecycle contracts and normalized event names.
2. Capability registry with command executable mapping and binary availability state.
3. Rewrite-first policy enforcement for high-risk command patterns.
4. Auto-install orchestration for missing capabilities with trust-policy modes and verification hooks.
5. File checkpoint creation and rollback integration for mutation tools.
6. MCP server discovery and runtime health manager with restart/circuit-breaker behavior.
7. Settings UI for capability flags and runtime status inspection.

## Remaining Work Slices

### Slice A: Execution Plane Completion

- Route more execution paths through container runtime (not only `shell_exec`).
- Add explicit mount/network policy templates per autonomy mode.
- Ensure MCP external process launching can be container-routed where supported.

Acceptance:
- Container-enabled mode keeps host writes constrained to allowed mounts.
- Fallback behavior is explicit and logged when container runtime is unavailable.

### Slice B: Install Verification Hardening

- Enforce source policy tiers per ecosystem (`apt`, `npm`, `pip`, direct binary).
- Add checksum/signature verification handling where metadata exists.
- Emit explicit downgrade/fallback events when moving from verified to fallback source.

Acceptance:
- Verification failures produce structured events and deterministic retry/fallback order.

### Slice C: Evidence and Activity UX

- Surface capability lifecycle and evidence summaries directly in activity feed groupings.
- Add error taxonomy labels for install failures, policy denials, runtime fallback, MCP flapping.
- Keep non-blocking renderer updates with bounded event volume.

Acceptance:
- Operators can explain task outcomes from UI without reading raw logs.

### Slice D: Rollout and Guardrail Hardening

- Add feature-flag cohort rollout logic (`internal` -> `beta` -> `default`) with kill switches.
- Add retention/pruning policy for checkpoints and capability audit volume.
- Add adversarial tests for escape attempts, off-scope writes, and credential exfiltration patterns.

Acceptance:
- Security invariants pass under adversarial test suite.
- Warm-path latency remains within budget after hardening.

## Validation Matrix

1. Unit tests:
- policy decisions and rewrite correctness
- capability resolution/install outcomes
- checkpoint eligibility and rollback behavior

2. Integration tests:
- missing binary -> install -> verify -> execute
- MCP crash -> auto-restart -> health recovered
- container unavailable -> host fallback with telemetry

3. Performance:
- cold runtime startup (P95)
- warm task overhead
- event emission overhead under burst load

## Risks To Track

1. Electron + Playwright + container networking edge cases.
2. Supply-chain fallback accidentally downgrading trust silently.
3. Checkpoint storage growth without pruning.
4. MCP tool names colliding without namespacing/versioning.

