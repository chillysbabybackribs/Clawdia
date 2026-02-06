# TEST_FIX_NOTES

- **Criteria TDZ** – `validateTaskSpec` now builds and normalizes `successCriteria`/`deliverableSchema` before calling `translateCriteriaToIntents`. That eliminates the previous Temporal Dead Zone when `criteria` was referenced earlier in `src/main/llm/router.ts`; all subsequent logic now sees initialized data.
- **Locked templates** – Introduced `src/main/executor/query_templates.ts` as the leaf module holding `LOCKED_QUERY_TEMPLATES` and `GENERIC_QUERY_TEMPLATES`, then wired `expansion-policy.ts` to read from it. This restores the missing constant for the expansion policy tests without adding extra higher-level imports.
- **Router stability** – Reapplied the prior OpenClaw/local heuristics inside `validateTaskSpec` so the sanctioned search actions (targeted `site:docs.openclaw.ai`/`site:github.com/openclaw` queries and a `near` fallback for local intents) survive the refactor. No IPC/UI changes were introduced.
- **Build outputs** – Regenerated `dist/main` artifacts so the emitted JS stays in sync with the updated TS sources and new query-template module.
