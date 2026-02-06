# Multi-Model Agent Pipeline Implementation Plan

## Overview

Replace the single-model tool loop (all Sonnet) with a two-model pipeline: Haiku executes browser tools and extracts data, then Sonnet synthesizes the final response. This targets the `browse` route — the most cost-intensive path.

## Architecture Summary

```
User message → Router (unchanged) → route decision
  ├── 'chat'     → Sonnet direct (no tools, unchanged)
  ├── 'research'  → Existing executor pipeline (unchanged for now)
  └── 'browse'   → NEW: Haiku executor → Sonnet synthesizer
```

The `research` route already has its own executor/synthesizer pipeline. We're building an analogous split for the `browse` route.

---

## Step 1: Model Configuration (`src/main/llm/model-config.ts`)

**New file.** Defines model roles and configuration.

Default config:
- executor: `claude-haiku-4-5-20251001`, maxTokens=2048, temp=0.0
- synthesizer: `claude-sonnet-4-20250514`, maxTokens=4096, temp=0.7

Storage: Add to existing electron-store schema. New keys: `pipeline_enabled`, `executor_model`, `synthesizer_model`.

Fallback: If `pipeline_enabled` is false/unset, existing single-model behavior used.

---

## Step 2: Extend AnthropicClient (`src/main/llm/client.ts`)

Add optional `model` parameter to constructor (currently hardcoded to Sonnet).
Add optional `maxTokens` to `chat()` method.
Backward-compatible — all existing callers unchanged.

---

## Step 3: Executor Agent (`src/main/llm/executor-agent.ts`)

**New file.** Haiku-powered tool loop for browse route.

- Runs tool loop using Haiku (fast, cheap)
- Hard limit: 8 tool calls (nudge at 6, force-stop at 8)
- Specialized system prompt: search, extract, return JSON findings
- Emits progress events (searching, visiting, extracting, complete)
- Reuses BrowserTools, compressToolResult, tab summaries, duplicate search detection
- Returns structured `ExecutorResult` with findings, confidence, metadata

---

## Step 4: Synthesizer Agent (`src/main/llm/synthesizer-agent.ts`)

**New file.** Sonnet-powered response composer for browse route.

- Single LLM call to Sonnet
- Receives user query + executor's findings
- No tools (empty array)
- Streams text back via callback
- Simple — not the research Synthesizer class

---

## Step 5: Pipeline Orchestrator (`src/main/llm/pipeline.ts`)

**New file.** Orchestrates executor → synthesizer.

1. Compress conversation history for executor context
2. Run executor (Haiku) with progress events
3. Run synthesizer (Sonnet) with streaming
4. Return response + metadata

---

## Step 6: Wire into Main (`src/main/main.ts`)

- Modify `handleBrowseRoute()`: check `pipeline_enabled`, use pipeline or fall back to ToolLoop
- Add `loadPipelineConfig()` helper
- Add pipeline settings to SETTINGS_GET/SET
- Add stop support for active pipeline

---

## Step 7: Error Handling

- Executor failure → synthesizer with empty findings → honest "couldn't find" response
- Unparseable executor output → low-confidence finding → synthesizer handles gracefully
- Single-model fallback always available

---

## File Changes

| File | Action |
|------|--------|
| `src/main/llm/model-config.ts` | CREATE |
| `src/main/llm/client.ts` | MODIFY (add model/maxTokens params) |
| `src/main/llm/executor-agent.ts` | CREATE |
| `src/main/llm/synthesizer-agent.ts` | CREATE |
| `src/main/llm/pipeline.ts` | CREATE |
| `src/main/main.ts` | MODIFY (wire pipeline, settings, stop) |

No changes to: tools.ts, tool-loop.ts, types.ts, ipc-channels.ts, router.ts

---

## Implementation Order

1. model-config.ts
2. client.ts modifications
3. executor-agent.ts
4. synthesizer-agent.ts
5. pipeline.ts
6. main.ts integration
7. Manual testing
