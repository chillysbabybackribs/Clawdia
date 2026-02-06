# Parallel Execution Audit

Date: 2026-02-06

## Scope

Reviewed:
- `src/main/llm/tool-loop.ts`
- `src/main/browser/tools.ts`
- `src/main/local/tools.ts`
- `src/main/browser/manager.ts`
- `src/main/llm/client.ts`

## Summary

The codebase already executes *some* tool calls in parallel (`Promise.all` in `tool-loop.ts`), but it does not enforce browser-state safety boundaries and still has several serialized wait chains that increase latency. The largest remaining wins are:
1. Partitioning tool execution into safe parallel groups (local/read-only browser parallel, mutating browser sequential, same-file writes sequential)
2. Running history persistence concurrently with final stream completion
3. Warming external connections and caching dynamic-but-stable prompt generation
4. Parallelizing multi-backend search if current backend fan-out is still sequential

---

## File Findings

### 1) `src/main/llm/tool-loop.ts`

#### Sequential chains found
- `buildSystemPrompt()` is called on every request (`run()`) synchronously before the first API call.
- API/tool loop is intentionally iterative (`for` loop): each model call waits for all tool results before next call.
- Final-response path streams completion then returns; there is no overlap with other independent post-processing work.

#### Existing parallelism
- Tool calls inside a single response are already run with `Promise.all` over `execTasks`.

#### Bottlenecks / risks
- Current `Promise.all` runs *all* tools concurrently, including browser mutating calls (`browser_navigate`, `browser_click`, `browser_type`, `browser_tab`) that share one page/tab state. This is unsafe race-prone parallelism.
- No per-file write serialization: parallel `file_write` / `file_edit` on same path can race.
- If one branch throws unexpectedly outside inner `try/catch`, `Promise.all` can reject the whole batch.
- Text blocks are streamed as they arrive (good), but tool execution uses one batch strategy with no class-based scheduling.

#### Parallelization targets
- Replace monolithic `Promise.all` with a scheduler:
  - local read tools parallel
  - local writes/edit grouped by target path and serialized per path
  - browser mutating tools serialized
  - browser read-only tools parallelizable with local work
- Use `Promise.allSettled` at group boundaries where partial completion is acceptable.
- Preserve original tool-result order by mapping back to request order.

---

### 2) `src/main/browser/tools.ts`

#### Sequential chains found
- `registerPlaywrightSearchFallback()` executes `managerNavigate(...)` then `waitForLoad(...)` then scrape.
- `toolNavigate()` executes `managerNavigate(...)` then `waitForLoad(...)` then `dismissPopups(...)` then snapshot.
- `toolClick()` runs locator attempts sequentially; this is correct because interactions depend on shared page state.
- `toolType()` locator tries are sequential; also correct.

#### Bottlenecks / risks
- Browser tool functions assume exclusive page control; concurrent invocation from tool loop can conflict.
- Search helper usage (`apiSearch`, `searchNews`, `searchShopping`, `searchPlaces`, `searchImages`) may hide sequential backend fan-out depending on implementation in `src/main/search/backends`.

#### Parallelization targets
- Keep mutating browser operations sequential.
- Allow read-only browser operations (`browser_read_page`, `browser_screenshot`) to run concurrently with local tools, but not concurrently with browser mutations.
- Audit backend search fan-out implementation and parallelize provider calls if currently sequential.

---

### 3) `src/main/local/tools.ts`

#### Sequential chains found
- `toolDirectoryTree()` recursion is depth-first and serial (`await` inside loop for each entry and stat call).
- File tools (`toolFileRead`, `toolFileWrite`, `toolFileEdit`) are single-operation and sequential per call.

#### Bottlenecks / risks
- If multiple write/edit calls for the same path are executed in parallel from tool loop, writes can interleave.
- `toolDirectoryTree()` can be optimized with bounded concurrency, but this is lower impact vs tool-loop scheduling.

#### Parallelization targets
- Enforce same-path write serialization in tool-loop scheduler.
- Optional: bounded-concurrency tree walk for large directories (not required for highest-impact latency improvements).

---

### 4) `src/main/browser/manager.ts`

#### Sequential chains found
- CDP connect retries are serial with fixed delay.
- `initPlaywright()` runs connect -> context setup -> binding sequentially.
- Live HTML writes are intentionally serialized.

#### Bottlenecks / risks
- No connection warm-up for external APIs (Anthropic/search providers).
- Browser page lifecycle is shared singleton; browser-mutating tool concurrency is unsafe.

#### Parallelization targets
- Keep browser state operations serialized.
- Add non-blocking warm-up for stable external endpoints at app startup.
- Keep live preview write queue unchanged (required correctness).

---

### 5) `src/main/llm/client.ts`

#### Sequential chains found
- Streaming event loop is single-threaded (`for await`), by design.
- Message conversion is synchronous preflight before request.

#### Existing parallelism / reuse
- Anthropic SDK client is instantiated once per `AnthropicClient` instance (not per request in `chat()`), so per-instance connection reuse exists.

#### Bottlenecks / risks
- If upstream code creates new `AnthropicClient` instances frequently, pooling benefit is reduced (needs callsite verification).
- No explicit transport warm-up on cold start.

#### Parallelization targets
- Ensure app uses singleton/reused `AnthropicClient` instance.
- Add warm-up ping on startup to reduce first-request latency.

---

## Priority Implementation Plan

1. Implement safe parallel tool scheduler in `tool-loop.ts`:
   - classify tool types
   - serialize browser mutators
   - parallelize local/read-only browser calls
   - serialize same-path local writes
   - preserve output order
2. Add system prompt cache with TTL.
3. Add startup connection warm-up (non-blocking).
4. Audit and parallelize multi-backend search fan-out (`src/main/search/backends*`) if sequential.
5. Add efficiency guidance to system prompt for batching file/system shell operations.
6. Overlap final response streaming with history persistence if a persistence step exists.

## Safety Constraints to Preserve

- Browser navigation/mutation tools stay sequential.
- Same-file writes/edits stay sequential.
- Data-dependent operations are not parallelized.
- Tool result ordering to model remains unchanged.
- Partial failure in one backend/tool should not cancel independent work when safe.
