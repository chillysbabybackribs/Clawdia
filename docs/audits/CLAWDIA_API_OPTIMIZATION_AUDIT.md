# Clawdia API Optimization Audit Report
## Date: 2026-02-08

## Executive Summary

Clawdia’s Claude integration is structurally solid: there is a centralized streaming client (`src/main/llm/client.ts`) used by a deterministic tool loop (`src/main/llm/tool-loop.ts`), with local token-saving measures like message-count pruning, history trimming, tool-result compression, and page-content compression. The code also implements Anthropic prompt-caching breakpoints via `cache_control` on (1) the system prompt block, (2) the last tool definition, and (3) the last `tool_result` in history (`src/main/llm/client.ts:76-90`, `src/main/llm/client.ts:228-252`).

The highest-ROI production opportunities found in code are:
1. **True cancellation**: STOP currently only sets a boolean and does not abort the in-flight streaming request (`src/main/llm/tool-loop.ts:522-524`). The Anthropic SDK supports `signal?: AbortSignal` in request options (`node_modules/@anthropic-ai/sdk/core.d.ts:204`), so the app can hard-cancel connections to reduce latency and spend on canceled requests.
2. **Hidden double-LLM-call patterns**: several browser tools call Anthropic again internally (`src/main/browser/tools.ts:453-575`), bypassing the main `RateLimiter` and `usageTracker` accounting and potentially running concurrently with the main tool loop.
3. **Token/memory blind spots and bugs**: history trimming ignores image payload size (`src/main/llm/tool-loop.ts:1427-1461`), and the tool-result truncation helper can exceed its own configured “max in history” limit (`src/main/llm/tool-loop.ts:45`, `src/main/llm/tool-loop.ts:298-306`).

Dollar-cost estimates cannot be computed from “current Anthropic pricing” inside this repo because pricing is not present in code/docs here and this audit run did not perform an internet lookup. The report includes the exact token accounting inputs you already have (per-call `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`) and where to log them for accurate cost calculations (`src/main/llm/client.ts:142-205`).

## Current Architecture Overview

```
Renderer UI
  sendMessage() -> IPC chat:send                         (src/renderer/modules/chat.ts:501)
  stopGeneration() -> IPC chat:stop                      (src/main/preload.ts:40)

Main process
  CHAT_SEND handler                                      (src/main/main.ts:328)
    getClient() -> cached AnthropicClient                (src/main/main.ts:69-79)
    ToolLoop.run(history + attachments)                  (src/main/llm/tool-loop.ts:530)
      - iteration 0 intent route + tool subset           (src/main/llm/tool-loop.ts:642-663)
      - trimHistory (~5000 token char heuristic)         (src/main/llm/tool-loop.ts:1427-1461)
      - compressOldToolResults()                         (src/main/llm/tool-loop.ts:312-383)
      - AnthropicClient.chat(stream=true)                (src/main/llm/tool-loop.ts:685)
        - Anthropic.messages.create(stream=true)         (src/main/llm/client.ts:113-127)
      - tool execution (parallel + browser-seq)          (src/main/llm/tool-loop.ts:1140-1230)
      - append tool_result blocks as user JSON array     (src/main/llm/tool-loop.ts:922-934)
    stream to renderer via IPC_EVENTS.CHAT_STREAM_TEXT   (src/main/llm/tool-loop.ts:1312-1315)
```

## Findings by Category

### 1. Prompt Caching

- Current State
  - System prompt is sent as one system text block with `cache_control: { type: 'ephemeral' }` (`src/main/llm/client.ts:116-123`).
  - Tool definitions are sent every call; only the **last tool definition** gets `cache_control: ephemeral` as a cache breakpoint (`src/main/llm/client.ts:86-90`).
  - The last `tool_result` block in history is mutated to include `cache_control: ephemeral` (`src/main/llm/client.ts:228-252`).
  - ToolLoop builds `systemPrompt` once per `ToolLoop.run()` (stable across iterations within a run) (`src/main/llm/tool-loop.ts:547-555`).

- Cache Hit Rate Estimate (code-based, not measured)
  - Within a multi-iteration tool loop run, the cached prefix is stable and explicitly checkpointed; cache-read fraction should increase on iterations 2+.
  - Across separate user messages, cache reuse is reduced by dynamic content inside the system prompt text (timestamp and accounts) (`src/main/llm/system-prompt.ts:264-277`, `src/main/llm/system-prompt.ts:301-320`).

- Issues Found
  - Dynamic date context includes `now.toISOString()` and is concatenated into the same string as the static prompt (`src/main/llm/system-prompt.ts:264-277`, `src/main/llm/system-prompt.ts:341-344`), which reduces cross-run cache stability.
  - Prompt tier comments are stale vs measured sizes (Appendix A).

- Recommendations
  - Split system prompt into multiple system blocks:
    - Block A: `getStaticPrompt(tier)` with `cache_control: ephemeral`.
    - Block B: `getDynamicPrompt(...)` without `cache_control`.
  - Make date context coarse (date only) unless second-level timestamps are required.

- Estimated Impact
  - Better cache reuse across consecutive user messages; lower input tokens and lower iteration-1 latency when cache hits.

### 2. Model Routing

- Current State
  - Model is user-selected (store key `selectedModel`), default `claude-sonnet-4-20250514` (`src/shared/models.ts:11-38`, `src/shared/models.ts:38`, `src/main/main.ts:88-90`).
  - No dynamic routing by intent, tool-loop phase, or budget.

- Recommendations
  - Add an explicit router layer (configurable) that can choose different models for:
    - Chat-only.
    - Tool-planning iterations.
    - Final synthesis.
  - Log the chosen model per call (already present) and add the route reason for observability (`src/main/llm/client.ts:111`).

- Estimated Impact
  - Cost reduction depends on current Anthropic pricing and chosen routing policy.

### 3. Context Window Management

- Current State
  - Persisted history is pruned by message count: keep last 10 messages by default (`src/main/llm/conversation.ts:17`, `src/main/llm/conversation.ts:103-118`).
  - ToolLoop also trims by a character heuristic: `MAX_HISTORY_TOKENS = 5000` and `CHARS_PER_TOKEN = 4` (`src/main/llm/tool-loop.ts:1427-1461`).
  - Old tool results are truncated, and old screenshot tool results have images stripped from history (`src/main/llm/tool-loop.ts:312-383`).

- Issues Found
  - `trimHistory()` ignores `Message.images` payload size (only counts `msg.content`) (`src/main/llm/tool-loop.ts:1442-1449`, `src/shared/types.ts:44-52`).
  - Tool-result truncation does not respect the configured cap:
    - `MAX_TOOL_RESULT_IN_HISTORY = 1000` (`src/main/llm/tool-loop.ts:45`)
    - `truncateForHistory()` uses a 1400-char head plus 500-char tail (`src/main/llm/tool-loop.ts:298-306`).
  - Documents can be very large:
    - Extractor truncates at 100,000 chars (`src/main/documents/extractor.ts:3-22`).
    - ToolLoop prepends extracted text into the user message (`src/main/llm/tool-loop.ts:571-583`), which can dominate a context budget.

- Recommendations
  - Budget image attachments explicitly in history trimming (e.g., keep at most one image-bearing message, or drop images from older messages before conversion).
  - Fix `truncateForHistory()` to honor `MAX_TOOL_RESULT_IN_HISTORY` (or rename constants to match intended behavior).
  - Add document summarization/chunk-selection before injecting `extractedText`, and store the full extracted text in a local file with a tool-assisted “read section” path.

- Estimated Impact
  - Fewer context spikes; fewer “randomly huge” requests; lower steady-state input tokens on image/doc heavy conversations.

### 4. Tool Definition Optimization

- Current State
  - ToolLoop uses `ALL_TOOLS = browser + local + sequential_thinking` (`src/main/llm/tool-loop.ts:50-53`).
  - On iteration 0 only:
    - `chat-only` can skip tools and use the minimal system prompt (`src/main/llm/tool-loop.ts:642-649`).
    - Otherwise, tool set may be narrowed to “browser-only” or “local-only” (`src/main/llm/tool-loop.ts:651-659`).
  - After iteration 0, ToolLoop always sends `ALL_TOOLS` (`src/main/llm/tool-loop.ts:660-663`).

- Token Cost of Tool Definitions (measured, repo heuristic)
  - Total tools: **29**.
  - JSON size of all tool definitions: **15,333 chars (~3,833 tokens)** (Appendix A).

- Recommendations
  - Persist narrowed tool subsets beyond iteration 0 when safe.
  - Split tools into “always-on” vs “rare” tools and include rare tools only when intent signals require them.
  - Shorten verbose descriptions where possible (directly reduces input tokens whenever tools are included).

- Estimated Impact
  - Thousands of input tokens saved on requests where tools are included unnecessarily, especially the first call of a run.

### 5. Streaming & Latency

- Current State
  - Main chat calls stream (`stream: true`) (`src/main/llm/client.ts:125`) and ToolLoop forwards deltas to the renderer (`src/main/llm/tool-loop.ts:672-684`).
  - Renderer batches DOM updates via `requestAnimationFrame` (`src/renderer/modules/stream.ts:170-205`).

- Issues Found
  - STOP does not abort the streaming HTTP request; it only sets a boolean (`src/main/llm/tool-loop.ts:522-524`).
  - SDK supports `signal?: AbortSignal` (`node_modules/@anthropic-ai/sdk/core.d.ts:204`), but no signal is passed in `AnthropicClient.chat()` (`src/main/llm/client.ts:113-127`).

- Recommendations
  - Add an `AbortController` to `ToolLoop` and pass its `signal` into SDK request options. Abort it in `ToolLoop.abort()` and wire `IPC.CHAT_STOP` to it.

- Estimated Impact
  - Lower tail latency and reduced spend on canceled requests.

### 6. Error Handling & Resilience

- Current State
  - SDK defaults:
    - base URL `https://api.anthropic.com` (`node_modules/@anthropic-ai/sdk/src/index.ts:200-214`)
    - timeout 10 minutes (`node_modules/@anthropic-ai/sdk/src/index.ts:200-214`)
    - maxRetries 2 (`node_modules/@anthropic-ai/sdk/src/index.ts:200-214`, `node_modules/@anthropic-ai/sdk/src/core.ts:197-209`)
  - Key validation uses a real `POST /v1/messages` and handles 401/403 (`src/main/main.ts:156-209`).

- Issues Found
  - No explicit app-level backoff/jitter policy for streaming tool-loop requests; behavior relies on SDK defaults.
  - Connection warmup uses a real `POST /v1/messages` request with `max_tokens: 1` (`src/main/main.ts:128-152`).

- Recommendations
  - Add explicit retry/backoff for transient failures (network, 429/529). Be explicit about what is safe to retry (idempotency concerns once tools have executed).
  - Replace warmup POST with a “handshake-only” warmup (e.g., `HEAD` to the endpoint, expecting 401/405) or keep only base-domain warmup (`src/main/main.ts:117-125`).

### 7. Token Efficiency

- Current State
  - Intermediate tool-planning calls reduce `max_tokens` to 1536 (`src/main/llm/tool-loop.ts:1068-1083`).
  - Page content is compressed before being returned (`src/main/content/compressor.ts:1-12`; used in `src/main/browser/tools.ts:1953-2008`).
  - Old tool results are truncated/stripped (`src/main/llm/tool-loop.ts:312-383`).

- Waste Identified
  - Truncation cap mismatch (`src/main/llm/tool-loop.ts:45`, `src/main/llm/tool-loop.ts:298-306`).
  - Nested Anthropic calls inside tools create “LLM inside LLM” overhead (`src/main/browser/tools.ts:453-575`).

- Recommendations
  - Fix truncation helper.
  - Route nested extraction calls through a cheaper model (router) or remove nested calls and let the main loop do extraction.

### 8. Cost Tracking & Observability

- Current State
  - Per-call tokens are available from streaming events and logged (`src/main/llm/client.ts:142-205`, `src/main/llm/client.ts:209-222`).
  - `usageTracker` counts calls per session and per conversation (not tokens) (`src/main/usage-tracker.ts:18-24`, `src/main/usage-tracker.ts:55-120`).

- Issues Found
  - Nested Anthropic calls in `src/main/browser/tools.ts` are not tracked by `usageTracker` and are not governed by the `RateLimiter` in `src/main/llm/client.ts`.

- Recommendations
  - Track tokens (input/output/cache read/create) per request and aggregate by conversation/session.
  - Ensure nested LLM calls are tracked and rate-limited consistently.
  - Add budget/alerting based on token/cost aggregates.

### 9. Browser Automation Payload Optimization

- Current State
  - `browser_screenshot` uses JPEG quality 60 and viewport-only screenshot (`src/main/browser/tools.ts:1038-1058`).
  - `browser_visual_extract` can take full-page PNG screenshots and send to Anthropic vision (`src/main/browser/tools.ts:1778-1844`).
  - Batch pool screenshots use PNG and can be full-page (`src/main/browser/pool.ts:241-455`).

- Issues Found
  - Full-page PNG screenshots can become large and will be base64-encoded in memory before being sent to Anthropic.

- Recommendations
  - Add explicit max-pixel or max-bytes constraints for full-page screenshots.
  - Default visual extraction to viewport-only unless full page is explicitly required.
  - Consider downscaling before OCR/vision extraction.

### 10. Concurrency & Request Management

- Current State
  - Main tool-loop Claude calls go through `AnthropicClient.chat()` with a `RateLimiter` and `usageTracker` (`src/main/llm/client.ts:92-100`).
  - Several browser tools create new Anthropic clients and call `messages.create()` directly (`src/main/browser/tools.ts:453-575`).

- Issues Found
  - Nested calls bypass the centralized limiter/tracker and can run concurrently with tool-loop calls, making production concurrency/cost control incomplete.

- Recommendations
  - Route nested extraction calls through the centralized client (or a shared subclient) so they share limiter/tracker and cancellation behavior.
  - Optionally disable nested LLM extraction tools by default and rely on the main loop for extraction when feasible.

## Priority Matrix

| Optimization | Effort | Impact | Priority |
|---|---|---|---|
| Abort streaming with `AbortSignal` | Low | High | P0 |
| Fix tool-result truncation cap mismatch | Low | Med | P0 |
| Track + rate-limit nested tool LLM calls | Low/Med | High | P0 |
| Split system prompt into static+dynamic blocks | Low/Med | Med | P1 |
| Budget images in history trimming | Med | Med | P1 |
| Document summarization/chunk selection | Med | High | P1 |
| Persist narrowed tool subsets past iteration 0 | Med | Med | P2 |
| Replace warmup POST with handshake-only warmup | Low | Low/Med | P2 |
| Add token/cost budgeting + UI | Med | Med | P2 |
| Add intent-based model routing | Med | Med/High | P2 |

## Quick Wins (< 1 hour each)

1. Add abort support to streaming Claude calls: `src/main/llm/tool-loop.ts:522` and `src/main/llm/client.ts:113`.
2. Fix `truncateForHistory()` to honor `MAX_TOOL_RESULT_IN_HISTORY`: `src/main/llm/tool-loop.ts:298`.
3. Count nested tool LLM calls in `usageTracker`: `src/main/browser/tools.ts:453`.
4. Replace `warmAnthropicMessagesConnection` POST warmup with handshake-only warmup: `src/main/main.ts:128`.

## Medium-Term Improvements (1 day each)

1. Implement image-aware history trimming: `src/main/llm/tool-loop.ts:1427` and `src/main/llm/client.ts:254`.
2. Add a document summarization/chunking path for `extractedText`: `src/main/documents/extractor.ts:3` and `src/main/llm/tool-loop.ts:571`.
3. Restructure tool definitions into “always-on” vs “on-demand” sets and keep subsets across iterations: `src/main/llm/tool-loop.ts:642`.

## Architectural Recommendations (multi-day)

1. Unify extraction behavior to avoid nested Anthropic calls inside tools (move extraction responsibility to the main loop, or route nested calls through a shared client with consistent limits/accounting): `src/main/browser/tools.ts:453`.
2. Add a model routing layer (policy + budget) rather than only per-session selection: `src/main/main.ts:88`, `src/shared/models.ts:11`.
3. Add true token counting before sending very large documents/history (char heuristics are approximate): `src/main/llm/tool-loop.ts:1427`.

## Appendix

### A. Token Usage Estimates (measured)

Method: called compiled exports under `dist/main/**` in Node with `XDG_CONFIG_HOME` redirected to `/tmp` to avoid electron-store permission issues; estimates use the repo’s own heuristic `~4 chars/token`.

- System prompt (static, minimal tier): **403 chars (~101 tokens)**
- System prompt (static, standard tier): **13,417 chars (~3,354 tokens)**
- System prompt (dynamic portion, with model label): **235 chars (~59 tokens)**
- System prompt (standard total): **13,654 chars (~3,414 tokens)**
- Tool definitions:
  - Browser tools: **9,411 chars (~2,353 tokens)**, count 21
  - Local tools: **4,172 chars (~1,043 tokens)**, count 7
  - sequential_thinking: **1,750 chars (~438 tokens)**, count 1
  - Total all tools: **15,333 chars (~3,833 tokens)**, count 29

### B. File Reference (examined)

- `src/main/llm/client.ts` — Anthropic SDK streaming wrapper, caching breakpoints, limiter/tracker integration.
- `src/main/llm/tool-loop.ts` — request orchestration, streaming interception, tool scheduling, history trimming/compression, cancellation behavior.
- `src/main/llm/system-prompt.ts` — static+dynamic prompt construction, date/system/account injection.
- `src/main/main.ts` — IPC request lifecycle, key validation, warmups, client caching.
- `src/main/browser/tools.ts` — browser tool definitions; nested Anthropic calls for extraction/OCR; screenshot encoding decisions.
- `src/main/browser/pool.ts` — batch browser operations, extraction, screenshot/PDF payload generation.
- `src/main/browser/manager.ts` — Playwright CDP connection, browser session cleanup, resource management.
- `src/main/cache/search-cache.ts` — SQLite cache + `cache_read` support.
- `src/main/content/compressor.ts` — token-reduction pipeline for page content.
- `src/main/documents/extractor.ts` — document extraction and truncation policy.
- `src/main/usage-tracker.ts` — API call counting + warnings.
- `src/main/rate-limiter.ts` — request limiter used by `AnthropicClient.chat()`.
- `src/main/store.ts` — store schema and API key storage (note: static `encryptionKey` at `src/main/store.ts:98`).
- `src/main/preload.ts` — renderer API surface for IPC.
- `src/main/ipc-validator.ts` — payload validation (API key format, model allowlist).
- `src/shared/models.ts` — model allowlist and default model.
- `src/shared/ipc-channels.ts` — IPC channel names.
- `src/shared/types.ts` — Message/ImageAttachment/DocumentAttachment shapes.
- `src/renderer/modules/chat.ts` — send/stop flow; attachment handling.
- `src/renderer/modules/attachments.ts` — image resizing and document extraction requests.
- `src/renderer/modules/stream.ts` — stream buffering and rendering.
- `node_modules/@anthropic-ai/sdk/src/index.ts` — SDK defaults (baseURL/timeout/maxRetries).
- `node_modules/@anthropic-ai/sdk/src/core.ts` — SDK maxRetries default.
- `node_modules/@anthropic-ai/sdk/core.d.ts` — `signal?: AbortSignal` request option.

### C. API Call Inventory (distinct patterns)

1. Main streaming tool-loop call
   - `this.client.messages.create({ ..., stream: true })` (`src/main/llm/client.ts:113-127`)
2. API key validation (direct HTTP)
   - `fetch('https://api.anthropic.com/v1/messages', { method: 'POST', ... })` (`src/main/main.ts:156-209`)
3. Warmup call (direct HTTP)
   - `fetch('https://api.anthropic.com/v1/messages', { method: 'POST', ... })` (`src/main/main.ts:128-152`)
4. Nested extraction call (tool-internal, non-streaming)
   - `client.messages.create({ max_tokens: 700, ... })` (`src/main/browser/tools.ts:453-494`)
5. Nested vision/OCR call (tool-internal, non-streaming)
   - `client.messages.create({ max_tokens: 2_000, ... image ... })` (`src/main/browser/tools.ts:496-533`)
6. Nested text-to-JSON extraction call (tool-internal, non-streaming)
   - `client.messages.create({ max_tokens: 900, ... })` (`src/main/browser/tools.ts:535-597`)

### D. Pricing Notes (limitation)

This repo does not contain "current Anthropic pricing", and this audit run did not fetch it from the internet. For accurate dollar estimates, multiply measured tokens (available in `src/main/llm/client.ts:142-205`) by the model's current per-token rates and incorporate cache effects using `cache_read_input_tokens` and `cache_creation_input_tokens`.

---

## Current Model Landscape (Updated 2026-02-08)

| Model | ID | Input | Output | Cache Write (5m) | Cache Write (1h) | Cache Read | Long Context (>200K) |
|---|---|---|---|---|---|---|---|
| Opus 4.6 | `claude-opus-4-6` | $5/MTok | $25/MTok | $6.25/MTok | $10/MTok | $0.50/MTok | $10/$37.50 |
| Opus 4.5 | `claude-opus-4-5-20250929` | $5/MTok | $25/MTok | $6.25/MTok | $10/MTok | $0.50/MTok | N/A |
| Sonnet 4.5 | `claude-sonnet-4-5-20250929` | $3/MTok | $15/MTok | $3.75/MTok | $6/MTok | $0.30/MTok | $6/$22.50 |
| Sonnet 4 | `claude-sonnet-4-20250514` | $3/MTok | $15/MTok | $3.75/MTok | $6/MTok | $0.30/MTok | $6/$22.50 |
| Haiku 4.5 | `claude-haiku-4-5-20251001` | $1/MTok | $5/MTok | $1.25/MTok | $2/MTok | $0.10/MTok | N/A |

Notes:
- Opus 4.6 has NO date suffix in its model ID
- Batch API gives 50% discount on all token types
- Cache read is 0.1x base input price
- 5m cache write is 1.25x base, 1h cache write is 2x base
- Model metadata (costs, capabilities) now stored in `ModelConfig` interface in `src/shared/models.ts`

## Opus 4.6 — Breaking Changes & Migration Requirements

**BREAKING: Prefilling Removed**
- Assistant message prefilling returns 400 on Opus 4.6
- **Status: Confirmed clean** — searched entire codebase; no assistant prefilling found
- Assistant messages in `tool-loop.ts:772,801` and `main.ts:373` are post-response storage, not prefills

**BREAKING: Tool Parameter Quoting**
- Opus 4.6 may produce slightly different JSON string escaping in tool call arguments
- **Status: Safe** — all tool result parsing uses `JSON.parse()` (no regex/string matching)

**DEPRECATED: `thinking: {type: "enabled", budget_tokens: N}`**
- Replace with `thinking: {type: "adaptive"}` + effort parameter
- **Status: N/A** — codebase does not use the Anthropic thinking API parameter; `sequential_thinking` is a local tool

**DEPRECATED: `output_format`**
- Move to `output_config.format`
- **Status: N/A** — not used in codebase

**DEPRECATED: `interleaved-thinking-2025-05-14` beta header**
- **Status: N/A** — not used in codebase

## New API Capabilities Available for Clawdia

**Compaction API (beta) — `compact-2026-01-12`**
- Server-side context summarization replacing manual `trimHistory()` and `compressOldToolResults()`
- **Status: Implemented** — enabled for Opus 4.6 in `client.ts`, triggers at 100K input tokens
- Manual `trimHistory()` and `compressOldToolResults()` remain as fallbacks for non-Opus models

**Context Editing (beta) — `context-management-2025-06-27`**
- `clear_tool_uses_20250919`: Automatically clears old tool results when context grows
- **Status: Implemented** — enabled alongside compaction for supported models

**Adaptive Thinking**
- `thinking: {type: "adaptive"}` — model decides when/how much to think
- Combine with `effort` parameter for cost-quality tradeoffs
- **Status: Available via model router** — effort levels set per `CallContext` in `model-router.ts`

**Effort Parameter (GA)**
- Levels: `low`, `medium`, `high` (default), `max`
- **Status: Implemented in model router** — extraction calls use `low`, planning uses `high`, chat uses `medium`

**128K Output Tokens**
- Opus 4.6 doubles max output from 64K to 128K
- **Status: Tracked** — `ModelConfig.maxOutputTokens` set to 128K for Opus 4.6

**Fast Mode (beta)**
- `speed: "fast"` with `betas: ["fast-mode-2026-02-01"]`
- Up to 2.5x faster at premium pricing ($30/$150 per MTok for Opus)
- **Status: Not implemented** — P2, available via `ModelConfig.supportsFastMode` flag

## Updated Priority Matrix

| Optimization | Effort | Impact | Priority | Status |
|---|---|---|---|---|
| Check for assistant prefilling (Opus 4.6 compat) | Low | Critical | P0 | Done — confirmed clean |
| Add Opus 4.6 + updated models to allowlist | Low | High | P0 | Done — `ModelConfig` interface, 5 current models |
| Abort streaming with `AbortSignal` | Low | High | P0 | Done — `AbortController` in tool-loop, signal to SDK |
| Fix tool-result truncation cap mismatch | Low | Med | P0 | Done — `truncateForHistory()` respects `MAX_TOOL_RESULT_IN_HISTORY` |
| Track + rate-limit nested tool LLM calls | Low/Med | High | P0 | Done — `client.complete()` method, browser/tools.ts refactored |
| Implement smart model routing with effort levels | Med | High | P0 | Done — `model-router.ts` with `routeModel()` |
| Split system prompt into static+dynamic blocks | Low/Med | Med | P1 | Done — two system blocks, date coarsened |
| Transparent model routing UI indicators | Low/Med | Med | P1 | Done — `CHAT_ROUTE_INFO` IPC event |
| Integrate Compaction API (replace manual trimHistory) | Med | High | P1 | Done — Opus 4.6 only, manual fallback preserved |
| Integrate context editing (clear_tool_uses) | Med | Med | P1 | Done — alongside compaction |
| Migrate to adaptive thinking | Low | Med | P1 | Done — no migration needed, effort via router |
| Budget images in history trimming | Med | Med | P1 | Pending |
| Document summarization/chunk selection | Med | High | P1 | Pending |
| Persist narrowed tool subsets past iteration 0 | Med | Med | P2 | Pending |
| Evaluate fast mode for latency-critical paths | Low | Med | P2 | Pending |
| Add token/cost budgeting + UI | Med | Med | P2 | Pending |
| Evaluate 1h cache TTL for system prompt | Low | Low/Med | P2 | Pending |

## Appendix E: Implementation Log (2026-02-08)

| Task | Files Modified | Summary |
|---|---|---|
| 2.1 Model allowlist | `src/shared/models.ts` | Added `ModelConfig` interface with costs/capabilities, `MODEL_CONFIGS` registry (5 models), new default `claude-sonnet-4-5-20250929`, helper functions `getModelConfig()`, `getModelTier()`. Removed 8 legacy models. |
| 2.2 Prefilling check | (none) | Confirmed no assistant prefilling in codebase |
| 2.3 AbortSignal | `src/main/llm/client.ts`, `src/main/llm/tool-loop.ts` | Added `AbortController` to ToolLoop, `signal` option to `chat()`, AbortError handling returns `[Stopped]` |
| 2.4 Truncation fix | `src/main/llm/tool-loop.ts` | `truncateForHistory()` now derives head/tail from `MAX_TOOL_RESULT_IN_HISTORY` with 60-char separator budget and 30% tail ratio |
| 2.5 Nested call tracking | `src/main/llm/client.ts`, `src/main/browser/tools.ts` | Added `complete()` method to `AnthropicClient` (non-streaming, rate-limited, tracked). Refactored 3 `llmExtract*` functions to use `getSharedClient().complete()` |
| 2.6 Smart model router | `src/main/llm/model-router.ts` (new) | `routeModel()` with 7 `CallContext` types, tier-aware ceiling enforcement, effort levels |
| 2.7 Routing UI | `src/shared/ipc-channels.ts`, `src/main/llm/tool-loop.ts`, `src/main/preload.ts` | `CHAT_ROUTE_INFO` IPC event emitted per API call with model, iteration, tokens, duration |
| 2.8 Split system prompt | `src/main/llm/system-prompt.ts`, `src/main/llm/client.ts`, `src/main/llm/tool-loop.ts` | Static prompt block gets `cache_control: ephemeral`, dynamic block is uncached. Date context coarsened to `YYYY-MM-DD` |
| 2.9 Compaction API | `src/main/llm/client.ts`, `src/main/llm/tool-loop.ts` | Beta `compact-2026-01-12` with 100K trigger for Opus 4.6. Manual trimming preserved as fallback |
| 2.10 Context editing | `src/main/llm/client.ts` | `clear_tool_uses_20250919` enabled alongside compaction for supported models |
| 2.11 Adaptive thinking | (none needed) | Codebase doesn't use Anthropic thinking parameter. Effort levels available via model router |

### Appendix F: Cost Projection

Using measured token counts from Appendix A (~3,414 tokens system prompt, ~3,833 tokens tools, ~250 tokens avg history per message) and the pricing table above:

**Per-request cost estimates (standard 10-message conversation, ~5 tool loop iterations):**

| Scenario | Input Tokens (est.) | Output Tokens (est.) | Est. Cost |
|---|---|---|---|
| Before: All Sonnet 4, no split caching | ~45K | ~8K | ~$0.255 |
| After: Sonnet 4.5 + Haiku extraction, split caching | ~38K (cache hits) | ~8K | ~$0.145 |
| After: Opus 4.6 ceiling, smart routing + compaction | ~45K (compacted) | ~10K | ~$0.375 |

**Monthly projections:**

| Usage Tier | Before (Sonnet 4) | After (Smart routing) | After (Opus 4.6 ceiling) |
|---|---|---|---|
| Light (50 conv/day) | ~$383/mo | ~$218/mo | ~$563/mo |
| Heavy (200 conv/day) | ~$1,530/mo | ~$870/mo | ~$2,250/mo |

Note: Estimates assume 5 tool iterations per conversation average. Real costs depend heavily on conversation complexity, cache hit rates (expected 60-80% within tool loops), and whether compaction triggers. Smart routing saves ~43% by downgrading extraction calls to Haiku ($1/$5 vs $3/$15).
