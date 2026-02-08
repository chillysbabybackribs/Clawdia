# Browser Tools Optimality Audit

## Executive Summary

- **Current optimality score: 62/100**
- **Revised score trajectory:** 62 → 73 (Tier 1) → 79 (Tier 2) → 84 (Tier 3)
- **Top 3 gaps:**
  1. **No compound/macro tools** — interactive workflows (search→click→extract, fill_form) require 3-6 round trips each when 1 would suffice
  2. **Redundant visual sync navigations** — every search/news/shopping/places/images tool navigates the BrowserView before calling the API, adding 2-3s latency per call with zero accuracy benefit
  3. **No output token optimization** — tool return strings are verbose, parameter names are longer than needed, and cascading input costs are not accounted for
- **Estimated improvement potential:** 40-50% fewer tokens per session, 50-60% faster common workflows

---

## 1. Current State Measurements

### 1A. Token Budget Per API Call

#### System Prompt Tokens
| Tier | Raw chars | Est. tokens (÷4) | When used |
|------|----------|-------------------|-----------|
| Minimal | ~320 chars | ~80 tokens | Chat-only (intent router) |
| Standard | ~6,800 chars | ~1,700 tokens | Default for tool calls |
| Full | ~8,600 chars | ~2,150 tokens | Never used (code builds standard, not full) |
| Dynamic context | ~200-400 chars | ~50-100 tokens | Always appended |
| **Standard total** | **~7,200 chars** | **~1,800 tokens** | |

Note: The `buildSystemPrompt` in `tool-loop.ts:558-559` builds both `minimal` and `standard` but never `full`. The standard tier includes CORE_TOOL_RULES + BROWSER_ACCESS_RULES + THINKING_RULES + TOOL_INTEGRITY_RULES + SELF_KNOWLEDGE but NOT LIVE_PREVIEW_RULES or DOCUMENT_RULES. This means live preview and document creation instructions are missing from the standard prompt.

#### Tool Schema Tokens
| Tool | Description chars | Schema chars | Est. tokens |
|------|-----------------|-------------|-------------|
| browser_search | 90 | 80 | 43 |
| browser_navigate | 65 | 80 | 36 |
| browser_read_page | 60 | 20 | 20 |
| browser_click | 230 | 320 | 138 |
| browser_type | 60 | 160 | 55 |
| browser_scroll | 55 | 120 | 44 |
| browser_tab | 70 | 140 | 53 |
| browser_screenshot | 300 | 20 | 80 |
| browser_news | 175 | 80 | 64 |
| browser_shopping | 175 | 80 | 64 |
| browser_places | 170 | 80 | 63 |
| browser_images | 120 | 80 | 50 |
| browser_batch | 170 | 450 | 155 |
| browser_read_tabs | 115 | 60 | 44 |
| browser_extract | 65 | 160 | 56 |
| browser_visual_extract | 130 | 100 | 58 |
| browser_search_rich | 90 | 120 | 53 |
| cache_read | 240 | 150 | 98 |
| browser_detect_account | 145 | 20 | 41 |
| sequential_thinking | 520 | 350 | 218 |
| shell_exec | ~200 | ~250 | ~113 |
| file_read | ~100 | ~150 | ~63 |
| file_write | ~100 | ~150 | ~63 |
| file_edit | ~100 | ~150 | ~63 |
| directory_tree | ~100 | ~200 | ~75 |
| process_manager | ~200 | ~250 | ~113 |
| create_document | ~200 | ~300 | ~125 |
| **Total (27 tools)** | | | **~2,082 tokens** |

#### Per-API-Call Input Token Breakdown (typical tool loop iteration)
| Component | Tokens | Cached? |
|-----------|--------|---------|
| System prompt (standard) | ~1,800 | Yes (cache_control: ephemeral on system) |
| Tool definitions (27 tools) | ~2,082 | Yes (cache_control: ephemeral on last tool) |
| Conversation history (trimmed) | ~1,250 (5K chars ÷ 4) | Partial (cache_control on last tool_result) |
| Current user message | variable | No |
| **Typical first call** | **~5,200+** | **~3,882 cached** |
| **Typical tool loop iteration 3+** | **~6,000-8,000** | **~5,000+ cached** |

#### Prompt Caching Effectiveness
The client (`client.ts:85-90,116-121,228-247`) implements 3 cache breakpoints:
1. System prompt: `cache_control: { type: 'ephemeral' }` on system message
2. Last tool definition: `cache_control: { type: 'ephemeral' }` on last tool in array
3. Last tool_result message: `cache_control: { type: 'ephemeral' }` added dynamically

**This is well-implemented.** On iteration N of a tool loop, system prompt + tools + history up to the previous tool_result are cached at 90% discount. Only the newest assistant+user message pair is fresh input.

#### Tool Result Sizes
| Tool | Typical result size (chars) | Est. tokens |
|------|---------------------------|-------------|
| browser_search | 800-1,500 | 200-375 |
| browser_navigate (ARIA snapshot) | 2,000-6,000 | 500-1,500 |
| browser_read_page (ARIA snapshot) | 2,000-6,000 | 500-1,500 |
| browser_click | 50-100 | 13-25 |
| browser_type | 30-60 | 8-15 |
| browser_scroll | 20-40 | 5-10 |
| browser_screenshot | image (base64, ~30-80KB) | ~1,600 image tokens |
| browser_batch (cached refs) | 200-500 | 50-125 |
| browser_batch (inline) | 3,000-18,000 | 750-4,500 |
| browser_news | 500-1,200 | 125-300 |
| browser_shopping | 400-1,000 | 100-250 |
| cache_read (full page) | 5,000-20,000 | 1,250-5,000 |
| cache_read (section) | ~5,000 | ~1,250 |
| shell_exec | 100-5,000 | 25-1,250 |

#### Compression/Truncation Applied
- **Tool result hard cap**: 30,000 chars (`MAX_TOOL_RESULT_CHARS` in `tool-loop.ts:46`)
- **History compression**: Old tool_results (all except last 1) truncated to ~1,900 chars (1,400 head + 500 tail) per `truncateForHistory()` (`tool-loop.ts:296-302`)
- **Image stripping**: Old image tool_results replaced with text summary (`tool-loop.ts:340-347`)
- **Page content compression**: 5-step pipeline capping at 6,000 chars for navigate/read_page, 8,000 for batch, 4,000 for extract (`compressor.ts`)
- **History trimming**: `trimHistory()` caps at ~5,000 tokens (~20K chars) working backwards (`tool-loop.ts:1402-1429`)

### 1B. Tool Call Round Trips — Common Workflows

#### Workflow: "Search Google for X" (search → answer or click → extract)
```
Iteration 1: LLM → browser_search(query)           → search results (200-375 tokens)
Iteration 2: LLM → browser_navigate(url)            → ARIA snapshot (500-1500 tokens)
             OR LLM → final answer (if snippets suffice)
Total: 2-3 round trips (2-3 API calls)
```
**Assessment:** Optimal when snippets answer the question (1 call). The search tool redundantly navigates BrowserView to Google SERP even though results come from Serper API — this adds ~2s latency for visual sync that the LLM doesn't need.

#### Workflow: "Go to twitter.com and post Y"
```
Iteration 1: LLM → browser_navigate("x.com/home")  → ARIA snapshot
Iteration 2: LLM → browser_click("composer")        → click result
Iteration 3: LLM → browser_type(text)               → type result
Iteration 4: LLM → browser_click("Post")            → click result
Iteration 5: LLM → browser_screenshot()             → verification
Total: 5 round trips minimum
```
**Assessment:** Could be 2 with a compound `browser_interact` tool: `navigate → click → type → click → screenshot` in one call.

#### Workflow: "Check Instagram DMs"
```
Iteration 1: LLM → browser_navigate("instagram.com") → ARIA snapshot
Iteration 2: LLM → browser_click("Messages")         → click result
             OR LLM → browser_screenshot()            → visual identification
Iteration 3: LLM → browser_click(coordinates)         → click result
Iteration 4: LLM → browser_read_page()               → DM content
Total: 3-5 round trips
```
**Assessment:** Icon-heavy UI requires screenshot → coordinate click pattern, which is good. But navigate + click could be combined.

#### Workflow: "Find the price of X on Amazon"
```
Iteration 1: LLM → browser_shopping(query)           → price results (direct answer)
Total: 1 round trip
```
**Assessment:** Optimal. Specialized search tools are excellent.

### 1C. Latency Breakdown

#### Streaming
- **Yes**, all API calls use `stream: true` (`client.ts:126`)
- Text deltas are forwarded to the renderer via `onText` callback in real-time
- Tool input JSON is accumulated during streaming (`input_json_delta` fragments) and parsed at `content_block_stop` — **no second non-streaming call needed** ✓

#### Speculative Tool Execution
- **Implemented** (`tool-loop.ts:675-691`): Safe, read-only tools (`shell_exec`, `file_read`, `browser_search`, `browser_news`, etc.) are executed speculatively as soon as their `content_block_stop` fires during streaming
- Browser navigation/click/type are excluded from speculative execution (correct — they have side effects)
- Results are consumed via `earlyToolResults` map when the full response is processed

#### Fixed Delays and Waits
| Location | Wait | Purpose | Avoidable? |
|----------|------|---------|-----------|
| `tools.ts:849` | `page.waitForTimeout(500)` | Post-click stabilization | Partially — could use `waitForLoadState` |
| `tools.ts:625-629` | `waitForLoad(2000)` | Visual sync for browser_search | **Yes** — not needed for API search results |
| `tools.ts:694` | `waitForLoad(3000)` | After navigate, before snapshot | Event-driven, reasonable |
| `tools.ts:1309` | `setTimeout(150)` | Between visual tab opens | Minor, UX only |
| `tools.ts:1347` | `setTimeout(800)` | Wait for page render before highlighting | UX only |
| `tools.ts:1788` | `waitForLoad(2000)` | Visual sync for search_rich | **Yes** — redundant |
| `tools.ts:1892` | `waitForLoad(2000)` | Visual sync for news | **Yes** — redundant |
| `tools.ts:1916` | `waitForLoad(2000)` | Visual sync for shopping | **Yes** — redundant |
| `tools.ts:1940` | `waitForLoad(2000)` | Visual sync for places | **Yes** — redundant |
| `tools.ts:1966` | `waitForLoad(2000)` | Visual sync for images | **Yes** — redundant |

**Key finding:** 6 tools (search, search_rich, news, shopping, places, images) perform a BrowserView navigation + 2s wait purely for visual display. This happens on every call, adding ~2-3s wall-clock time. The LLM doesn't use the visual display — it reads API results.

#### CDP Connection Overhead
- Initial connection: 5 retries × 1s delay = up to 5s (`manager.ts:413-414,656-682`)
- Once connected, Playwright reuses the connection — no per-call overhead
- `probeCDP` uses 2s timeout per probe (`manager.ts:418`)

### 1D. Page Representation

#### What the LLM "sees"
For `browser_navigate` and `browser_read_page` (`tools.ts:1846-1883`):
1. **Primary**: Playwright ARIA snapshot via `page.locator('body').ariaSnapshot({ timeout: 1500 })` — compressed to 6,000 chars
2. **Fallback**: If ARIA fails, raw `textContent` of `<article>`, `<main>`, or `<body>` — also compressed to 6,000 chars
3. **Both**: Wrapped as `Page: {title}\nURL: {url}\n\n{content}`

The ARIA snapshot includes:
- Heading hierarchy
- Link text and URLs
- Button labels
- Form input labels and values
- List items
- Interactive element roles

**What's missing from ARIA:**
- Visual layout (sidebars, grids, columns)
- Image alt text (sometimes included, sometimes not)
- Icon-only buttons (no text to snapshot)
- Dynamic content loaded after render

#### Typical page representation size
- ARIA snapshot: 2,000-6,000 chars (500-1,500 tokens) after compression
- Screenshot (JPEG q=60): 30-80KB base64 (~1,600 image tokens via vision)

#### Interactive element targeting
The LLM targets elements through:
1. **Text/accessible name** (`tryClickRef`): Playwright `getByRole` + `getByText` — works for labeled buttons/links
2. **CSS selectors**: Direct `page.locator(selector)` — works when LLM knows the selector
3. **Coordinates**: `page.mouse.click(x, y)` — works with screenshots
4. **Platform-specific fallbacks**: Twitter/X has hardcoded `data-testid` selectors

**Reliability:** Good for text-labeled elements, poor for icon-only UIs without screenshots. The screenshot → coordinate click fallback works but costs an extra round trip.

---

## 2. State-of-the-Art Comparison

### 2A. Page Representation Strategies

| Strategy | Clawdia Status | Notes |
|----------|---------------|-------|
| Raw HTML | ✗ Not used | Good — too noisy, too many tokens |
| Accessibility tree (ARIA) | ✓ Primary | Good default for interactive pages |
| Pruned DOM | ✗ Not used | Could complement ARIA for content-heavy pages |
| Set-of-Marks (SoM) | ✗ Not implemented | SOTA for visual UIs — numbered bounding boxes on screenshot |
| Hybrid: AXTree + Screenshot | ✓ Partial | Available but not auto-selected — LLM must choose |
| Structured extraction (evaluate) | ✓ Used in batch/extract | Good for known schemas |

**Gap:** No automatic selection of representation strategy based on page type. A news article should get compressed text, not ARIA. A complex web app should get ARIA + screenshot, not one or the other.

### 2B. Action Strategies

| Strategy | Clawdia Status | Notes |
|----------|---------------|-------|
| Single-action tools | ✓ Primary | click, type, scroll each require separate round trip |
| Compound actions | ✗ Missing | No "navigate + click + type + submit" in one call |
| Batch operations | ✓ browser_batch | Excellent for multi-URL extraction |
| Macro tools | ✗ Missing | No fill_form, no navigate_and_act |
| Intent-based routing | ✓ Partial | Intent router skips tools for chat-only, but no fast-path for simple queries |

**Gap:** The biggest efficiency win would be compound action tools. A `browser_interact` tool that accepts a sequence of actions would eliminate 2-4 round trips per interactive workflow.

### 2C. Context Management Strategies

| Strategy | Clawdia Status | Notes |
|----------|---------------|-------|
| Prompt caching | ✓ Implemented | 3 cache breakpoints — system, tools, last tool_result |
| Progressive compression | ✓ Implemented | Old tool_results truncated to ~2K chars |
| Sliding window | ✓ Implemented | trimHistory caps at ~5K tokens |
| Intent routing | ✓ Implemented | chat-only skips tools + uses minimal prompt |
| Tool result truncation | ✓ Implemented | 30K hard cap, 6K page snapshots |
| Deferred tool loading | ✗ Missing | All 27 tools always included (except chat-only) |

**Gap:** Deferred tool loading could save ~500-1,000 tokens when only browser OR local tools are needed. If the user says "read file X", local-only tools suffice. If they say "search for Y", browser-only tools suffice.

### 2D. Error Recovery

| Strategy | Clawdia Status | Notes |
|----------|---------------|-------|
| Retry with screenshot | ✓ Partial | System prompt instructs this, but it's LLM-driven (not automatic) |
| Selector fallback chain | ✓ Implemented | `tryClickRef`: button→link→menuitem→text; plus selector, coordinates |
| Self-correction | ✓ Natural | LLM sees error in tool_result and adapts |
| Timeout escalation | ✗ Missing | Fixed timeouts, no retry with longer timeout |
| Stale element recovery | ✗ Missing | No automatic re-query after navigation changes DOM |
| Twitter-specific fallbacks | ✓ Implemented | Hardcoded data-testid selectors for X/Twitter |

**Gap:** Error recovery is primarily LLM-driven rather than automatic in the tool layer. The click tool returns a text hint on failure ("Try browser_screenshot to see the page, then click with x/y coordinates") which is good — it guides the LLM to recover.

---

## 3. Gap Analysis (Scored)

| # | Gap | Speed (1-5) | Accuracy (1-5) | Consistency (1-5) | Token Savings (est.) | Effort |
|---|-----|-------------|----------------|-------------------|---------------------|--------|
| 1 | **Remove visual sync navigations from API-backed search tools** | 5 | 1 | 1 | 0% tokens, ~2-3s/call | Low |
| 2 | **Add compound browser_interact tool** | 4 | 3 | 4 | 30-50% fewer round trips | Medium |
| 3 | **Deferred tool loading by intent class** | 2 | 1 | 1 | 10-20% input tokens on simple tasks | Medium |
| 4 | **Task-adaptive page representation** | 3 | 4 | 3 | 20-40% per page snapshot | Medium |
| 5 | **Standard prompt missing live preview + document rules** | 1 | 4 | 3 | 0% (increases ~200 tokens) | Low |
| 6 | **Reduce ARIA snapshot verbosity for content pages** | 2 | 2 | 2 | 15-25% per navigate/read | Low |
| 7 | **Remove 500ms post-click waitForTimeout** | 2 | 1 | 1 | 0% tokens, ~0.5s/click | Low |
| 8 | **Automatic screenshot on click failure** | 2 | 3 | 3 | Saves 1 round trip on failures | Low |
| 9 | **Smarter search result format** | 2 | 2 | 2 | 10-20% per search result | Low |
| 10 | **No `browser_fill_form` macro tool** | 3 | 3 | 4 | 60-83% fewer round trips for forms | Medium |
| 11 | **No output token optimization** | 3 | 1 | 2 | 15-25% output tokens per session | Medium |
| 12 | **No cache hit rate monitoring** | 1 | 1 | 1 | 0% (enables measurement of all other savings) | Low |
| 13 | **Verbose tool result return strings** | 2 | 1 | 2 | 20-40% per tool_result | Medium |

---

## 4. Optimal Architecture Spec

### 4A. Tool Inventory (Proposed Changes Only)

#### New: `browser_interact` (compound action tool)
```typescript
{
  name: 'browser_interact',
  description: 'Execute a sequence of browser actions in one call. Prefer this over separate browser_click/browser_type/browser_scroll calls for 2+ sequential actions. Use url to combine navigation with interaction.',
  input_schema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'Optional: navigate to this URL before executing steps'
      },
      steps: {
        type: 'array',
        maxItems: 8,
        items: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['click', 'type', 'scroll', 'wait', 'screenshot', 'read'] },
            ref: { type: 'string' },
            text: { type: 'string' },
            x: { type: 'number' },
            y: { type: 'number' },
            selector: { type: 'string' },
            enter: { type: 'boolean' },
            dir: { type: 'string', enum: ['up', 'down'] },
            amount: { type: 'number' },
            ms: { type: 'number', description: 'Wait duration in ms (max 3000)' },
          },
          required: ['action'],
        },
      },
      stopOnError: {
        type: 'boolean',
        description: 'If true, stop executing steps after the first failure. Default: false.'
      },
    },
    required: ['steps'],
  },
}
```
**Returns:** Array of step results + final page state. ~200-800 tokens.
**When to use:** Any interactive workflow requiring 2+ actions (posting, form filling, navigation sequences).
**Key addition:** `url` field enables navigate + interact in a single call. `read` action returns page snapshot without a separate `browser_read_page` call.

#### New: `browser_fill_form` (macro tool)
```typescript
{
  name: 'browser_fill_form',
  description: 'Fill multiple form fields at once by label or selector, and optionally submit. More reliable than sequential click+type for forms.',
  input_schema: {
    type: 'object',
    properties: {
      fields: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'Input label, placeholder, or name attribute' },
            selector: { type: 'string', description: 'CSS selector (fallback if label matching fails)' },
            value: { type: 'string', description: 'Value to fill. For selects, the option text or value.' },
            type: { type: 'string', enum: ['text', 'select', 'checkbox', 'radio', 'textarea'], description: 'Input type hint. Defaults to text.' },
          },
          required: ['value'],
        },
      },
      submit: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'Button label to click after filling' },
          selector: { type: 'string', description: 'CSS selector for submit button' },
        },
        description: 'Optional: click this element after filling all fields',
      },
    },
    required: ['fields'],
  },
}
```
**Returns:** Per-field success/failure summary + submit result. ~100-300 tokens.
**Implementation:** For each field, try matching in order: `label[for]` → `aria-label` → `placeholder` → `name` → CSS selector. Use Playwright's `page.fill()` for text/textarea, `page.selectOption()` for selects, `page.check()`/`page.uncheck()` for checkboxes.

#### Modification: Remove visual sync from search tools
The following tools should NOT navigate the BrowserView:
- `browser_search` → remove lines 623-629 (SERP navigation)
- `browser_search_rich` → remove line 1788 (SERP navigation)
- `browser_news` → remove lines 1891-1892
- `browser_shopping` → remove lines 1915-1916
- `browser_places` → remove lines 1939-1940
- `browser_images` → remove lines 1965-1966

Instead, add a single fire-and-forget BrowserView navigation ONLY if no other visual activity is happening. Or better: move visual sync to a separate non-blocking helper that doesn't block the tool result.

### 4B. Page Representation Pipeline (Proposed)

```
1. Classify page type:
   - Content page (article, blog, docs) → text extraction + compress
   - Interactive page (app, dashboard) → ARIA snapshot
   - Visual page (design, maps) → screenshot
   - Unknown → ARIA snapshot (current default)

2. Extract:
   - Content: page.evaluate() → main content text, headings, links
   - Interactive: page.locator('body').ariaSnapshot() (current)
   - Visual: page.screenshot() (current)

3. Compress:
   - Content: compressor pipeline → 6K chars (current)
   - Interactive: trim non-interactive ARIA nodes, cap 4K chars
   - Visual: JPEG q=60 (current)

4. Token budget per page:
   - Content: ~1,500 tokens (6K chars)
   - Interactive: ~1,000 tokens (4K chars)
   - Visual: ~1,600 tokens (image)
```

Classification heuristic (zero-cost, runs in page.evaluate):
```javascript
() => {
  const interactive = document.querySelectorAll('input, select, textarea, button, [role="button"]').length;
  const contentLength = document.querySelector('article, main')?.textContent?.length || 0;
  if (interactive > 10) return 'interactive';
  if (contentLength > 2000) return 'content';
  return 'interactive'; // default
}
```

### 4C. System Prompt Architecture

Current structure is good. Specific changes:

1. **Fix tier selection**: The standard tier should include LIVE_PREVIEW_RULES and DOCUMENT_RULES (currently excluded even though these tools are always available)
2. **Add compound tool guidance**: Add a rule like "Prefer browser_interact for 2+ sequential browser actions"
3. **Estimated total tokens**: ~2,000 (standard + dynamic + compound tool rules)

### 4D. Conversation Flow Optimization

Current implementation is solid. Key metrics:
- **History trim**: ~5K tokens (20K chars) — good
- **Compression timing**: Applied before every API call (`compressOldToolResults`) — good
- **Keep full**: Last 1 tool_result at full size — good
- **max_tokens dynamic**: 4096 for first/final call, 2048 for intermediate — good

**One improvement**: Reduce intermediate max_tokens from 2048 to 1536. The model primarily emits `tool_use` blocks in intermediate iterations (typically 100-400 tokens), but with the addition of `browser_interact`, multi-step sequences can reach 600-800 output tokens. 1536 provides sufficient headroom while still yielding a ~5-10% inference speed improvement over 2048.

### 4E. Error Recovery Pipeline

Current approach (LLM-driven with hints) is reasonable. One improvement:

**Automatic screenshot on click failure** (in `toolClick`):
When `tryClickRef` fails and no coordinates/selector were provided, automatically take a screenshot and return it with the error message. This saves the LLM one round trip — instead of "Could not click X, try screenshot" → LLM calls screenshot → LLM clicks by coordinates, it becomes "Could not click X, here's what the page looks like" → LLM clicks by coordinates.

---

## 5. Implementation Roadmap — REVISED

Changes have been reorganized into three tiers based on impact-to-effort ratio. Original change numbers are preserved for traceability; new additions reference Section 6.

### Tier 1: Immediate (<3 hours total)

These changes have the highest impact-to-effort ratio and should be implemented first.

---

#### Change 1: Remove Visual Sync from API-Backed Search Tools
**Priority:** Tier 1 | **Impact:** Speed 5 | **Effort:** Low (15 min)

**Files:**
- `src/main/browser/tools.ts`

**What to change:**
Remove the blocking `managerNavigate()` + `waitForLoad()` from `toolSearch`, `toolSearchRich`, `toolNews`, `toolShopping`, `toolPlaces`, `toolImages`.

Replace with fire-and-forget (non-blocking) visual sync:

```typescript
// Before (in toolSearch, line 623-629):
const serpUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
try {
  await managerNavigate(serpUrl);
  await waitForLoad(2000);
} catch { }

// After:
const serpUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
void managerNavigate(serpUrl).catch(() => {}); // fire-and-forget visual sync
```

**Before/after:**
- Before: 2-3s wall-clock per search call
- After: ~0s added latency (navigation happens in background)
- Token change: 0
- Round trips: unchanged

**Risk:** Low. The BrowserView may show the wrong page briefly, but the LLM never reads from it for search results.

---

#### Change 2: Fix Standard Prompt to Include Live Preview + Document Rules
**Priority:** Tier 1 | **Impact:** Accuracy 4 | **Effort:** Low (5 min)

**Files:**
- `src/main/llm/system-prompt.ts`

**What to change:**
In `getStaticPrompt()` (line 264-284), the standard tier doesn't include LIVE_PREVIEW_RULES or DOCUMENT_RULES. But these tools are always in the tool list. The LLM has no guidance on how to use them.

```typescript
// Before (line 276):
if (tier === 'full') {
  parts.push(LIVE_PREVIEW_RULES);
  parts.push(DOCUMENT_RULES);
}

// After:
// Include live preview and document rules in standard tier too
parts.push(LIVE_PREVIEW_RULES);
parts.push(DOCUMENT_RULES);
```

**Before/after:**
- Token cost: +~200 tokens per call (but cached, so 90% discount on iteration 2+)
- Accuracy: LLM now knows how to use live preview and create_document properly
- Round trips: unchanged

**Risk:** Very low. Just adds instructions the LLM was missing.

---

#### Change 3: Add Compound `browser_interact` Tool
**Priority:** Tier 1 | **Impact:** Speed 4, Accuracy 3, Consistency 4 | **Effort:** Medium (2 hr)

**Files:**
- `src/main/browser/tools.ts` (add tool definition + implementation)
- `src/main/llm/tool-loop.ts` (add to BROWSER_NAVIGATION_TOOL_NAMES set)
- `src/main/llm/system-prompt.ts` (add usage guidance)

**Tool schema:** See Section 4A for the full `browser_interact` definition. Key additions vs the original audit:
- **`url` field**: Optional navigate-before-interact, enabling navigate + interact in a single call
- **`read` action**: Returns ARIA snapshot mid-sequence, eliminating separate `browser_read_page` calls

**Implementation:**
```typescript
async function toolInteract(url: string | undefined, steps: any[], stopOnError = false): Promise<string> {
  const page = getActivePage();
  if (!page) return 'No active page.';

  // Optional: navigate before executing steps
  if (url) {
    await managerNavigate(url);
    await waitForLoad(3000);
  }

  const results: string[] = [];
  for (const step of steps) {
    let result: string;
    switch (step.action) {
      case 'click':
        result = await toolClick(step.ref || '', step.x, step.y, step.selector);
        break;
      case 'type':
        result = await toolType(step.text || '', step.ref, Boolean(step.enter));
        break;
      case 'scroll':
        result = await toolScroll(step.dir, step.amount);
        break;
      case 'wait':
        await page.waitForTimeout(Math.min(step.ms || 500, 3000));
        result = `Waited ${step.ms || 500}ms.`;
        break;
      case 'screenshot':
        result = await toolScreenshot();
        break;
      case 'read':
        result = await getPageSnapshot(page);
        break;
      default:
        result = `Unknown action: ${step.action}`;
    }
    results.push(result);

    // Abort remaining steps if this one failed and stopOnError is true
    if (stopOnError && (result.toLowerCase().includes('could not') || result.toLowerCase().includes('failed'))) {
      results.push(`Stopped: step ${results.length} failed with stopOnError enabled. ${steps.length - results.length} steps skipped.`);
      break;
    }
  }

  const title = await page.title().catch(() => '');
  const finalUrl = page.url();
  results.push(`→ ${title} (${finalUrl})`);

  return results.join('\n');
}
```

**System prompt guidance to add:**
```
COMPOUND ACTIONS: Use browser_interact for 2+ sequential browser actions instead of
separate tool calls. Include url to combine navigation with interaction. Use the read
action to get page state mid-sequence instead of a separate browser_read_page call.
Use stopOnError: true when steps are dependent (e.g., login flows where typing
a password requires the login click to succeed first). Use stopOnError: false
(default) for independent steps or when you want partial results.
```

**Before/after for "Post a tweet":**
- Before: 5 round trips (navigate, click, type, click, screenshot) = 5 API calls
- After: 1 round trip (interact with url + 4 steps) = 1 API call
- Token savings: ~80% fewer input tokens (4 fewer API calls x ~6K input tokens each)
- Wall-clock savings: ~50% (4 fewer API round trips x ~2-3s each)

**Risk:** Medium. Mitigated by per-step results and optional `stopOnError` flag for dependent sequences.

---

#### Addition 4: Cache Hit Rate Monitoring
**Priority:** Tier 1 | **Impact:** Enables measurement of all other savings | **Effort:** Low (15 min)

See Section 6, Addition 4 for full details. This is a ~10-line logging addition to `client.ts` that logs prompt cache hit/miss rates. Required before other changes so we can measure their impact.

---

### Tier 2: Next (<2 hours total)

These changes provide meaningful improvements and should follow Tier 1.

---

#### Change 4: Reduce Intermediate max_tokens from 2048 to 1536
**Priority:** Tier 2 | **Impact:** Speed 2 | **Effort:** Low (2 min)

**Files:**
- `src/main/llm/tool-loop.ts`

**What to change:**
```typescript
// Before (line 1072):
return 2048; // intermediate tool loop — model just emits tool_use blocks

// After:
return 1536; // intermediate: tool_use blocks (100-400 tokens) + browser_interact steps (~800 tokens)
```

**Why 1536, not 1024:** With the addition of `browser_interact` (Change 3), intermediate calls may include multi-step action sequences. A `browser_interact` call with 6-8 steps can produce ~600-800 output tokens for the step definitions alone. Setting max_tokens to 1024 would risk truncation; 1536 provides sufficient headroom while still reducing from 2048.

**Before/after:**
- Inference speed: ~5-10% faster per intermediate call (smaller output window)
- Token change: Negligible (output rarely exceeds 1536 in intermediate calls)
- Risk: Very low — 1536 provides ample room for `browser_interact` sequences

---

#### Change 5: Automatic Screenshot on Click Failure
**Priority:** Tier 2 | **Impact:** Accuracy 3, Consistency 3 | **Effort:** Low (20 min)

*(Was Change 6 in original audit — reordered for higher accuracy impact)*

**Files:**
- `src/main/browser/tools.ts`

**What to change:**
In `toolClick`, when all click strategies fail and the LLM didn't provide coordinates:

```typescript
// Before (line 839-843):
if (!clicked) {
  const hint = ref.trim()
    ? `Could not click "${ref}". Try browser_screenshot to see the page, then click with x/y coordinates.`
    : 'No click target specified.';
  return hint;
}

// After:
if (!clicked) {
  if (ref.trim()) {
    // Auto-screenshot to save a round trip
    const screenshot = await toolScreenshot();
    return JSON.stringify({
      __clawdia_image_result__: true,
      image_base64: JSON.parse(screenshot).image_base64,
      media_type: 'image/jpeg',
      text: `Could not click "${ref}". Here is the current page — use x,y coordinates from this screenshot to click the element.`,
    });
  }
  return 'No click target specified.';
}
```

**Before/after:**
- Round trips saved: 1 per click failure (skip the separate screenshot call)
- Token change: +1,600 tokens (image) per failed click, but saves ~6K tokens (the next API call)

**Risk:** Low-medium. Adds image tokens on click failure. But click failures are expensive anyway — this saves a full round trip.

---

#### Change 6: Replace 500ms Post-Click waitForTimeout
**Priority:** Tier 2 | **Impact:** Speed 2 | **Effort:** Low (10 min)

*(Was Change 5 in original audit — reordered)*

**Files:**
- `src/main/browser/tools.ts`

**What to change:**
```typescript
// Before (line 849):
await page.waitForTimeout(500);

// After:
// Wait for any SPA navigation that the click might trigger, with short timeout
await page.waitForLoadState('domcontentloaded', { timeout: 800 }).catch(() => null);
```

**Before/after:**
- Wall-clock: -500ms per click (or -300ms if `waitForLoadState` returns quickly)
- Accuracy: Unchanged — event-driven wait is more reliable than fixed timeout

**Risk:** Low. Some SPAs might not trigger `domcontentloaded`. The catch ensures it doesn't block.

---

#### Addition 1: `browser_fill_form` Macro Tool
**Priority:** Tier 2 | **Impact:** Speed 3, Consistency 4 | **Effort:** Medium (1 hr)

See Section 6, Addition 1 for full spec, schema, matching strategy, and before/after analysis.

---

#### Addition 2: Output Token Optimization
**Priority:** Tier 2 | **Impact:** Token savings 15-25% output per session | **Effort:** Medium (45 min)

See Section 6, Addition 2 for shorter param names, system prompt instruction, and tool return format audit.

---

#### Addition 5: Tool Result Return String Audit
**Priority:** Tier 2 | **Impact:** Token savings 20-40% per tool_result | **Effort:** Medium (30 min)

See Section 6, Addition 5 for the full table of current vs optimized return strings.

---

### Tier 3: When Time Permits

These changes have lower impact-to-effort ratios or need more data before implementation.

---

#### Change 7: Deferred Tool Loading by Intent Class
**Priority:** Tier 3 | **Impact:** 10-20% input tokens on simple tasks | **Effort:** Medium (1 hr)

**Note — Deprioritized:** The token savings from deferred tool loading are *cached tokens* (90% discount). On iteration 1, skipping 10-19 tool definitions saves ~1,000-1,400 tokens at full price. On iterations 2+, those same tokens are cached and cost only 100-140 tokens. The real savings depend on cache miss rate — implement Addition 4 (cache monitoring) first, then revisit this change with data.

**Files:**
- `src/main/llm/intent-router.ts` (extend to classify browser-only vs local-only vs both)
- `src/main/llm/tool-loop.ts` (filter tool list based on intent class)

**What to change:**
Extend `classifyIntent` to return `'tools-browser'`, `'tools-local'`, or `'tools-all'` instead of just `'tools'`:

```typescript
// Add to intent-router.ts:
export type ToolClass = 'browser' | 'local' | 'all';

export function classifyToolClass(message: string): ToolClass {
  const hasBrowser = WEB_SIGNALS.test(message) || URL_PATTERNS.test(message) ||
                     SHOPPING_SIGNALS.test(message) || NOTIFICATION_SIGNALS.test(message);
  const hasLocal = FILE_PATTERNS.test(message) || SYSTEM_SIGNALS.test(message) ||
                   DOCUMENT_SIGNALS.test(message);

  if (hasBrowser && !hasLocal) return 'browser';
  if (hasLocal && !hasBrowser) return 'local';
  return 'all';
}
```

Then in `tool-loop.ts`, filter the tool list:
```typescript
const toolClass = classifyToolClass(augmentedMessage);
if (toolClass === 'browser') {
  tools = ALL_TOOLS.filter(t => !LOCAL_TOOL_NAMES.has(t.name) || t.name === 'shell_exec');
} else if (toolClass === 'local') {
  tools = ALL_TOOLS.filter(t => LOCAL_TOOL_NAMES.has(t.name) || t.name === 'sequential_thinking');
}
```

**Before/after:**
- Browser-only: ~1,100 fewer tokens (skip 7 local tool defs)
- Local-only: ~1,400 fewer tokens (skip 19 browser tool defs)
- These savings are cached, so they affect cache_creation cost (first call only)

**Risk:** Medium. False classification could prevent the LLM from using needed tools. Conservative fallback to 'all' mitigates this.

---

#### Change 8: Smarter ARIA Snapshot Compression for Content Pages
**Priority:** Tier 3 | **Impact:** 15-25% per navigate/read on content pages | **Effort:** Medium (30 min)

**Note — Deprioritized:** The page classification heuristic (interactive count > 10, content length > 2000) is fragile and hard to test across the diversity of real-world pages. False positives (interactive page classified as content) would degrade click/type accuracy. Defer until data shows ARIA snapshot size is a significant cost driver, or until a more robust classifier exists.

**Files:**
- `src/main/browser/tools.ts` (in `getPageSnapshot`)

**What to change:**
Add a page type check before choosing representation:

```typescript
async function getPageSnapshot(page: Page): Promise<string> {
  const title = await page.title().catch(() => '');
  const url = page.url() || 'about:blank';

  // Classify: if the page has significant article/main content, use text extraction
  // instead of ARIA (which is verbose for content pages)
  const pageType = await page.evaluate(() => {
    const main = document.querySelector('article, main, [role="main"]');
    const inputs = document.querySelectorAll('input, select, textarea').length;
    const buttons = document.querySelectorAll('button, [role="button"]').length;
    const contentLen = main?.textContent?.trim().length || 0;
    if (contentLen > 3000 && inputs < 5 && buttons < 10) return 'content';
    return 'interactive';
  }).catch(() => 'interactive');

  let content = '';
  if (pageType === 'content') {
    // For content pages, direct text extraction is more efficient than ARIA
    const rawText = await page.evaluate(() => {
      const main = document.querySelector('article, main, [role="main"]') || document.body;
      return (main?.textContent || '').trim().substring(0, 30_000);
    });
    content = compressPageContent(rawText, { maxChars: 6_000 }).text;
  } else {
    // For interactive pages, ARIA snapshot is better
    try {
      const ariaSnapshot = await page.locator('body').ariaSnapshot({ timeout: 1500 });
      if (ariaSnapshot?.trim()) {
        content = compressPageContent(ariaSnapshot, { maxChars: 6_000 }).text;
      }
    } catch { /* fallback below */ }

    if (!content) {
      const rawText = await page.evaluate(() => {
        const main = document.querySelector('article, main, [role="main"]') || document.body;
        return (main?.textContent || '').trim().substring(0, 30_000);
      });
      content = compressPageContent(rawText, { maxChars: 6_000 }).text;
    }
  }

  // Store in cache...
  // (rest unchanged)
}
```

**Before/after:**
- Content pages: ~15-25% smaller snapshots (no ARIA role annotations, no link/button metadata)
- Interactive pages: unchanged
- Accuracy on content pages: Improved (less noise, more content)

**Risk:** Low. Fallback to current behavior if classification fails.

---

## 6. New Additions (Not in Original Audit)

These gaps were identified during expert review and were not covered in the original 8-change roadmap.

### Addition 1: `browser_fill_form` Macro Tool
**Tier:** 2 | **Impact:** Speed 3, Consistency 4, Token savings 60-83% for form workflows | **Effort:** Medium (1 hr)

**Problem:** Filling a 5-field form currently requires 10-12 round trips: for each field, the LLM must click the input, type the value, and sometimes tab or click the next field. Even with `browser_interact`, a 5-field form needs 10 steps (click+type per field) in the sequence.

**Solution:** A dedicated `browser_fill_form` tool that accepts a list of `{label, selector, value, type}` pairs and fills them all in one call using Playwright's native form methods.

**Schema:** See Section 4A for the full `browser_fill_form` definition.

**Matching strategy (in order of preference):**
1. `label[for="id"]` → find input by associated label
2. `[aria-label="..."]` → match aria-label attribute
3. `[placeholder="..."]` → match placeholder text
4. `[name="..."]` → match name attribute
5. CSS selector fallback → direct selector provided by LLM

**Implementation approach:**
```typescript
async function toolFillForm(fields: FormField[], submit?: SubmitTarget): Promise<string> {
  const page = getActivePage();
  if (!page) return 'No active page.';

  const results: string[] = [];
  for (const field of fields) {
    const locator = resolveFormField(page, field); // tries matching strategy 1-5
    try {
      switch (field.type || 'text') {
        case 'select':
          await locator.selectOption(field.value);
          break;
        case 'checkbox':
        case 'radio':
          field.value === 'true' ? await locator.check() : await locator.uncheck();
          break;
        default:
          await locator.fill(field.value);
      }
      results.push(`${field.label || field.selector}: filled`);
    } catch (e) {
      results.push(`${field.label || field.selector}: FAILED — ${e.message}`);
    }
  }

  if (submit) {
    const btn = submit.selector ? page.locator(submit.selector) : page.getByRole('button', { name: submit.ref });
    await btn.click();
    results.push(`Submitted via "${submit.ref || submit.selector}".`);
  }

  return results.join('\n');
}
```

**Before/after for "Fill a 5-field signup form":**
- Before: 12 round trips (navigate, read, then 5× click+type, then click submit) = 12 API calls
- After: 2 round trips (navigate+read via `browser_interact`, then `browser_fill_form`) = 2 API calls
- Token savings: ~83% fewer input tokens
- Accuracy: Higher — Playwright's `fill()` is more reliable than click-then-type for form inputs

**System prompt guidance:**
```
FORM FILLING: Use browser_fill_form instead of sequential click+type for forms with 2+
fields. Provide label text for each field — the tool will match inputs by label, aria-label,
placeholder, or name attribute. Include submit to click the submit button after filling.
```

---

### Addition 2: Output Token Optimization
**Tier:** 2 | **Impact:** Token savings 15-25% output per session | **Effort:** Medium (45 min)

**Problem:** Output tokens are 3-5x more expensive than input tokens and are never cached. The LLM generates verbose tool_use blocks and explanatory text that compounds across iterations. Addition 2 focuses on **what the LLM generates** (output-side): shorter parameter names in schemas, and a system prompt instruction to suppress unnecessary narration between tool calls.

**Two sub-changes:**

**2a. Shorter parameter names in `browser_interact`**
Already addressed in the schema design (Section 4A): `dir` instead of `direction`, `ms` instead of `duration`, `enter` instead of `pressEnter`. Saves ~5-10 output tokens per multi-step call.

**2b. System prompt instruction for terse intermediate responses**
Add to CORE_TOOL_RULES:
```
OUTPUT ECONOMY: When calling tools, do not include explanatory text before or after the
tool call. Just call the tool. Save explanations for the final response to the user.
```
This reduces the common pattern where the LLM says "Let me click the submit button" before each `tool_use` block — typically 10-30 wasted output tokens per iteration.

**Before/after:**
- Output tokens per intermediate iteration: ~150-400 → ~120-300 (20-30% reduction)
- Sources: ~5-10 tokens saved from shorter param names, ~10-30 tokens saved from suppressing narration
- Over a 6-iteration tool loop: ~100-300 fewer output tokens

---

### Addition 3: Parallel Tool Execution
**Tier:** 3 (partially implemented) | **Impact:** Speed 2-3 on multi-tool iterations | **Effort:** Low-Medium

**Current state:** `tool-loop.ts` **already implements parallel tool execution** via `executeToolsParallel()` (line ~1110). The current logic:
- Browser navigation tools (`BROWSER_NAVIGATION_TOOL_NAMES` set) are executed **sequentially** — correct, they have side effects and ordering matters
- All other tools (search, extract, shell, file ops) are executed via `Promise.all` — already parallel

**What's left to do:**
1. **Expand the parallel-safe set**: Some tools currently treated as sequential could run in parallel. For example, multiple `browser_search` calls with different queries are stateless and could parallelize. The current `BROWSER_NAVIGATION_TOOL_NAMES` set is conservative.
2. **Encourage parallel tool calls in the system prompt**: Add guidance like "You can call multiple search/extract tools in parallel when the queries are independent" so the LLM emits multiple `tool_use` blocks in one response.
3. **Log parallel execution stats**: Track how often the LLM actually emits multiple tool calls per response, and whether the parallel execution path is being used.

**Before/after:**
- Multi-search queries: 2-3 sequential API calls (~4-6s) → 1 parallel execution (~2-3s)
- Already optimal for: single-tool iterations, browser_navigate chains
- This is a refinement, not a fundamental change — hence Tier 3

---

### Addition 4: Cache Hit Rate Monitoring
**Tier:** 1 | **Impact:** Enables measurement of all other optimizations | **Effort:** Low (15 min)

**Problem:** We have no visibility into prompt cache performance. Without knowing the cache hit rate, we can't measure the real-world impact of token reduction changes or validate that cache breakpoints are working.

**Implementation — add to `client.ts` response handler:**
```typescript
// After receiving API response, log cache stats:
const usage = response.usage;
if (usage) {
  const cacheRead = usage.cache_read_input_tokens || 0;
  const cacheCreate = usage.cache_creation_input_tokens || 0;
  const totalInput = usage.input_tokens || 0;
  const fresh = totalInput - cacheRead - cacheCreate;
  const hitRate = totalInput > 0 ? ((cacheRead / totalInput) * 100).toFixed(1) : '0.0';

  logger.info(`[Cache] hit=${hitRate}% | read=${cacheRead} create=${cacheCreate} fresh=${fresh} total=${totalInput} output=${usage.output_tokens || 0}`);
}
```

**What this enables:**
- Baseline cache hit rate before any changes
- Per-change measurement: did removing tool defs improve or hurt cache performance?
- Session-level cost tracking: actual effective tokens per session
- Anomaly detection: if cache hit rate drops below 70%, something is wrong with breakpoint placement

**Risk:** None — logging only, no behavioral changes.

---

### Addition 5: Tool Result Return String Audit
**Tier:** 2 | **Impact:** Token savings 20-40% per tool_result | **Effort:** Medium (30 min)

**Problem:** Tool return strings are verbose and every character becomes input tokens on the next API call. Unlike output token optimization (Addition 2) which reduces what the LLM generates, Addition 5 reduces what the **tools return to the LLM** (input-side on subsequent iterations). These are independent changes — implement either or both.

**Current vs optimized return strings:**

| Tool | Current return | Optimized return | Savings |
|------|---------------|-----------------|---------|
| `browser_click` | `Clicked "Submit". Page title: "Thanks" URL: https://...` | `Clicked "Submit". → Thanks (https://...)` | ~30% |
| `browser_type` | `Typed "hello world" into the text field.` | `Typed "hello world".` | ~40% |
| `browser_scroll` | `Scrolled down on the page.` | `Scrolled down.` | ~35% |
| `browser_navigate` | `Page: Title\nURL: https://...\n\n[6K ARIA snapshot]` | `Title (https://...)\n\n[6K snapshot]` | ~5% (header only) |
| `browser_search` | `Search results for "query":\n1. Title - snippet (url)\n...` | `"query" results:\n1. Title - snippet (url)\n...` | ~10% |
| `browser_tab` | `Opened new tab and navigated to https://...` | `Tab opened → https://...` | ~40% |
| `toolInteract` step results | `Clicked "Post". Typed "hello". Waited 500ms.` | `click:ok type:ok wait:500ms` | ~50% |

**Implementation approach:**
- Audit each tool's return string in `tools.ts`
- Replace verbose English sentences with compact key:value or arrow notation
- Preserve all information content — just remove filler words
- The LLM doesn't need "Scrolled down on the page" — "Scrolled down." conveys the same meaning

**Before/after:**
- Average tool_result size: ~150 chars → ~100 chars (33% reduction)
- Per-iteration input savings: ~12 tokens (most recent result) + ~2-5 tokens (compressed old results)
- Over a 6-iteration loop: ~80-120 fewer tokens

---

## 7. Revised Scoring

### Current Score: 62/100

Breakdown by category (from Section 3 gap analysis):

| Category | Current | Max | Notes |
|----------|---------|-----|-------|
| Tool efficiency (round trips) | 14/25 | 25 | Single-action tools require excessive round trips |
| Token economy | 16/25 | 25 | Good caching, but verbose returns and no output optimization |
| Speed (latency) | 15/20 | 20 | Visual sync adds 2-3s/call, 500ms post-click delays |
| Accuracy/reliability | 12/15 | 15 | Good error recovery, missing form filling, missing auto-screenshot |
| Observability | 5/15 | 15 | No cache monitoring, no token tracking per session |
| **Total** | **62** | **100** | |

### After Tier 1: ~71-74/100

| Change | Points gained | Rationale |
|--------|--------------|-----------|
| Change 1 (remove visual sync) | +3 | Speed: eliminates 2-3s per search call |
| Change 2 (fix standard prompt) | +2 | Accuracy: LLM now has live preview + document guidance |
| Change 3 (browser_interact) | +5 | Tool efficiency: 5→1 round trips for interactive workflows |
| Addition 4 (cache monitoring) | +2 | Observability: baseline cache measurement (one metric, not full observability) |
| **Tier 1 total** | **+9-12** | **→ 71-74/100** |

*Note: Full observability (per-session cost tracking, tool success rates, latency percentiles, error categorization) would require additional instrumentation beyond cache monitoring. Addition 4 provides the single most important metric but is not comprehensive.*

### After Tier 2: ~77-80/100

| Change | Points gained | Rationale |
|--------|--------------|-----------|
| Change 4 (reduce max_tokens) | +1 | Speed: slightly faster intermediate calls |
| Change 5 (auto-screenshot on failure) | +1 | Accuracy: saves 1 round trip on click failures |
| Change 6 (replace 500ms wait) | +1 | Speed: event-driven wait instead of fixed delay |
| Addition 1 (browser_fill_form) | +2 | Tool efficiency: 12→2 round trips for forms |
| Addition 2 (output token optimization) | +1 | Token economy: 15-25% fewer output tokens |
| Addition 5 (tool result audit) | +1 | Token economy: 20-40% smaller tool returns |
| **Tier 2 total** | **+5-7** | **→ 77-80/100** |

### After Tier 3: ~82-85/100

| Change | Points gained | Rationale |
|--------|--------------|-----------|
| Change 7 (deferred tool loading) | +2 | Token economy: conditional on cache miss rate data |
| Change 8 (ARIA compression) | +2 | Token economy: conditional on page type distribution data |
| Addition 3 (expand parallel set) | +1 | Speed: refinement of existing parallel execution |
| **Tier 3 total** | **+3-5** | **→ 82-85/100** |

### Theoretical Maximum: ~90/100

The remaining ~10 points represent fundamental limitations that are unlikely to be resolved within the current architecture:

1. **LLM reasoning overhead (~3 points):** The model sometimes takes suboptimal paths regardless of available tools. Better prompting helps but can't eliminate this entirely.
2. **Page representation gap (~3 points):** No Set-of-Marks (SoM) implementation for complex visual UIs. ARIA + screenshots work but aren't as efficient as numbered bounding boxes.
3. **Dynamic page complexity (~2 points):** SPAs with lazy-loading, infinite scroll, and dynamic content remain challenging. No amount of tool optimization can fully address JavaScript-heavy page state.
4. **Cache cold start (~2 points):** First API call in a session always pays full price for system prompt + tool definitions. Anthropic's prompt caching has a TTL — sessions with long gaps between calls lose their cache.

---

## 8. Verification Checklist

After implementing each tier, run these verification steps before proceeding to the next tier.

### After Tier 1

1. **Change 1 (visual sync removal):** Run `browser_search("test query")` — should return results in <1s with no BrowserView navigation delay. The browser panel may show stale content; this is expected.
2. **Change 2 (prompt fix):** Ask "create a document about X" — the LLM should use `create_document` tool correctly instead of dumping text into chat.
3. **Change 3 (browser_interact):** Test compound action: "Go to x.com and post 'hello world'" — should complete in 1-2 API calls, not 5. Verify per-step results appear in tool output. Test `stopOnError: true` by providing an invalid click ref as step 1 followed by a type step — step 2 should be skipped.
4. **Addition 4 (cache monitoring):** Check console/logs after any 3+ iteration tool loop. Verify `[Cache]` log lines appear with hit rate >70% on iteration 2+. If hit rate is below 50%, investigate cache breakpoint placement.

### After Tier 2

5. **Change 4 (max_tokens):** Verify no tool_use truncation in logs. Run a `browser_interact` with 6 steps — output should complete without hitting the 1536 limit.
6. **Change 5 (auto-screenshot on failure):** Call `browser_click` with a ref that doesn't exist on the page. Response should include both an error message AND a screenshot image — not just a text hint.
7. **Change 6 (event-driven wait):** Click a button that triggers SPA navigation. Verify the click returns faster than before (~300ms instead of ~500ms) without missing the navigation.
8. **Addition 1 (browser_fill_form):** Navigate to a form with 3+ fields. Call `browser_fill_form` with labels matching the visible form. Verify all fields are filled correctly and per-field results report success. Test with a `<select>` dropdown and a checkbox.
9. **Addition 2 (output optimization):** Compare tool loop logs before and after. Output tokens per intermediate call should be ~20-30% lower.
10. **Addition 5 (tool result audit):** Compare tool_result sizes in logs before and after. `browser_click` results should be noticeably shorter. `browser_type` results should be ~3-5 words, not full sentences.

### After Tier 3

11. **Change 7 (deferred loading):** Test "read my file.txt" — only local tools should appear in the API call. Test "search for X" — only browser tools should appear. Test "search for X and save to file" — all tools should appear. Log the tool count per call to verify.
12. **Change 8 (ARIA compression):** Navigate to a news article — snapshot should be text-based, not ARIA. Navigate to a web app — snapshot should be ARIA. Compare token counts.
13. **Addition 3 (parallel expansion):** Ask the LLM to search for 3 different topics. Verify that if it emits 3 `browser_search` calls in one response, all 3 execute concurrently (check timestamps in logs).

### Regression Checks (run after every tier)

- Twitter posting still works end-to-end
- Google search returns correct results
- File read/write/edit work correctly
- `npm run build` passes
- No new TypeScript errors in `npx tsc -p tsconfig.main.json --noEmit`

---

## Appendix: Raw Token Counts

### System Prompt — Standard Tier (actual text, estimated tokens)
```
Identity line:                    ~20 tokens
CORE_TOOL_RULES:                 ~475 tokens
BROWSER_ACCESS_RULES:            ~450 tokens
THINKING_RULES:                  ~250 tokens
TOOL_INTEGRITY_RULES:            ~125 tokens
SELF_KNOWLEDGE:                  ~400 tokens
Dynamic (date+system+model):     ~75 tokens
────────────────────────────────
Total:                           ~1,795 tokens
```

### Tool Definitions — All 27 Tools
```
Browser tools (19):              ~1,285 tokens
Local tools (7):                 ~615 tokens
Sequential thinking (1):        ~218 tokens
────────────────────────────────
Total:                           ~2,118 tokens
```

### Typical Full Input (first API call with tools)
```
System prompt:                   ~1,795 tokens (cached after first call)
Tool definitions:                ~2,118 tokens (cached after first call)
Conversation history (5 msgs):   ~500 tokens
User message:                    ~50 tokens
────────────────────────────────
Total:                           ~4,463 tokens
Cache-eligible:                  ~3,913 tokens (88%)
```

### Typical Full Input (tool loop iteration 3)
```
System prompt:                   ~1,795 tokens (cached)
Tool definitions:                ~2,118 tokens (cached)
History (compressed):            ~1,000 tokens (old results truncated)
Previous assistant (tool_use):   ~200 tokens
Previous tool_result:            ~500 tokens (cached via breakpoint 3)
New tool_result:                 ~500 tokens (fresh)
────────────────────────────────
Total:                           ~6,113 tokens
Cached:                          ~5,113 tokens (84%)
Fresh:                           ~1,000 tokens
Effective cost:                  ~1,511 tokens (1000 fresh + 5113 × 0.1 cache)
```

### Round Trip Counts — Before vs After All Changes
| Workflow | Current | After All Changes | Savings |
|----------|---------|-------------------|---------|
| Simple search query | 1-2 | 1-2 | ~2-3s faster (no visual sync) |
| Search + read page | 2-3 | 2-3 | ~2-3s faster (no visual sync) |
| Post a tweet | 5 | 1 | 80% fewer API calls (browser_interact with url) |
| Fill a 5-field form | 12 | 2 | 83% fewer API calls (browser_fill_form) |
| Check Instagram DMs | 3-5 | 1-2 | 60-80% fewer API calls (browser_interact) |
| Navigate + extract data | 2 | 2 | 0 (already optimal) |
| Multi-URL research | 1-2 | 1-2 | 0 (browser_batch already good; stateless tools already parallel) |
| Failed click recovery | 3 | 2 | 33% fewer API calls (auto-screenshot on failure) |
| Multi-source research | 3-4 (sequential) | 2-3 (parallel search) | ~30% faster wall-clock (parallel stateless tools) |
