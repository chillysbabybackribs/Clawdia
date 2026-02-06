# Optimal Implementation Review

## Summary
- The optimal design proposes a three-layer planner/executor/reporter flow that keeps raw page content out of the context window, compresses tool outputs, and avoids redundant browser calls.
- Clawdia currently uses a single-pass tool loop (`src/main/llm/tool-loop.ts:1`) where the LLM receives uncompressed tool results, generates the next move, and often repeats the cycle hundreds of times for research-level tasks.
- This review contrasts the ideal architecture with the current implementation to identify gaps, risks, and concrete upgrades.

## Layer Comparison

### Layer 1 — Planner
- **Optimal**: A planner prompt makes a concise action plan without reading HTML, keeps goals terse, and targets 2–3 tool calls for research. It prevents the LLM from narrating or polling tool internals and enforces efficiency targets.
- **Current**: Routing decisions are handled in `src/main/llm/router.ts:1`, but the LLM still sees every piece of tool output as it executes. There is no dedicated planner that thinks in actions independent of execution. Therefore, every research request triggers the existing tool loop rather than a compact plan.

### Layer 2 — Executor
- **Optimal**: Tool results flow through compression middleware that prunes page text to titles/headings/goal-specific snippets before the planner sees them. Compound tools batch navigation/wait/read/extract so a single tool call covers what used to be 4–5 sequential calls.
- **Current**: `src/main/llm/tool-loop.ts:1` immediately relays raw `BrowserTools.executeTool` results (`src/main/browser/tools.ts:150`) back into the context. There is no compression middleware, no eviction of large tool payloads, and only simple built-in compound tools (e.g., `browser_search`) without goal-aware trimming. Each search/navigation/observe cycle reintroduces thousands of tokens, which balloon the context window and slow the agent.

### Layer 3 — Reporter
- **Optimal**: Synthesis only sees compressed evidence, never rereads pages, and cites sources after the executor has distilled them. Tool outputs are evicted from context once processed.
- **Current**: The synthesizer (`src/main/llm/synthesizer.ts:1`) runs after all searches but still relies on the raw collected strings. No eviction is happening, so previously processed `browser_observe` content stays in memory. There is no automated eviction step, nor is there a pacing mechanism to nudge the LLM when tool-limit thresholds are hit.

## Token Strategy & Optimization Gaps
- Tool results (page reads, search snippets) are never compressed or evicted, so each round trip saddles the context with ~2K tokens for every page and SERPs. The optimal spec keeps only 15-token placeholders after extraction.
- There is no middleware to enforce extraction goals. `BrowserTools.extract` returns whatever the page contains without filtering per user goal, so the LLM still has to deduplicate and interpret verbose text.
- Parallelism and speculative execution are missing; the existing loop waits for each tool call to finish before issuing the next. The executor never batches multiple reads nor warms caches.
- Conversation history compression is also absent; the code retains all turns (`conversationManager`) without summarizing older ones for the router or tool loop.

## Risks & Recommendations
1. **Token exhaustion**: Without compression or eviction, complex research tasks exhaust whichever backend window is configured. Implement an executor middleware that trims page/search output (title/headings/snippets) before injecting it back into the context, as suggested in the optimal design.
2. **Sequential inefficiency**: The current loop (tool loop calling each `BrowserTools` method in turn) lacks compound actions beyond `browser_search`. Extend executor tooling with multi-step helpers (`browser_search_and_extract`, `browser_get_data`) so that deeper workflows complete in 1–2 tool calls.
3. **Planner/goal isolation**: Extract a planner prompt that never sees HTML but produces structured actions; rewire the loop so the executor executes the plan and the reporter synthesizes from compressed summaries.
4. **History & persistence**: Add tooling for eviction summaries and frequent-site history accessible to both browser and LLM, so repeated visits leverage cached descriptions rather than rereading pages.
5. **Context hygiene**: Introduce scheduled summary/eviction of older turns (e.g., after 5 exchanges) so the router and planner operate on focused context.
6. **Executor awareness**: Encode session-aware instructions (permissions, cookie usage) inside the executor middleware or tool definitions, similar to the “Session context” addendum in the optimal spec, so the agent knows when it can act on authenticated resources without reintroducing entire pages.

## Next Steps
- Prototype a middleware layer that intercepts `BrowserTools.executeTool` responses and compresses them according to the user’s extraction goal (title/headings/snippets only).
- Define compound tools for search+extract and multi-page comparisons, expose them via the tool loop, and ensure the planner uses them instead of raw sequential calls.
- Add a plan-generation prompt (planner) and enforce an efficiency budget within the router so that research requests trigger structured tasks rather than repeated browse cycles.
- Implement context eviction: once the reporter has consumed a tool result, replace it with a 10–20-token summary placeholder (tool status, URL, extraction goal).
- Build a history tab/quick-access row backed by `frequent-site` data and expose it to the planner/executor so repeated sites don’t require new reads.

By aligning Clawdia with the layered architecture described above, we can drastically cut API usage, keep the context window clean, and deliver faster, more reliable research answers.
