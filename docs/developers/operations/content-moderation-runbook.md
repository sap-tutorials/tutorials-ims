# Content Moderation Runbook (#1034)

## Kill switch — homepage falls back to legacy RSS pass-through

Fastest (no redeploy): flip `HomepageConfig.newsRelevanceEnabled = false` at
`/admin-ui/#homepage-config`. Effect within 60 s (cache TTL).

Nuclear (env-level): `cf set-env tutorials-srv HOMEPAGE_NEWS_RELEVANCE_ENABLED false && cf restart tutorials-srv`.
Env dominates HomepageConfig; either falsy → legacy behavior.

## Re-run the classifier manually

Run: `curl -X POST /admin-service/JobControls('fetch-news')/runJob` or click
"Run classifier now" on `/admin-ui/#content-moderation`. Same code path as
the hourly cron; produces a PipelineRuns row for audit.

## Tune the seed exemplars

Edit at `/admin-ui/#content-moderation` (Seeds tab). CREATE/UPDATE fires an
after-hook that recomputes the embedding server-side; the classifier cache
invalidates the affected entry only. Do NOT edit
`db/data/com.sap.developers.ims.external-RelevanceSeedExemplars.csv` after
launch — it's a first-deploy seed. Post-launch CSV edits WILL wipe admin
changes on the next redeploy (memory-recorded gotcha).

## Override one item

Row action bar on `/admin-ui/#content-moderation` → Approve / Reject / Clear
override. Admin verdicts win over AI at read time. Homepage picks up the
override within 60 s.

## Diagnose: classifier is falling back to keyword rules

Check `NewsItems.aiVerdictSource`. If most rows show `fallback-keyword`,
one of:
- Seed table is empty for either label → banner will show; add seeds.
- Daily LLM budget (`ChatSettings.newsRelevanceLlmBudgetPerDay`, default 100)
  is exhausted — check `newsRelevanceLlmCallsToday` on ChatSettings.
- AI Core outage — check `NewsItems.classifyError` and `cf logs tutorials-srv`.

## Diagnose: no items on homepage

- Kill switches on? Legacy pass-through requires no NewsItems row.
- Seed table populated with BOTH labels? Empty → all rows land as `pending`.
- `NewsItems` rows all `not-relevant`? Loosen seeds or drop
  `ChatSettings.newsRelevanceMargin` from 0.150 → 0.10.
- Everything older than 14 days? Wait for the next cron cycle.

## Roll forward at first deploy

1. Ship schema + service + classifier + cron with
   `HomepageConfig.newsRelevanceEnabled = false`.
2. Let the hourly cron run for 48 h; triage the moderation UI.
3. Flip `newsRelevanceEnabled = true`. Homepage begins filtered service.
4. Monitor `news_relevance_*` metrics; tune margin if verdicts skew.

## Related

- Spec: `docs/superpowers/specs/2026-07-07-1034-sap-news-developer-relevance-design.md`
- Plan: `docs/superpowers/plans/2026-07-07-1034-sap-news-developer-relevance.md`
