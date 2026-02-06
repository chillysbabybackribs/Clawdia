# Parallel Execution Results

Date: 2026-02-06

## Benchmark Run Status

I could not execute the interactive Electron benchmark flow in this environment.

Attempted commands:
- `npm run dev`
- `timeout 30s npm run dev` (elevated)

Observed blockers:
- Renderer dev server bind failure in sandbox (`listen EPERM 127.0.0.1:5173`).
- Then port conflict (`Port 5173 is already in use`) from an existing background Vite process.
- Without a clean app launch + renderer control, the six interactive query timings cannot be captured end-to-end here.

## Baseline (Before)

Source: `docs/audits/PERF_BASELINE.md`

| Query | Baseline (estimated) |
|---|---:|
| What time does Costco close? | 8-10s |
| Go to github.com | 6-8s |
| Compare MacBook Pro vs Dell XPS pricing | 18-25s |
| What's 15% of 340? | 2-3s |
| What happened in AI news today? | 7-10s |
| Multi-part request (tasks 27-32) | Not captured in baseline doc |

## After (This Change Set)

| Query | Post-change measured |
|---|---:|
| What time does Costco close? | Not measured in this environment |
| Go to github.com | Not measured in this environment |
| Compare MacBook Pro vs Dell XPS pricing | Not measured in this environment |
| What's 15% of 340? | Not measured in this environment |
| What happened in AI news today? | Not measured in this environment |
| Multi-part request (tasks 27-32) | Not measured in this environment |

## Verification Completed

- `npm run build` passed.
- `npm test` failed in a pre-existing suite: `search_v2/src/main/pipeline/__tests__/planner.test.ts` (`describe is not defined`).

## Expected Latency Impact from Implemented Changes

- Safe parallel tool scheduling in `tool-loop.ts`:
  - Local/stateless tool calls can run concurrently.
  - Browser state-changing/page-state tools remain serialized.
  - Same-file `file_write` / `file_edit` calls are serialized per normalized path.
- Specialized search fallbacks now run concurrently with `Promise.allSettled`:
  - `searchNews` (Serper + Brave)
  - `searchPlaces` (Serper + SerpAPI)
- Prompt-build cache TTL now 60s (instead of day-level keying).
- API connection warm-up now centralized and parallelized via `Promise.allSettled` with timeout.

## How to Capture Final Numbers Locally

1. Ensure no stale dev processes own port 5173.
2. Start app: `npm run dev`.
3. Open DevTools in the app and filter logs by `[Perf]`.
4. Run the 6 benchmark prompts and record `[Perf] Total wall time` for each.
