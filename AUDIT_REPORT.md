# Clawdia App State Audit (Current Repository Snapshot)

Audit date: 2026-02-06  
Repo root: `/home/dp/Desktop/clawdia`  
Scope result: this repo is a single Electron app. There is **no Docker runtime/orchestrator subsystem present in current source**.

## Executive Summary
Clawdia is an Electron desktop app that combines:
- a renderer chat UI (`src/renderer/*`),
- a main process orchestration layer (`src/main/*`),
- browser automation via Electron `BrowserView` + Playwright CDP wrapping (`src/main/browser/*`),
- LLM/tool loop via Anthropic (`src/main/llm/*`),
- local system tools with unrestricted shell/file/process access (`src/main/local/tools.ts`),
- search backends (Serper/Brave/SerpAPI/Bing + Playwright fallback) (`src/main/search/backends.ts`).

What works now:
- Build succeeds: `npm run build`.
- Core tests pass (but only 6 tests, all in `search_v2` helper logic): `npm test`.
- Main flow (setup API key -> chat -> tools -> streamed response) is implemented and wired through IPC.

What is fragile now:
- Security posture is permissive by design: main window sandbox disabled (`src/main/main.ts:209-214`), Linux `--no-sandbox` and `ELECTRON_DISABLE_SANDBOX` set (`src/main/main.ts:1-4`, `src/main/main.ts:46-49`), unrestricted shell/file tools (`src/main/local/tools.ts:17-39`, `src/main/local/tools.ts:184-204`).
- Secrets are stored with a hardcoded `electron-store` encryption key (`src/main/store.ts:33-41`), which is obfuscation-grade, not strong secret protection.
- `search_v2` branch is partially stale/non-buildable (`npm run build:searchv2` fails TS18003 due config).
- Requested “Start Runtime / Docker compose / mounts / containers” flow is **NOT PRESENT** in this codebase.

## Architecture Diagram
```text
Renderer (DOM/Vite)
  src/renderer/index.html + src/renderer/main.ts
        |
        | contextBridge (preload API)
        v
Preload
  src/main/preload.ts
        |
        | ipcRenderer.invoke / ipcMain.handle
        v
Main Process
  src/main/main.ts
    |- Conversation state (electron-store): src/main/store.ts, src/main/llm/conversation.ts
    |- LLM/tool orchestration: src/main/llm/client.ts + src/main/llm/tool-loop.ts
    |- Browser subsystem: src/main/browser/manager.ts + src/main/browser/tools.ts
    |- Local tools: src/main/local/tools.ts
    |- Docs extract/create: src/main/documents/*

External boundaries:
- Anthropic API (messages endpoint)
- Search APIs (Serper, Brave, SerpAPI, Bing)
- Local OS shell/files/processes
- Chromium CDP localhost port (9222-9227 candidate)
```

## Repo Map
| Area | Purpose | Key files |
|---|---|---|
| `src/main` | Electron main process, IPC handlers, orchestration | `src/main/main.ts`, `src/main/preload.ts`, `src/main/store.ts` |
| `src/main/browser` | BrowserView lifecycle + Playwright tool actions | `src/main/browser/manager.ts`, `src/main/browser/tools.ts`, `src/main/browser/popup-dismissal.ts` |
| `src/main/llm` | Anthropic client, tool loop, prompts, stream interception | `src/main/llm/client.ts`, `src/main/llm/tool-loop.ts`, `src/main/llm/system-prompt.ts` |
| `src/main/local` | Unrestricted local execution tools | `src/main/local/tools.ts` |
| `src/main/search` | Search backend selection/fallback/cache | `src/main/search/backends.ts` |
| `src/main/documents` | Document extraction and generated-file output | `src/main/documents/extractor.ts`, `src/main/documents/creator.ts` |
| `src/renderer` | UI shell, setup/settings/chat/browser panel | `src/renderer/index.html`, `src/renderer/main.ts`, `src/renderer/styles.css` |
| `src/shared` | IPC names and shared types/models | `src/shared/ipc-channels.ts`, `src/shared/types.ts`, `src/shared/models.ts` |
| `search_v2` | Experimental/alternate search pipeline branch | `search_v2/src/main/*`, `search_v2/main/handler.ts`, `search_v2/tsconfig.json` |
| `.github/workflows` | Tag-triggered packaging/release workflow | `.github/workflows/build.yml` |
| `build` | Electron packaging hooks/resources | `build/afterPack.js` |

## Core Flows
### 1) Onboarding/setup flow
1. Renderer checks completion flag: `window.api.hasCompletedSetup()` in `src/renderer/main.ts:856-860`.
2. If false, setup view is shown: `src/renderer/main.ts:776-797`.
3. User enters API key -> validate with selected model: `src/renderer/main.ts:910-929` calling `IPC.API_KEY_VALIDATE`.
4. Main validates via Anthropic `messages` call: `src/main/main.ts:143-191`, wired at `src/main/main.ts:359-365`.
5. On success, key+model persisted: `src/renderer/main.ts:931-934` -> `IPC.API_KEY_SET` + `IPC.MODEL_SET` handled in `src/main/main.ts:343-349`, `src/main/main.ts:369-376`.

### 2) Chat send -> tool loop -> stream
1. Renderer `sendMessage()` assembles text/images/docs: `src/renderer/main.ts:2560-2637`.
2. IPC call `chat:send`: preload `src/main/preload.ts:13-15`, handler `src/main/main.ts:251-305`.
3. Main constructs `ToolLoop` and runs it: `src/main/main.ts:266-285`.
4. Tool loop builds prompt/history, calls Anthropic streaming API: `src/main/llm/tool-loop.ts:386-507`, `src/main/llm/client.ts:55-179`.
5. Tool calls extracted/executed (browser + local), then fed back into next iteration: `src/main/llm/tool-loop.ts:495-582`.
6. Streamed chunks/events sent to renderer via IPC events: `src/main/llm/tool-loop.ts:889-907`.
7. Renderer updates UI on stream/text/end/error: `src/renderer/main.ts:1269-1284`, `src/renderer/main.ts:2785-2824`.

### 3) Browser panel control flow
1. Renderer browser controls call preload API (`browserNavigate`, tabs, history/clear): `src/main/preload.ts:91-115`.
2. Main browser IPC handlers in `setupBrowserIpc()`: `src/main/browser/manager.ts:674-748`.
3. BrowserView navigation and tab state updates: `src/main/browser/manager.ts:470-550`, events emitted at `src/main/browser/manager.ts:212-253`.
4. Playwright CDP wraps active BrowserView target for tool actions: `src/main/browser/manager.ts:428-464`, `src/main/browser/manager.ts:758-761`.

### 4) Settings/config save flow
1. Renderer settings modal load and save: `src/renderer/main.ts:1005-1019`, `src/renderer/main.ts:1103-1119`.
2. IPC `settings:get` / `settings:set`: handled in `src/main/main.ts:378-400`.
3. Source-of-truth is `electron-store` in main process (`src/main/store.ts:33-41`).

### 5) Document attach/analyze/create flow
1. Renderer extracts document text before send: `src/renderer/main.ts:2106+`, state checks at `src/renderer/main.ts:2567-2608`.
2. Main extraction IPC: `src/main/main.ts:418-426` -> `src/main/documents/extractor.ts:62-81`.
3. LLM can create downloadable files via `create_document` tool; event relayed to renderer: `src/main/llm/tool-loop.ts:558-569`, render card at `src/renderer/main.ts:2698+`.
4. File creation output folder is `~/Documents/Clawdia`: `src/main/documents/creator.ts:7`, `src/main/documents/creator.ts:485-521`.

## Runtime Orchestration Deep Dive
### Requested “Start Runtime” / Docker compose / mounts path
Status: **NOT FOUND in this repository**.

Evidence:
- No docker compose files at root.
- No runtime start/stop IPC routes for container orchestration.
- Search for compose/docker/start-runtime in source found no orchestration implementation.

What exists instead:
- App runtime is Electron process + BrowserView + Playwright CDP connection.
- CDP port chosen from `[9222..9227]` via `ss` check in `src/main/main.ts:24-43`.
- Playwright initializes on window ready: `src/main/main.ts:233-238`, `src/main/browser/manager.ts:428-464`.

UNKNOWN items (inspect next):
- If another branch/repo contains container runtime manager, inspect that branch and any external service repo.
- If this repo previously had runtime code, inspect git history around deleted `src/main/executor/*` and runtime docs references.

### Lifecycle and idempotency (current app)
- Start: single-instance lock enforced (`src/main/main.ts:454-463`), app boot wires IPC and browser (`src/main/main.ts:466-480`).
- Stop: `window-all-closed` quit on non-mac (`src/main/main.ts:483-487`), SIGTERM/SIGINT close browser first (`src/main/main.ts:498-507`).
- Browser cleanup is best-effort and idempotent (`src/main/browser/manager.ts:785-800`).

### Logging/telemetry/debug surfaces
- Extensive `console.log`/`console.warn` in main/tool loop/browser manager.
- Browser errors forwarded to renderer only as console error (not user-visible banner): `src/renderer/main.ts:1441-1443`.
- No structured telemetry sink, no tracing IDs, no persistent app logs file path explicitly managed.

## Security Deep Dive
### Threat model (practical)
Attacker capabilities relevant to this architecture:
- Local malware or local unprivileged process on same machine.
- Prompt-injection from untrusted web content visited by automated browser.
- Malicious instructions through user prompts or model misalignment.
- Compromised dependency/build artifacts.

### Process and sandbox boundaries
- Main BrowserWindow has `contextIsolation: true`, `nodeIntegration: false`, but `sandbox: false` (`src/main/main.ts:209-214`).
- On Linux, Chromium sandbox is explicitly disabled with env + flags (`src/main/main.ts:1-4`, `src/main/main.ts:46-49`).
- BrowserView itself is created with `sandbox: true` (`src/main/browser/manager.ts:194-200`), but renderer/main process still hold powerful IPC bridge.

### Secrets handling
- API/search keys stored in `electron-store` schema (`src/main/store.ts:16-41`).
- “Encryption” key is hardcoded literal `clawdia-local-key` (`src/main/store.ts:34`), so any local attacker with code access can decrypt stored values.
- UI masks keys in settings response (`src/main/main.ts:378-388`) but raw keys still used in memory and outbound headers (`src/main/main.ts:152-158`, `src/main/search/backends.ts:29-34`, etc.).

### Filesystem scoping
- No allowlist / no `allowedPaths` enforcement in local tools.
- Relative paths resolve to user home, not repo root (`src/main/local/tools.ts:521-530`).
- `shell_exec` can run arbitrary command with inherited env and user-level filesystem/network access (`src/main/local/tools.ts:184-204`).

### Network exposure
- Dev renderer permits `unsafe-inline`, `unsafe-eval`, and localhost wildcards in CSP in `index.html` (`src/renderer/index.html:6-8`).
- CDP remote debugging enabled on a local port (`src/main/main.ts:45`, `src/main/browser/manager.ts:318-323`).
- External calls: Anthropic + multiple search APIs over HTTPS.
- No app-level auth tokens for IPC boundary (trusted local renderer/preload model).

### Sandboxing claims verification
- Claim “everything local/secure” is only partially true.
- Browser data and sessions are local, but privilege boundaries are intentionally weak (full local tools + disabled Linux sandbox + permissive CSP + hardcoded store key).

## Top Risks (Ranked)
| Rank | Risk | Severity | Likelihood | Blast Radius | Evidence |
|---|---|---|---|---|---|
| 1 | Arbitrary local command/file execution available to model (`shell_exec`, `file_write`, etc.) | Critical | High | Full user account compromise/data loss | `src/main/local/tools.ts:17-39`, `src/main/local/tools.ts:184-204` |
| 2 | Linux Chromium sandbox disabled globally | High | Medium | Browser exploit -> stronger local impact | `src/main/main.ts:1-4`, `src/main/main.ts:46-49`, `build/afterPack.js:5-13` |
| 3 | Stored API keys protected with hardcoded reversible key | High | Medium | Secret disclosure (all configured providers) | `src/main/store.ts:33-41` |
| 4 | `search_v2` path is broken/stale but still present in scripts/docs, increasing maintenance confusion | Medium | High | Dev friction, false confidence, dead code paths | `search_v2/tsconfig.json`, build error TS18003 |
| 5 | Browser/tool errors inconsistently surfaced to user (some only console) | Medium | Medium | Silent failures, hard-to-debug support incidents | `src/renderer/main.ts:1441-1443`, `src/main/browser/manager.ts:251-253` |
| 6 | CSP in renderer includes `unsafe-inline` + `unsafe-eval` and localhost wildcards | Medium | Medium | Increased XSS/script-injection impact | `src/renderer/index.html:6-8` |
| 7 | Test coverage almost entirely excludes production-critical main/renderer/tool paths | Medium | High | Regressions ship unnoticed | `vitest.config.ts`, test files only under `search_v2` |

## Known Bugs / Sharp Edges (with repro)
1. `search_v2` build target broken.
- Repro: run `npm run build:searchv2`.
- Actual: `TS18003 No inputs were found`.
- Evidence: `search_v2/tsconfig.json` include/exclude interaction with root config.

2. Relative local tool paths resolve to `$HOME`, not project cwd.
- Repro in app prompt: ask tool to `file_write` path `README.tmp`.
- Actual: writes `~/README.tmp` (or equivalent), not repo-local.
- Evidence: `resolvePath()` in `src/main/local/tools.ts:521-530`.

3. Browser navigation errors are not shown as user-visible in-chat errors.
- Repro: navigate to invalid/unreachable URL via browser bar.
- Actual: renderer logs console error only.
- Evidence: `src/main/browser/manager.ts:251-253`, `src/renderer/main.ts:1441-1443`.

4. `search_v2` code references missing browser pool implementation.
- Repro: inspect `search_v2/src/main/handler.ts` requiring `../../main/browser/pool`.
- Actual: `src/main/browser/pool.ts` does not exist in current tree.
- Evidence: `search_v2/src/main/handler.ts:14`, folder listing of `src/main/browser`.

5. Store migration is single-key focused; no schema versioning framework.
- Repro: introduce any future breaking store shape change.
- Actual: ad hoc migration risks for forward compatibility.
- Evidence: `src/main/store.ts:43-59` only migrates legacy `anthropic_api_key`.

## Code Health & Maintainability
- Type safety: `strict: true` enabled (`tsconfig.json`), but several `any` seams remain (`search_v2`, some IPC callback payloads).
- God files:
  - `src/renderer/main.ts` is very large and multi-responsibility (UI state, setup, tabs, settings, browser controls, markdown rendering, attachment pipeline).
  - `src/main/main.ts` concentrates boot, IPC, settings, validation, lifecycle.
- Duplication/stale branches:
  - `search_v2/main/handler.ts` and `search_v2/src/main/handler.ts` coexist.
  - Planning docs mention modules not present in current `src/main` layout.
- Determinism:
  - Tool loop behavior includes heuristics, retries, and LLM-driven tool calls; hard to deterministically regression-test without golden harness.
- Tests:
  - Only 2 files / 6 tests, all in `search_v2` helper logic.
  - No integration tests for IPC, browser manager lifecycle, local tool safety, or setup/chat flows.

## Developer Operations
### Clean-machine local run
1. Install Node (recommend Node 20 to match CI: `.github/workflows/build.yml:13-16`).
2. Install deps: `npm ci` (or `npm install`).
3. Run dev app: `npm run dev`.
4. First launch flow requires Anthropic key via setup UI.

### Build/test commands
- `npm test` -> vitest.
- `npm run build` -> main + renderer production build.
- `npm run build:searchv2` currently fails (see known bug).
- Packaging:
  - `npm run dist:linux`
  - `npm run dist:mac`
  - `npm run dist:win`

### CI pipeline
- Single workflow: `.github/workflows/build.yml`.
- Trigger: tag push `v*` only.
- Jobs build linux/mac/windows artifacts and draft release.
- No CI job for PR/unit test gates on normal branch pushes.

### Release packaging
- Electron Builder targets configured in `package.json` build section.
- Linux: AppImage + deb.
- macOS: dmg.
- Windows: nsis installer + portable exe.
- Linux packaging removes `chrome-sandbox` in post-pack step (`build/afterPack.js:5-13`).

## Quick Wins (1-2 Days)
1. Add runtime-safe guardrails for local tools.
- Add allowlist roots and explicit confirmation gate for destructive shell/file patterns.
- Files: `src/main/local/tools.ts`, `src/main/llm/tool-loop.ts`, `src/main/llm/system-prompt.ts`.

2. Make error surfacing consistent.
- Forward browser/tool failures to visible renderer UI (not only console).
- Files: `src/main/browser/manager.ts`, `src/renderer/main.ts`, `src/shared/ipc-channels.ts`.

3. Fix or remove `search_v2` from active scripts.
- Either repair tsconfig + wiring or deprecate scripts/docs to reduce confusion.
- Files: `search_v2/tsconfig.json`, `package.json`, docs references.

4. Add schema versioning in store.
- Introduce `schemaVersion` and explicit migration steps.
- Files: `src/main/store.ts`.

## Next 10 Commits (Small, Mergeable)
1. Goal: Stabilize build matrix by removing broken target noise.
- Files: `package.json`, `search_v2/tsconfig.json`.
- Acceptance: `npm run build`, `npm test`, and either fixed `npm run build:searchv2` or removed script.

2. Goal: Introduce explicit store schema version.
- Files: `src/main/store.ts`.
- Acceptance: migration runs once; existing user store still loads.

3. Goal: Add structured app logger utility with log levels.
- Files: `src/main/main.ts`, `src/main/browser/manager.ts`, `src/main/llm/tool-loop.ts`, new `src/main/log.ts`.
- Acceptance: key lifecycle/errors logged with consistent format.

4. Goal: Surface browser errors to user UI.
- Files: `src/shared/ipc-channels.ts`, `src/main/browser/manager.ts`, `src/renderer/main.ts`.
- Acceptance: failed navigation displays user-visible error component.

5. Goal: Restrict dangerous local tool operations by policy.
- Files: `src/main/local/tools.ts`.
- Acceptance: blocked commands/paths return explicit policy error; non-destructive commands still work.

6. Goal: Add IPC input validation wrappers.
- Files: `src/main/main.ts`, `src/main/preload.ts`, `src/shared/types.ts`.
- Acceptance: invalid payloads rejected predictably without crashes.

7. Goal: Split renderer god file into modules.
- Files: new `src/renderer/*` modules + `src/renderer/main.ts`.
- Acceptance: no functional regression; file size reduced and responsibilities separated.

8. Goal: Add integration tests for setup/chat/settings IPC.
- Files: test harness under `src/main/__tests__` and/or e2e harness.
- Acceptance: tests cover API key validation/save/clear and chat error paths.

9. Goal: Harden CSP for production build profile.
- Files: `src/renderer/index.html`, build config if needed.
- Acceptance: remove unnecessary `unsafe-eval`/localhost allowances in production.

10. Goal: Document real security model and operator warnings.
- Files: `README.md`, in-app README section in `src/renderer/index.html`.
- Acceptance: docs accurately describe current risks and control boundaries.

## Appendix
### Commands used to verify state
- `npm test` -> passed (2 files, 6 tests).
- `npm run build` -> passed.
- `npm run build:searchv2` -> failed (`TS18003`).

### Environment variables observed
- Runtime/boot: `NODE_ENV`, `CLAWDIA_CDP_PORT`, `ELECTRON_DISABLE_SANDBOX`, `ELECTRON_DISABLE_SECURITY_WARNINGS`, `SEARCH_PIPELINE`.
- Dev/install: `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD`.
- Example file: `.env.example` includes `ANTHROPIC_API_KEY`, `SERPER_API_KEY`, `BRAVE_API_KEY`, `SERPAPI_API_KEY`, `BING_API_KEY`, `SEARCH_BACKEND`.

### Ports
- Vite dev server: `5173` (`vite.config.ts`).
- CDP debug port: first free in `9222..9227`, optionally seeded by `CLAWDIA_CDP_PORT` (`src/main/main.ts:40-45`).

### Volumes / containers
- Docker volumes: **NONE FOUND**.
- Container compose generation: **NONE FOUND**.

### Config/state files and locations
- Electron store schema defined in `src/main/store.ts`.
- Exact on-disk electron-store file path: **UNKNOWN** in current code (not explicitly logged).
- Next inspect: add temporary `console.log(store.path)` in main process startup.
- Browser address history in renderer localStorage key: `clawdia.browser.address-history.v1` (`src/renderer/main.ts:133`).
- Generated documents output directory: `~/Documents/Clawdia` (`src/main/documents/creator.ts:7`).

### Commands invoked by app logic (non-exhaustive)
- `ss -tln | grep -qE ':<port>\b'` for CDP port selection (`src/main/main.ts:29`).
- `shell_exec` arbitrary bash command execution (`src/main/local/tools.ts:193-204`).
- Outbound HTTP to Anthropic and search providers from main process.

## Requested Scope Mismatches (Explicit)
1. “Start Runtime” command chain: **UNKNOWN / NOT PRESENT** in current code.
2. Docker compose generation/env injection/volume mounts: **UNKNOWN / NOT PRESENT**.
3. Runtime container lifecycle (start/stop/restart/crash recovery): **UNKNOWN / NOT PRESENT**.

Next places to inspect if this was expected to exist:
- Another branch/repo containing runtime-manager service.
- Historical commits touching docker/runtime keywords.
- External infra scripts not committed in this workspace.
