# Homepage CodeJams + Devtoberfest Auto-Pull Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the existing `CommunityEvents` mirror (CodeJams + Devtoberfest, populated by #765) into Row 3 of the developer-portal homepage, with a region chip strip whose default is derived from the browser timezone for anonymous visitors and persisted on `UserLearningPreferences.preferredEventRegion` for signed-in users.

**Architecture:** New 6-hour lightweight refresh cron `refresh-community-events-job` keeps `CommunityEvents` fresh without LLM cost (twice-weekly extraction job stays as-is). New `CommunityEvents.region` column derived at ingest via `srv/lib/events/region-from-location.js`. `HomepageService.events()` is rewritten to read `CommunityEvents` with region + virtual filters. New Vue island `homepage-events-band` renders 6 cards + a 5-chip strip; anonymous visitors get a TZ hint, signed-in visitors get their `preferredEventRegion` from the personalization envelope. Full rollback path via `HomepageConfig.eventsBandAutoPullEnabled` flag.

**Tech Stack:** CAP 10 (Node.js), Hugo templates, Vue 3 island (Vite-built into `hugo/static/js/`), HANA (prod) / SQLite (unit), Vitest, CDS QL only (no raw SQL).

**Spec:** [docs/superpowers/specs/2026-07-07-1030-homepage-codejams-autopull-design.md](../specs/2026-07-07-1030-homepage-codejams-autopull-design.md)

## Global Constraints

- **Filter regions fixed at `AMERICAS | EMEA | APJ`** (matches `advocates.cds:14`). No country granularity. `UNKNOWN` is the parser sentinel.
- **6 cards per band** (spec §4). Chip strip is single-select with 5 chips: `All · Americas · EMEA · APJ · Virtual only`.
- **Event types allowlist is `['codejam','devtoberfest']`** everywhere the endpoint or the new refresh job filter (spec §2, §5). TechEd/user-groups explicitly out.
- **CDS QL tagged-template form only** — raw `?` placeholders are an anti-pattern that throws and gets silently swallowed by the `on('events')` catch. Use `` `col = ${bound}` ``.
- **`_state.events` becomes `Map<string, {at,value}>`**, capped at 16 entries. Cache key: `${region}|${includeVirtual ? 1 : 0}`.
- **Endpoint never 400s** on bad `region` — coerce to `'ALL'` and emit `homepage.events.requests{region=invalid}`.
- **Region derivation lives server-side at ingest** (single source of truth). Client `tz-to-region.ts` produces a *hint* for anonymous visitors only.
- **New refresh job must NOT touch** `contentHash`, `lastExtractedHash`, or `CommunityEventConceptLinks` — those stay owned by the twice-weekly extraction job. This keeps LLM cost flat.
- **`fetchAllEvents(opts)` gains one option** — `typesAllowlist: string[]`. Backward-compatible.
- **`preferredEventRegion` values** = `{AMERICAS, EMEA, APJ, VIRTUAL, ALL}` ∪ `null`. `VIRTUAL`/`ALL` are UI modes; they NEVER appear on `CommunityEvents.region`.
- **`PROFILE_VOCAB` drift-locked** — `srv/lib/branch/profile-fields.js` gets `preferredEventRegion`.
- **Cron minute is `17 */6 * * *`** — off-:00/:30 to avoid stampede.
- **`cds build --production`** (not `cds compile`) after schema edits that must land in `db/last-dev/`.
- **`npx cds deploy --to sqlite::memory:`** before committing any change to `db/**/*.cds` — catches `@assert.range` runtime errors.
- **CI Node 22 vs local Node 24** — use `cds.entities(NS)` refs, not bare projection names in `SELECT.from()`.
- **Fresh worktree needs `npm run setup`** after `npm install`.
- **PR before merge**, never direct-to-main. This plan ships as **3 PRs** per spec §11.
- **Feature flag `HomepageConfig.eventsBandAutoPullEnabled`** — default `true` in DEV, `false` in PROD initially. Endpoint falls back to legacy `Events` shape when `false`.

---

## PR Boundaries

Per spec §11, this plan ships as three PRs. Each PR is independently mergeable and green.

- **PR 1 — Schema + backfill + refresh job (cron NOT registered).** Tasks 1–8. Zero user-visible change. Deploy to DEV; run backfill script.
- **PR 2 — Cron registration.** Task 9 only. Redeploy; confirm cron fires.
- **PR 3 — Endpoint rewrite + Vue island + `/me/` field + feature flag.** Tasks 10–20. User-visible flip. Ships behind flag; DEV soak ~1 week before PROD.

Task detail is broken into per-PR files to keep this document scannable:

- **[PR 1 tasks (1–8)](2026-07-07-1030-homepage-codejams-autopull/pr1-ingest.md)**
- **[PR 2 task (9)](2026-07-07-1030-homepage-codejams-autopull/pr2-cron.md)**
- **[PR 3 tasks (10–20)](2026-07-07-1030-homepage-codejams-autopull/pr3-endpoint-and-island.md)**

---

## File Structure

**Created (PR 1)**
- `srv/lib/events/region-from-location.js` — pure `(location: string) => Region` function
- `srv/jobs/refresh-community-events-job.js` — 6h upsert-only cron logic
- `scripts/backfill-community-events-region.cjs` — one-shot idempotent backfill
- `test/unit/region-from-location.test.js`
- `test/unit/refresh-community-events-job.test.js`

**Modified (PR 1)**
- `db/external-content.cds` — add `region` column to `CommunityEvents`
- `srv/lib/events/index.js` — add `typesAllowlist` opt to `fetchAllEvents`
- `srv/jobs/fetch-community-events-job.js` — call `regionFromLocation` on upsert

**Modified (PR 2)**
- `srv/jobs/scheduler.js` — `registerJob({ jobName: 'refresh-community-events', ... })`

**Created (PR 3)**
- `hugo-apps/apps/homepage-events-band/{package.json, vite.config.ts, src/main.ts, src/EventsBand.vue, src/tz-to-region.ts, src/region-storage.ts, test/*.spec.ts}`
- `hugo/layouts/partials/homepage/events-band.html`
- `hugo/assets/css/homepage/_events-band.css`
- `test/unit/homepage-events-endpoint.test.js`
- `test/unit/set-preferred-event-region.test.js`
- `test/unit/homepage-events-region-drift.test.js`
- `test/hybrid/homepage-events-hybrid.test.js`
- `test/smoke/smoke-homepage-events.test.js`

**Modified (PR 3)**
- `db/schema.cds` — add `preferredEventRegion` to `UserLearningPreferences`
- `db/homepage.cds` — add `eventsBandAutoPullEnabled` to `HomepageConfig`
- `srv/lib/branch/profile-fields.js` — add `preferredEventRegion` to `PROFILE_VOCAB`
- `srv/homepage-service.cds` — widen `events()` signature; extend `EventCard`; add `eventsRegion` to envelope
- `srv/homepage-service.js` — rewrite `on('events')` handler
- `srv/lib/homepage/personalized-envelope.js` — pipe `preferredEventRegion` into envelope
- `srv/developer-service.cds` — add `setPreferredEventRegion` action
- `srv/developer-service.js` — action handler
- `hugo-apps/src/me/LearningPreferences.vue` — add `<Select>` for `preferredEventRegion`
- `hugo/layouts/index.html` — swap Row 3 partial include
- `hugo/assets/css/homepage.css` — `@import "_events-band.css"`
- `hugo-apps/vite.config.ts` — register the new app
- `docs/developers/architecture/homepage.md` — Row 3 description update

---

## Spec Coverage Map

| Spec § | Requirement | Task(s) |
|--------|-------------|---------|
| §2 refresh cron | 6h `refresh-community-events-job` | 3, 4 |
| §2 region column | `CommunityEvents.region` | 1 |
| §2 endpoint rewrite | 6-card region-filtered `events()` | 12, 13 |
| §2 `preferredEventRegion` | New column + action | 10, 15 |
| §2 setter action | Bound action on DeveloperService | 15 |
| §2 Vue island | `homepage-events-band` | 16, 17, 18 |
| §2 `/me/` field | LearningPreferences Select | 19 |
| §2 backfill | One-shot script | 6 |
| §2 feature flag | `eventsBandAutoPullEnabled` | 11, 12 |
| §4.1 region enum | `AMERICAS/EMEA/APJ/UNKNOWN` | 1 |
| §4.2 preference enum | `AMERICAS/EMEA/APJ/VIRTUAL/ALL` | 10 |
| §4.3 region function | Pure `regionFromLocation` | 2 |
| §4.4 backfill | Idempotent script | 6 |
| §5 cron + `typesAllowlist` | Job + fetchAllEvents opt | 3, 4, 9 |
| §5 no LLM touch | Job doesn't write hash cols | 4 |
| §6.1 endpoint contract | Query params, ETag, cache | 12, 13 |
| §6.2 filter semantics | WHERE matrix | 12 |
| §6.3 cache Map | Per-key 60s cache | 12 |
| §6.4 envelope wiring | `eventsRegion` on envelope | 14 |
| §6.5 action | `setPreferredEventRegion` | 15 |
| §7.1–7.3 island | `homepage-events-band` | 16, 17, 18 |
| §7.4 `/me/` select | LearningPreferences.vue | 19 |
| §7.5 Hugo partial | `events-band.html` | 18 |
| §8 failure modes | Fallback + skeleton + empty | 12, 18 |
| §9 metrics | Six new metrics | 4, 12, 15, 17 |
| §10 testing | Unit/hybrid/smoke | 5, 8, 13, 15, 17, 20 |
| §11 rollout | 3-PR structure | PR file boundaries |
| §12 non-goals | None acted on | (no task) |
