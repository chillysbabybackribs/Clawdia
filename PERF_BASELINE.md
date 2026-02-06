# Clawdia Performance Baseline

## Measurement Methodology

Timings are estimated from code analysis and the `[Perf]` instrumentation markers added to `tool-loop.ts`. Run the app and execute the test queries below to capture actual numbers.

To capture timings: open DevTools (F12) in the main Electron window, filter console for `[Perf]`.

---

## Bottleneck Analysis (Pre-Optimization)

### Per-Request Overhead
| Component | Cost | Frequency |
|-----------|------|-----------|
| System prompt rebuild (os.* calls) | ~2-5ms | Every API call |
| New AnthropicClient instantiation | ~5-10ms + TCP/TLS on first call | Every message |
| Conversation serialization to disk | ~5-50ms (depends on history size) | 3x per message |
| `convertMessages` JSON re-parsing | ~1-3ms | Every API call |

### Per-Iteration Overhead
| Component | Cost | Notes |
|-----------|------|-------|
| **Double API call (tool_use)** | **2-5 seconds** | **CRITICAL: Full duplicate API call** |
| Hardcoded setTimeout in toolNavigate | 1,500ms fixed | Always waits, even if page loaded in 200ms |
| Hardcoded setTimeout in Playwright search | 2,000ms fixed | Always waits for Google scraping |
| Sequential tool execution | N * tool_time | Two 300ms searches take 600ms instead of 300ms |

### Token Budget (Per API Call)
| Component | Tokens |
|-----------|--------|
| System prompt | ~1,000-1,200 |
| 17 tool definitions | ~800-1,000 |
| Base overhead | ~2,000-2,200 |
| Page snapshot (was 12K chars) | Up to ~3,000-4,000 |
| Page snapshot (now 6K chars) | Up to ~1,500-2,000 |
| 14-message history with tool results | 5,000-15,000 |

---

## Expected Impact Per Query Type

### Query: "What time does Costco close?" (simple factual — 1-2 tool calls)

**BEFORE (estimated):**
```
Total: ~8-10s
  History assembly: ~12ms
  System prompt: ~3ms
  API call #1 (tool decision): ~2-3s (stream) + ~2-3s (duplicate non-stream)
  Tool: browser_search: ~300-800ms (API) or ~3.5s (Playwright fallback with 2s wait)
  API call #2 (response): ~2-3s (stream) + 0s (no tool_use, no duplicate)
  Conversation save: ~15ms * 3 = ~45ms
```

**AFTER (estimated):**
```
Total: ~4-6s
  History assembly: ~1ms (cached prompt)
  System prompt: ~0ms (cached)
  API call #1 (tool decision): ~2-3s (stream only, no duplicate)
  Tool: browser_search: ~300-800ms (API, or event-driven wait for Playwright)
  API call #2 (response): ~1.5-2.5s (lower max_tokens not applicable here, but fewer input tokens from smaller results)
  Conversation save: ~15ms * 1 = ~15ms (debounced)
```

**Key savings:** ~2-5s from eliminating double API call, ~0-1.7s from removing hardcoded waits

### Query: "Go to github.com" (direct navigation — 1 tool call)

**BEFORE (estimated):**
```
Total: ~6-8s
  API call #1: ~2-3s + ~2-3s (duplicate)
  Tool: browser_navigate: ~1.5s (hardcoded wait) + page load time
  API call #2: ~1.5-2s
```

**AFTER (estimated):**
```
Total: ~3-5s
  API call #1: ~2-3s (stream only)
  Tool: browser_navigate: ~0.2-3s (event-driven, page load time)
  API call #2: ~1-2s (fewer input tokens)
```

### Query: "Compare MacBook Pro vs Dell XPS pricing" (comparison — 3-5 tool calls)

**BEFORE (estimated):**
```
Total: ~18-25s
  API call #1: ~2-3s + ~2-3s (duplicate)
  Tools (sequential): 3-5 * ~500ms = ~1.5-2.5s
  API call #2: ~2-3s + ~2-3s (duplicate)
  Tools (sequential): 1-3 * ~500ms = ~0.5-1.5s
  API call #3: ~2-3s
```

**AFTER (estimated):**
```
Total: ~8-14s
  API call #1: ~2-3s (no duplicate)
  Tools (parallel): ~500ms (concurrent execution)
  API call #2: ~1.5-2.5s (no duplicate, lower max_tokens=1024)
  Tools (parallel): ~500ms
  API call #3: ~1.5-2.5s (fewer input tokens from truncated results)
```

**Key savings:** ~4-6s from eliminating 2 duplicate API calls, ~0.5-1.5s from parallel tools, ~1-2s from reduced tokens

### Query: "What's 15% of 340?" (no tools — pure LLM)

**BEFORE (estimated):**
```
Total: ~2-3s
  API call: ~2-3s (no tools, no duplicate)
```

**AFTER (estimated):**
```
Total: ~1.5-2.5s
  API call: ~1.5-2.5s (cached client reuses connection, max_tokens=4096 unchanged)
```

**Key savings:** ~200-500ms from connection reuse (cached client)

### Query: "What happened in AI news today?" (news search)

**BEFORE (estimated):**
```
Total: ~7-10s
  API call #1: ~2-3s + ~2-3s (duplicate)
  Tool: browser_news: ~300-800ms
  API call #2: ~2-3s
```

**AFTER (estimated):**
```
Total: ~4-6s
  API call #1: ~2-3s (no duplicate)
  Tool: browser_news: ~300-800ms (same, no caching for news)
  API call #2: ~1.5-2.5s
```

---

## How to Capture Real Numbers

1. Build and start the app: `npm run dev`
2. Open DevTools: press F12
3. In Console tab, filter for `[Perf]`
4. Run each test query
5. Copy timing output to fill in actual numbers above

The instrumentation logs:
```
[Perf] System prompt: Xms
[Perf] History assembly: Xms (N messages)
[Perf] API call #1: Xms
[Perf] API call #1 tokens: in=XXXX out=XXX
[Perf] Tool: browser_search: Xms (N chars)
[Perf] All tools (parallel): Xms
[Perf] API call #2: Xms
[Perf] Total request: Xms
[Perf] Total wall time: Xms, iterations: N, toolCalls: N
```

---

## Optimization Impact Summary

| Optimization | Estimated Savings | Applies To |
|-------------|-------------------|------------|
| Eliminate double API call | 2-5s per tool iteration | All tool-using queries |
| Remove hardcoded waits | 0-1.7s per navigation | Navigate/search fallback |
| Parallel tool execution | 0-2s per multi-tool batch | Multi-tool responses |
| Cache AnthropicClient | 100-500ms on first call | All queries |
| Connection warmup | 200-500ms on cold start | First query after launch |
| Reduce max_tokens (1024) | 200-400ms per intermediate call | Tool-decision iterations |
| Reduce page snapshot size | 100-300ms per subsequent call | Queries with page reads |
| Search result caching | 300-800ms per cached query | Repeat queries |
| Debounce persistence | 10-50ms per request | All queries |
| Cache system prompt | 2-5ms per API call | All queries |
