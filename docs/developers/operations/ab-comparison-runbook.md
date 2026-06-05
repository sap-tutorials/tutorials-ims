# A/B Comparison Runbook: `/` vs `/browse/`

> One-page guide for analysts deciding whether to keep, retire, or extend the `/browse/` surface.
> Reads results emitted by [#204](https://github.com/sap-tutorials/tutorials-ims/issues/204) instrumentation.

---

## What this measures

Issue [#174](https://github.com/sap-tutorials/tutorials-ims/issues/174) shipped `/browse/` as a coexisting alternative homepage with the explicit purpose of A/B testing it against `/`. Issue [#204](https://github.com/sap-tutorials/tutorials-ims/issues/204) added the measurement infrastructure: anonymous, session-scoped client telemetry that records `page_view`, `filter_change`, `card_click`, `pagination_change`, `rail_show_all_click`, `scroll_depth`, and `page_leave` events from both surfaces into the `UIEvent` HANA table.

PRs 1-4 of #204 wired the data path: schema + write endpoint, frontend trackers on `/` and `/browse/`, `referred_view` close-the-funnel from tutorial pages, and the canonical `SavedQueries` plus this runbook (the read surface). The goal is a defensible answer to "is `/browse/` the better default?" within ~14 days of activating the flag.

The deciding metric is **card click-through rate (CTR)**. Secondary metrics (filter usage, bounce rate, time-to-first-click, search usage) inform *why* one surface wins but do not by themselves trigger cutover.

---

## How to run a comparison (5 minutes)

1. Confirm `UI_EVENTS_ENABLED=true` is set on `tutorials-srv` (and on `tutorials-srv-qa` if you also want QA traffic). Without it, the write endpoint silently drops batches and `UIEvents` stays empty.
2. Open the analytics explorer at `/analytics-ui/` (XSUAA-protected; route requires the `Admin` scope from `xs-app.json` — see [Testing endpoints](./testing-endpoints.md)).
3. Switch to the **Saved Queries** tab. Filter by name prefix `A/B —`. The 6 canonical queries are seeded by `srv/lib/ui-event-saved-queries.js` on every `cds.served` and are visible to every admin (`visibility: 'shared-admins'`).
4. Run each query. They are read-only and validator-safe; results stream back via the standard `runSelectQuery` envelope (capped at 5,001 rows).
5. Read the rows side by side: each query returns one row per surface (`/` and `/browse/`). Apply the **threshold rule** below to decide whether you have enough data to call a winner.
6. For confidence intervals on CTR, copy the relevant counts from Query 3 into the worked example near the bottom of this runbook (the validator does not allow `MEDIAN` / `PERCENTILE_DISC` / `FILTER (WHERE)`, so CIs are computed by hand from the row counts, not in SQL).

---

## The 6 canonical queries

All six are seeded into `AnalyticsSavedQuery` with `visibility: 'shared-admins'`. The exact text below is what runs against HANA — paste it verbatim if you ever need to re-create them.

### A/B — Daily sessions per surface

**What it measures:** distinct anonymous tab-sessions that loaded each surface, per calendar day. The denominator for everything else and a basic sanity check on the cohort split.

**SQL:**

```sql
SELECT surface, CAST("TIMESTAMP" AS DATE) AS day, COUNT(DISTINCT sessionId) AS sessions
FROM UIEvents
WHERE eventType = 'page_view'
GROUP BY surface, CAST("TIMESTAMP" AS DATE)
ORDER BY day DESC, surface
```

**How to read it:** if `/browse/` shows zero rows, the flag isn't on or no users have hit it yet — re-check `UI_EVENTS_ENABLED`, the approuter route, and the cohort assignment logic before drawing any other conclusion. Equal order-of-magnitude rows (within ~2x) means the surfaces are getting comparable traffic. If they diverge by >10x, something is wrong with the cohort split (e.g., an internal redirect or a stale Hugo build that doesn't emit one of the surfaces).

### A/B — Filter usage rate per surface

**What it measures:** total sessions per surface and sessions that fired ≥1 `filter_change` event. The ratio `filter_sessions / total_sessions` is the filter usage rate; compute it in your head from the two columns.

**SQL:**

```sql
SELECT surface,
       COUNT(DISTINCT sessionId) AS total_sessions,
       COUNT(DISTINCT CASE WHEN eventType = 'filter_change' THEN sessionId END) AS filter_sessions
FROM UIEvents
GROUP BY surface
ORDER BY surface
```

**How to read it:** filter usage rate is a proxy for "did users find the surface usable enough to interact with the curation controls?" `/browse/` is filter-first by design, so a higher rate there is expected; what matters is whether the *gap* is large (e.g., 3x) or marginal. A near-zero rate on `/browse/` despite traffic in Query 1 means the filter UI is broken, not that users dislike filtering.

### A/B — Card click-through rate per surface

**What it measures:** view sessions vs click sessions per surface. CTR = `click_sessions / view_sessions`. **This is the deciding metric.**

**SQL:**

```sql
SELECT surface,
       COUNT(DISTINCT CASE WHEN eventType = 'page_view'  THEN sessionId END) AS view_sessions,
       COUNT(DISTINCT CASE WHEN eventType = 'card_click' THEN sessionId END) AS click_sessions
FROM UIEvents
GROUP BY surface
ORDER BY surface
```

**How to read it:** the surface with higher CTR is "winning" — but only if the difference is statistically significant. Apply the threshold rule below before claiming a winner. The 95% CI calculation (worked example further down) tells you whether the gap is real or sampling noise.

### A/B — Time-to-first-click per surface

**What it measures:** min, max, and average milliseconds between a session's first `page_view` and its first `card_click`. Sub-query computes per-session timestamps; outer query aggregates across sessions.

**SQL:**

```sql
SELECT surface,
       MIN(click_ts - view_ts) AS min_ms,
       MAX(click_ts - view_ts) AS max_ms,
       AVG(click_ts - view_ts) AS avg_ms,
       COUNT(*) AS sessions_observed
FROM (
  SELECT sessionId, surface,
         MIN(CASE WHEN eventType = 'page_view'  THEN "TIMESTAMP" END) AS view_ts,
         MIN(CASE WHEN eventType = 'card_click' THEN "TIMESTAMP" END) AS click_ts
  FROM UIEvents
  GROUP BY sessionId, surface
) per_session
WHERE view_ts IS NOT NULL AND click_ts IS NOT NULL AND click_ts >= view_ts
GROUP BY surface
ORDER BY surface
```

**How to read it:** lower average is generally better (faster path to the desired tutorial). Compare `avg_ms` and `max_ms` to gauge skew — a long tail (`max_ms` ≫ `avg_ms`) suggests some users are wandering the surface before clicking, which can be a discoverability win or a confusion loss depending on context. Median and percentiles are not in the validator allowlist; for that, export the per-session view to CSV via `/admin/analytics/exports` and percentile in a notebook.

### A/B — Bounce rate per surface

**What it measures:** sessions with a `page_view` but zero `card_click` events. Bounce rate = `bounced_sessions / view_sessions`.

**SQL:**

```sql
SELECT surface,
       COUNT(*) AS view_sessions,
       SUM(CASE WHEN clicks = 0 THEN 1 ELSE 0 END) AS bounced_sessions
FROM (
  SELECT sessionId, surface,
         SUM(CASE WHEN eventType = 'card_click' THEN 1 ELSE 0 END) AS clicks,
         SUM(CASE WHEN eventType = 'page_view'  THEN 1 ELSE 0 END) AS views
  FROM UIEvents
  GROUP BY sessionId, surface
) per_session
WHERE views > 0
GROUP BY surface
ORDER BY surface
```

**How to read it:** bounce rate is the inverse signal of CTR — they should sum to ~100% per surface. If bounce rate diverges sharply between surfaces but CTR does not, you have a measurement bug. High bounce on `/browse/` despite similar CTR can mean: filter-driven sessions read deeper without converting, the curation rails aren't hooking visitors, or page-leave instrumentation is misclassifying genuine clicks.

### A/B — Search usage rate per surface

**What it measures:** fraction of sessions per surface that fired a `filter_change` with `kind=search`. The `payload` column is JSON-as-string; we LIKE-match the literal `{"kind":"search"}` fragment so the query works on both HANA and SQLite without `JSON_VALUE`.

**SQL:**

```sql
SELECT surface,
       COUNT(DISTINCT sessionId) AS total_sessions,
       COUNT(DISTINCT CASE WHEN eventType = 'filter_change' AND payload LIKE '%"kind":"search"%' THEN sessionId END) AS search_sessions
FROM UIEvents
GROUP BY surface
ORDER BY surface
```

**How to read it:** search-vs-browse is the central UX question — if `/browse/` users still search at near-`/` rates, the curation isn't carrying the load. If `/browse/` search rate is dramatically lower, browsing is succeeding; cross-check with CTR before celebrating (low search + low CTR = users gave up).

---

## The cutover decision rule

The spec ([§ Locked design decisions, row 8](../../superpowers/specs/2026-06-04-ab-instrumentation-design.md)) locks two thresholds:

| Rule | When it applies | What you need | Decision |
|---|---|---|---|
| **Default** | After ~14 days of bilateral traffic | 15,000 `page_view` sessions per surface (≈ 30,000 total) | Compute CTR (Query 3), build 95% CI for each surface (worked example below), call the higher CTR if the CIs do not overlap zero difference |
| **Early-stop** | When the gap is obviously large early on | 2,400 sessions per arm, CTR gap ≥ 5 percentage points, two-proportion z-test significant at p<0.05 | Call the higher CTR; document why you stopped early |
| **Stop-on-clear-direction** | One arm is dominating (e.g. 30% vs 5% CTR) with thousands of samples each | Both arms have CIs well separated and the practical gap is large enough that further data won't change the call | Call it. Write the reasoning in the cutover ticket so it survives reviewer scrutiny |

CTR is the only deciding metric. Secondary metrics (filter, bounce, time-to-click, search) frame the *why* — useful for the post-mortem write-up and for designing the next experiment, but they do not on their own justify a cutover.

---

## Computing 95% CI by hand (for the runbook output)

The validator does not allow `MEDIAN` or `PERCENTILE_DISC`, and there is no `FILTER (WHERE)` clause. CIs are therefore computed off-line from Query 3's row counts using the closed-form normal (Wald) approximation. For each surface you have:

- `view_sessions` (`n`)
- `click_sessions` (`k`)
- `CTR = k / n`

The 95% CI on CTR is:

```
CTR ± 1.96 * sqrt( CTR * (1 - CTR) / n )
```

The `1.96` is the two-tailed z-value for α=0.05.

### Worked example (fake numbers)

Suppose Query 3 returns:

| surface | view_sessions | click_sessions |
|---|---|---|
| `/` | 12,000 | 1,800 |
| `/browse/` | 11,800 | 2,360 |

For `/`:

```
CTR = 1800 / 12000 = 0.1500          (15.00%)
SE  = sqrt(0.15 * 0.85 / 12000)
    = sqrt(0.0000106)
    = 0.00326
CI  = 15.00% ± 1.96 * 0.326%
    = [14.36%, 15.64%]
```

For `/browse/`:

```
CTR = 2360 / 11800 = 0.2000          (20.00%)
SE  = sqrt(0.20 * 0.80 / 11800)
    = sqrt(0.0000136)
    = 0.00368
CI  = 20.00% ± 1.96 * 0.368%
    = [19.28%, 20.72%]
```

The CIs `[14.36%, 15.64%]` and `[19.28%, 20.72%]` do not overlap → `/browse/` is significantly better at p<0.05.

### Two-proportion z-test on the difference

When CIs almost overlap, the closed-form two-proportion z-test gives a sharper answer:

```
p_pooled = (k1 + k2) / (n1 + n2)
z        = (p1 - p2) / sqrt( p_pooled * (1 - p_pooled) * (1/n1 + 1/n2) )
```

If `|z| > 1.96`, the difference is significant at p<0.05. If `|z| > 2.58`, p<0.01.

Plugging in the example above:

```
p_pooled = (1800 + 2360) / (12000 + 11800) = 4160 / 23800 = 0.1748
z        = (0.20 - 0.15) / sqrt( 0.1748 * 0.8252 * (1/11800 + 1/12000) )
         = 0.05 / sqrt( 0.1443 * 0.0001682 )
         = 0.05 / sqrt( 0.00002428 )
         = 0.05 / 0.00493
         ≈ 10.14
```

`|z| = 10.14 ≫ 1.96`, so the difference is overwhelmingly significant.

---

## Failure modes and how to interpret them

### "The surfaces look identical"

CTR within 1pp, CIs overlap heavily even at full sample. Probably no real difference on the measured outcome. Decision: the surfaces are **equivalent** — pick one based on secondary considerations (engineering cost, future flexibility, accessibility, SSR coverage). Don't keep collecting data forever waiting for a signal that isn't coming.

### "One surface is winning by 50%+"

Real signal, but verify the data isn't contaminated before celebrating. Spot-check: are both surfaces emitting `page_view` events on every load? Is there a server-side redirect that disproportionately routes one cohort to one surface? Is the `surface` field populated correctly for both? If the cohort split is clean, ship the winner.

### "Click counts are tiny" (e.g., < 200 per surface)

Wide CIs, high variance — any apparent difference is sampling noise. Wait for more data or extend the experiment window. The threshold rule exists precisely to keep the team from calling small-N results.

### "/browse/ shows much higher bounce rate"

Read Query 5 carefully. High bounce on `/browse/` plus similar CTR is contradictory and suggests a measurement bug (bounce rate and CTR should sum to ~100% per surface). High bounce on `/browse/` plus *lower* CTR is a clear loss signal — users land, can't find what they want, leave. Cross-reference Query 2 (filter usage) and Query 6 (search usage): if both are high but CTR is still low, the curation isn't surfacing the right items.

### "Page leave durations vary wildly"

Out of scope for the click-through decision — `page_leave` `durationMs` is collected for context, not for the cutover gate. If `/browse/` has 2x dwell on similar CTR, it's an engagement win even if CTR ties; capture that in the post-mortem.

---

## What to do post-decision

- **If `/browse/` wins:** close issue #174's followups in priority order — #200 (SSR on `/`) and #201 (Categories facet on `/browse/`) become the immediate next priorities. Plan the cutover from `/` to `/browse/` as the default route in the approuter.
- **If `/` wins:** close issue #174 entirely. File a follow-up to decommission `/browse/` (remove the route in `approuter/xs-app.json`, retire the alternative-card layout in `hugo/layouts/browse/`, drop the `/browse/` build entry in `hugo-apps/vite.config.ts`).
- **If they tie:** keep both surfaces. File issue #199 (sort dropdown on `/`) for consistency between the two, and plan a future experiment on a different axis (search relevance, recommendations, navigation density).

In all three cases, archive the SavedQueries — flip them to `visibility: 'private'` if you want to keep them for reference, or delete them via the admin UI's Saved Queries panel if you don't.

After deciding, stop collecting telemetry until the next experiment:

```bash
cf set-env tutorials-srv UI_EVENTS_ENABLED false
cf restart tutorials-srv
```

(Apply the same to `tutorials-srv-qa` if QA was instrumented in parallel.)

---

## See also

- Spec: [docs/superpowers/specs/2026-06-04-ab-instrumentation-design.md](../../superpowers/specs/2026-06-04-ab-instrumentation-design.md)
- Issue: [#204](https://github.com/sap-tutorials/tutorials-ims/issues/204)
- Parent issue: [#174](https://github.com/sap-tutorials/tutorials-ims/issues/174) (the alternative homepage)
- Endpoint reference: [docs/developers/operations/testing-endpoints.md](./testing-endpoints.md)
