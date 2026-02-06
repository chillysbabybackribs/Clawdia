# Search Query Audit

## 1. End-to-end trace (IPC.CHAT_SEND → executeSearch)
1. `src/main/main.ts:110-185` handles `IPC.CHAT_SEND`, runs `Router.classify`, and delegates to `handleResearchRoute` when the intake result is `research`.
2. `src/main/llm/router.ts` now computes a deterministic `QueryContext` (`extractQueryContext`) for every message, routes with `routeStrategy`, and replaces the TaskSpec's actions with `planStrategyActions` + `sanitizeQuery` before the request ever reaches the executor.
3. `TaskSpec` reaches `ExecutorRunner.execute` via `handleResearchRoute`. The runner obeys the budget and forwards each `PlanAction` to `ActionExecutor`.
4. `src/main/executor/actions.ts:18-200` runs `executeSearch` for each search action, navigates the SERP, harvests at most `MAX_SOURCES_PER_SEARCH = 3` links, and records duplicates via `visitedUrls`, so every issued query can be traced back to a single search action.

## 2. Query sources, gating, and rewrite rules

### Strategy layer (`src/main/search/strategies.ts:1-112`)
| Strategy | Queries emitted | Trigger | Production vs. test | Leakage notes |
| --- | --- | --- | --- | --- |
| General | `<userGoal>`, `<userGoal> overview` or `<userGoal> how to` (for purchase/troubleshooting) | Any research prompt that does not meet `local` or `tech` intents | Production | No extra `site:` qualifiers or targeted injections; the router sanctions every research intent to this when no tech/local signal is present.
| Local | `<userGoal> near <placeHint|me>`, `<userGoal> hours reviews` or `this weekend` (when timeSensitive) | `ctx.intent.local` true (regex for “near me”, cities, hours) | Production | Always google searches, never GitHub/docs, so unrelated prompts cannot receive site-limited injections.
| Tech | `site:docs.* <entity> (install OR docs OR getting started)`, `site:github.com <entity> README`, optionally `<userGoal> (security OR sandbox OR permissions)` when the raw text mentions safety | `ctx.intent.tech` or `ctx.intent.troubleshooting` true; entity candidates (regex/capitalized phrases/URLs) exist | Production | The targeted `OpenClaw` injections are gated here: they run only when `hasOpenClaw` (regex on raw text or extracted entities) and the tech route is chosen, preventing “OpenClaw” searches from leaking into generic prompts.

The tech strategy also unshifts the two canonical OpenClaw queries (`site:docs.openclaw.ai ...`, `site:github.com/openclaw ...`) only when the entity match is present, so unrelated prompts that mention other brands do not receive those fixed-site injections.

### Sanitization (`src/main/llm/router.ts:164-220`)
- `sanitizeQuery` still removes banned modifiers (e.g., “game engine”), prepends “OpenClaw” when the fallback goal mentions it, and only adds a recency tag (`as of <today>`) when the deterministic `QueryContext` already flags the intent as time-sensitive (`latest/current` keywords).
- The new rule avoids appending `as of` to non-time-sensitive prompts and to `site:` queries (pattern `/site:/i`), so temporal leakage is limited to explicit `latest`/`current`/date requests.

### Expansion policy (`src/main/executor/expansion-policy.ts:15-75`)
- `LOCKED_QUERY_TEMPLATES` contain several `OpenClaw`-specific searches (security, architecture, installation) and repeated `site:github.com/openclaw` / `site:docs.openclaw.ai` queries. They are only scheduled during recovery expansion (`planTargetedStage`) when the evidence gate reports missing criteria.
- Generic prompts **do not** trigger these unless the synthesizer or evidence gate mislabels the criteria (i.e., only when the user goal/success criteria already mention OpenClaw or one of the locked categories).

### Deduplication & slicing
- Router caps TaskSpec actions at 5 (same as before). Strategy packs produce at most two to three actions, so the limit is only reached when targeted OpenClaw queries are prepended.
- `ActionExecutor.executeSearch` limits each search to the first three harvested links (`MAX_SOURCES_PER_SEARCH = 3`). Duplicate hosts are filtered via `visitedUrls`, so a single hard-coded query does not spawn multiple fetch cycles.

## 3. Direct findings from the search terms requested
| Term | Location(s) | Trigger | Prod/test-only | Leakage risk |
| --- | --- | --- | --- | --- |
| `TARGETED_DOC_QUERIES` | Used to live in `src/main/llm/router.ts` in `withTargetedSearches`; replaced with the OpenClaw logic inside `src/main/search/strategies.ts:28-44` | Tech strategy + `hasOpenClaw` entity match | Production | Without the entity gate, any research prompt mentioning “OpenClaw” would fire two site-specific queries; the new code keeps them behind the tech gate so general prompts cannot see OpenClaw docs unless they truly ask about the product.
| `withTargetedSearches` | Removed from `router.ts`, referenced only in `dist`/legacy code now | Previously ran whenever `goal` included `OpenClaw`, before strategy router existed | Test / legacy | This was the main leakage vector; any prompt with “OpenClaw” (even unrelated contexts) triggered the doc+GitHub injections. The new architecture deletes this path.
| `OpenClaw` queries | `src/main/search/strategies.ts:26-44`, `src/main/executor/expansion-policy.ts:15-40`, executor tests (`__tests__/expansion-policy.test.ts`) | Intent detection vs. missing evidence criteria | Production (with golden test coverage) | Risk now limited to prompts explicitly mentioning OpenClaw or criteria that fail the evidence gate for OpenClaw, so unrelated prompts stay untouched.
| `as of` | `src/main/llm/router.ts:179-206` (sanitizer) | `ctx.intent.timeSensitive` true (keywords like `latest`, `current`, explicit `2026`) | Production | Controlled by intent; non-time prompts no longer receive “as of February 5, 2026”, eliminating previous recency leakage.
| `site:` queries | `src/main/search/strategies.ts:13-26` and `src/main/executor/expansion-policy.ts:44-60` | Tech route or gate-triggered expansions | Production | All `site:` qualifiers are restricted to docs/GitHub of the extracted entity; general/local routes do not produce `site:` queries, so taxonomy creep is contained.

## 4. Summary
- The search query pipeline now originates from a deterministic `QueryContext` + strategy router instead of ad-hoc LLM actions, which keeps all query injection in one place and makes the intent visible for auditing.
- Time-sensitive rewrites (`as of`) and OpenClaw injections are gated by intent detection and entity matching, eliminating unintentional leaks into unrelated prompts.
- Evidence gate recovery still relies on locked templates, but those, too, activate only when criteria explicitly point back to OpenClaw, so leakage is limited to relevant research tasks.
