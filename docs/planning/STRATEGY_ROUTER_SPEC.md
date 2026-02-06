# Strategy Router Specification

## Objective
Provide a minimal, deterministic search query router that works for every prompt without leaking topic-specific injections, while keeping existing research, browse, and chat routes untouched.

## QueryContext extraction (`src/main/search/query_context.ts`)
- Input: the user-facing message passed into `Router.classify`.
- Normalization: whitespace squashed, case preserved for entity detection.
- Entities: extract capitalized phrases, CamelCase tokens, URLs/domains, and explicit “OpenClaw” mentions (capped at six candidates).
- Place hints: regex matches for "near|around|in <place>" populate `entities.placeHint`.
- Intent flags (booleans): 
  - `tech` (install/setup/repo/api/sdk/error/log/stacktrace/documentation)
  - `local` (near me/nearby/city/state/zip/hours/this weekend)
  - `purchase` (best/buy/price/review/vs)
  - `troubleshooting` (error/fix/failed/crash/bug/issue/how to fix/how to resolve/troubleshoot)
  - `timeSensitive` (latest/current/today/now/tonight/this week/this weekend/recent/newest/updated/4-digit year)
- Output: `{ rawText, userGoal, entities: { candidates, placeHint }, intent }` used downstream.

## Strategy Router (`src/main/search/strategy_router.ts`)
1. `local` if `ctx.intent.local` truthy.
2. `tech` if `ctx.intent.tech` or `ctx.intent.troubleshooting` truthy.
3. `general` otherwise.
Only three routes exist—no additional taxonomy creep.

## Strategy Packs (`src/main/search/strategies.ts`)
| Strategy | Planned actions | Notes |
| --- | --- | --- |
| General | 1) `<userGoal>` 2) `<userGoal> overview` unless `intent.purchase`/`intent.troubleshooting`, in which case `how to` | At most two google searches; no GitHub/docs site tags. `normalizeGoal` ensures a non-empty fallback. |
| Local | 1) `<userGoal> near <placeHint or "me">` 2) `<userGoal> hours reviews` (or `this weekend` when `intent.timeSensitive`) | Two google searches, no `site:` host modifiers. Place hints derived deterministically. |
| Tech | Up to three queries:  a) `site:docs.* <entity> (install OR docs OR getting started)` b) `site:github.com <entity> README` c) `<userGoal> (security OR sandbox OR permissions)` (only if raw text mentions safety keywords) | Each action uses the top entity candidate. If no entity exists, fall back to the normalized goal. |

### Targeted OpenClaw injection (strict gating)
- `hasOpenClaw` flag is set when `rawText` or any entity matches `/openclaw/i`.
- The two fixed `site:docs.openclaw.ai`/`site:github.com/openclaw` searches are prepended with `priority: 0` **only** when `hasOpenClaw` is true and the tech strategy selected.
- No other strategy or intent can generate those hard-coded OpenClaw queries, eliminating leakage.

### Sanitization and recency (`src/main/llm/router.ts`) 
- All strategy-generated queries are sanitized via `sanitizeQuery`, which:
  * Removes banned modifiers (e.g., gaming engine).
  * Adds `as of <today>` only when `ctx.intent.timeSensitive` is true and the query is not a `site:` search or already carrying `as of`.
  * Preserves canonical references to `OpenClaw` when the original goal contains it.
- `sanitizeQuery` replaces the previous default recency hint so “as of February 5, 2026” no longer leaks into every query.

## Strategy integration (`src/main/llm/router.ts`) 
- `llmClassify` now computes `QueryContext` before sanitizing the LLM response.
- `validateTaskSpec` discards LLM-provided actions and instead:
  1. Resolves the user goal (`raw.userGoal` or fallback message or context goal).
  2. Runs `routeStrategy` on the extracted context.
  3. Calls `planStrategyActions` to get the action list.
  4. Sanitizes each query via `sanitizeQuery` with the same context.
  5. Falls back to a single Google search if a strategy somehow returns zero queries.
- This preserves the original route semantics (chat/browse/research) while making the query pipeline deterministic and centralized.

## Testing
- Added `src/main/llm/__tests__/router.test.ts` coverage for new router behavior:
  1. OpenClaw prompts still trigger the two canonical doc+GitHub searches when the tech route is selected.
  2. Non-tech prompts ("Best restaurants in Austin this weekend") stay in the local/general strategy and never see `site:docs`/`site:github` injections.
  3. Generic prompts route through the general strategy without tech-specific queries and still respect fallback `overview/how to` modifiers.
  4. Time-sensitive prompts ("Latest developments …") append `as of` while non-latest equivalents do not.
- Existing endpoint tests continue to exercise heuristics vs. LLM falls backs so that strategy changes have no effect on chat/browse routes.
