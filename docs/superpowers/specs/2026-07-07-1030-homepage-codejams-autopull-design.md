---
issue: 1030
title: Homepage upcoming events — auto-pull CodeJams + Devtoberfest with region personalization
status: draft
author: Thomas Jung
---

# Homepage upcoming events auto-pull (#1030)

Replace the hand-curated Row 3 "Upcoming events" band on the developer-portal homepage with an auto-pulled feed from `CommunityEvents` (CodeJams + Devtoberfest), gated by a client-side region chip strip whose default is derived from the browser timezone and — for signed-in users — persisted on `UserLearningPreferences.preferredEventRegion`.

**Base homepage:** [homepage.md](../../developers/architecture/homepage.md)
**Personalization stack:** [homepage-personalization.md](../../developers/architecture/homepage-personalization.md)
**Related ingest:** `srv/jobs/fetch-community-events-job.js` (Phase 4.8 / #765)
**Related entity:** `db/external-content.cds` — `CommunityEvents`

---

## 1. Context

Row 3 of the homepage (`GET /api/homepage/events`) has served the manually-curated `Events` entity since #639. Motivation for changing:

- Manually curating dated events is error-prone; entries go stale silently.
- Most visitors only care about events they can attend in person. A global list buries locally-relevant CodeJams.
- `sap-devs-server` MCP already exposes `search_events`; and the codebase already ingests the same feed into `CommunityEvents` twice-weekly for KG concept-linking (Phase 4.8 / #765). The homepage just isn't wired to it.
- `advocates.cds:14` already defines a proven three-region vocabulary (`AMERICAS | EMEA | APJ`) — no new geo model needs inventing.

Ship one focused change: **wire `CommunityEvents` → the events band, with a region filter that defaults intelligently for signed-in and anonymous visitors.**

## 2. Scope

**In:**
- New 6-hour cron `refresh-community-events-job` that re-pulls CodeJam + Devtoberfest metadata without LLM cost.
- New column `CommunityEvents.region` derived at ingest from `location` via `srv/lib/events/region-from-location.js`.
- Rewrite of `HomepageService.events()` to read `CommunityEvents` with `region` and `includeVirtual` filters; 60 s per-key cache; ETag; 6-card cap.
- New column `UserLearningPreferences.preferredEventRegion`.
- New bound action `setPreferredEventRegion` on `DeveloperService`.
- New Vue island `hugo-apps/src/homepage-events-band/` with chip strip, TZ hint, localStorage fallback, and BroadcastChannel live update.
- New `<Select>` on `/me/` LearningPreferences page.
- One-shot backfill script `scripts/backfill-community-events-region.cjs`.
- Feature flag `HomepageConfig.eventsBandAutoPullEnabled` (default true; rollback path).

**Out (explicit non-goals):**
- Admin surface for editing the location→region rules — rules ship as code; drift is watched via the `region_unknown` metric and grown in follow-up PRs.
- TechEd / user-group event types — no live source in `EVENT_TYPES` today.
- Country-level granularity — three regions only, matching `advocates.cds`.
- `.ics` calendar-download link on cards.
- Deletion of the legacy `Events` entity and its admin UI — kept as fallback and for future one-off marketing entries.

## 3. Architecture

```text
┌──────────────────────────────────────────────────────────────────────┐
│ Ingest (background)                                                  │
│                                                                      │
│  refresh-community-events-job  (NEW, cron `17 */6 * * *`)            │
│    → fetchAllEvents({ typesAllowlist: ['codejam','devtoberfest'] })  │
│    → per row: derive region from location string                     │
│    → upsert CommunityEvents (title, url, startDate, endDate,         │
│                              location, scope, virtualOrInPerson,     │
│                              region ←NEW)                            │
│    → NO embedding, NO LLM extract                                    │
│                                                                      │
│  fetch-community-events-job (EXISTING, twice weekly) unchanged;      │
│  still owns embedding + concept-link extraction. Both jobs are       │
│  idempotent on the same rows.                                        │
└──────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────┐
│ Serve (request path)                                                 │
│                                                                      │
│  GET /api/homepage/events(region='EMEA', includeVirtual=true)        │
│    HomepageService.on('events')                                      │
│      → SELECT from CommunityEvents                                   │
│          .where(eventType in ('codejam','devtoberfest'))             │
│          .where(startDate >= now)                                    │
│          .where(<region + virtual filter>)                           │
│          .orderBy(startDate asc)                                     │
│          .limit(6)                                                   │
│      → 60 s per-(region, virtual) memoized cache                     │
│                                                                      │
│  POST /api/developer/setPreferredEventRegion  (NEW)                  │
│    @requires 'authenticated-user'                                    │
│    Upserts UserLearningPreferences.preferredEventRegion              │
│    Fires BroadcastChannel 'preferences-changed'                      │
└──────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────┐
│ Client (homepage row 3)                                              │
│                                                                      │
│  hugo-apps/src/homepage-events-band/  (NEW Vue island)               │
│    1. Determine initial region:                                      │
│       · signed-in: window.__homepagePersonalized.eventsRegion        │
│       · signed-out or unset: localStorage or Intl TZ → region        │
│    2. Fetch /api/homepage/events with region + includeVirtual        │
│    3. Render 6 cards + chip strip:                                   │
│         All · Americas · EMEA · APJ · Virtual only                   │
│    4. Chip click → refetch + persist:                                │
│         · always: localStorage                                       │
│         · signed-in: POST setPreferredEventRegion (fire-and-forget)  │
│    5. BroadcastChannel 'preferences-changed' → refetch               │
└──────────────────────────────────────────────────────────────────────┘
```

## 4. Data model

### 4.1 `CommunityEvents.region` (new column, `db/external-content.cds`)

```cds
entity CommunityEvents : cuid, managed {
  // ...existing fields...
  scope             : String(20);                  // 'local' | 'regional' | 'virtual' | 'global'
  region            : String(16) @assert.range enum {
                        AMERICAS; EMEA; APJ; UNKNOWN;
                      };                            // NEW — derived at ingest
  virtualOrInPerson : String(20);                  // 'virtual' | 'in-person'
  // ...
}
```

- `String(16)` matches `advocates.region` exactly.
- Nullable; older rows are backfilled by the one-shot script (§4.4).
- Additive column — no `.hdbmigrationtable` required.
- `UNKNOWN` is the parser-can't-classify sentinel; those rows surface under "All" only.

### 4.2 `UserLearningPreferences.preferredEventRegion` (new column, `db/schema.cds`)

```cds
entity UserLearningPreferences : managed {
  key user             : Association to Users;
  deployment           : String(20) @assert.range enum { cloud; onprem; };
  role                 : String(20) @assert.range enum { developer; architect; sysadmin; student; };
  cloud                : String(20) @assert.range enum { btp; aws; azure; gcp; alibaba; oracle; ibm; };
  preferredEventRegion : String(16) @assert.range enum {
                            AMERICAS; EMEA; APJ; VIRTUAL; ALL;
                         };                        // NEW — null = never set
}
```

- `VIRTUAL` and `ALL` are UI filter modes, not physical regions. They only ever appear on this column (never on `CommunityEvents.region`).
- Drift-locked to `srv/lib/branch/profile-fields.js` via the existing `profile-fields-sync.test.ts` guard, extended by this issue.

### 4.3 `srv/lib/events/region-from-location.js` (new, ~80 lines)

Pure function: `(location: string) => 'AMERICAS' | 'EMEA' | 'APJ' | 'UNKNOWN'`.

Case-insensitive substring rules ordered by specificity (city → country → region term). Ships with country/city coverage for the ~50 most-common CodeJam locations plus SAP-hub cities. First-match wins; `virtual` sentinel returns `UNKNOWN` (region is orthogonal to virtuality).

### 4.4 Backfill

`scripts/backfill-community-events-region.cjs` — idempotent one-shot:

```
UPDATE com_sap_developers_ims_external_CommunityEvents
SET region = <fn(location)>
WHERE region IS NULL OR region = ''
```

Runs once per environment before the endpoint rewrite ships. Committed alongside the migration.

## 5. Ingest — `refresh-community-events-job.js`

Pattern-cloned from `fetch-community-events-job.js` with the extraction pipeline removed. Key properties:

- Cron: `17 */6 * * *` (avoids :00/:30 stampede minutes).
- Reads only `codejam` + `devtoberfest` via new `typesAllowlist` option on `fetchAllEvents`.
- Upserts by `slug` (canonicalized via existing `canonicalizeEventSlug`).
- Writes every column EXCEPT `contentHash` and `lastExtractedHash` — those stay owned by the twice-weekly extraction job.
- No embedding, no LLM extract, no `CommunityEventConceptLinks` mutation.
- Failure semantics: single-fetcher failure → partial success; all-fetcher failure → warn log + 0 rows + returns non-fatally. Homepage keeps serving DB contents in either case.

`fetchAllEvents` in `srv/lib/events/index.js` grows one option: `typesAllowlist: string[]`. When set, only `EVENT_TYPES` entries whose `id` is in the list are fetched. Backward-compatible — the existing job doesn't pass it.

## 6. Serve — `HomepageService.events()` rewrite

### 6.1 Endpoint contract

```
GET /api/homepage/events(region='EMEA', includeVirtual=true)
  region:         'ALL' | 'AMERICAS' | 'EMEA' | 'APJ' | 'VIRTUAL'  default 'ALL'
  includeVirtual: Boolean                                            default true

  → EventCard[]   (up to 6 items from CommunityEvents)

Cache-Control: public, max-age=60
ETag: "<sha1(payload)>"
```

Response shape (adds `eventType`, `region`, `isVirtual`; existing consumers of `title / startsAt / location` remain compatible):

```json
[
  {
    "title": "SAP CodeJam on CAP and AI, Berlin",
    "startsAt": "2026-08-15",
    "endsAt": "2026-08-15",
    "location": "Berlin, Germany",
    "url": "https://community.sap.com/…",
    "eventType": "codejam",
    "region": "EMEA",
    "isVirtual": false
  }
]
```

### 6.2 Filter semantics

| `region` param | `includeVirtual` | SQL WHERE |
|----------------|------------------|-----------|
| `ALL`          | `true`  | (none — all future rows) |
| `ALL`          | `false` | `virtualOrInPerson <> 'virtual'` |
| `VIRTUAL`      | (any)   | `virtualOrInPerson = 'virtual'` |
| `AMERICAS/EMEA/APJ` | `true`  | `region = ? OR virtualOrInPerson = 'virtual'` |
| `AMERICAS/EMEA/APJ` | `false` | `region = ?` |

Always applied: `eventType in ('codejam','devtoberfest')`, `startDate >= today`, `ORDER BY startDate ASC`, `LIMIT 6`.

Invalid `region` values coerce to `'ALL'` (endpoint never 400s — the homepage must never break on a query-param typo). Coercion emits `homepage.events.requests{region=invalid}` so we can watch for a broken client.

### 6.3 Cache

`_state.events` is a `Map<string, {at, value}>` keyed by `${region}|${includeVirtual ? 1 : 0}`. Max 8 real combinations; capped at 16 entries with naive LRU-on-set. Per-process; no cross-instance coherence needed (60 s TTL absorbs the drift).

### 6.4 Personalization envelope

`GET /homepage/personalized` (existing endpoint) grows one field:

```json
{ ..., "eventsRegion": "EMEA" }
```

Populated from `UserLearningPreferences.preferredEventRegion` for the signed-in user; `null` when unset. Included in the envelope hash, so a chip click on any tab invalidates every other tab's `If-None-Match`.

### 6.5 `setPreferredEventRegion` action (new)

`DeveloperService`:

```cds
action setPreferredEventRegion(region: String) returns Boolean;
```

- `@requires: 'authenticated-user'` (matches the rest of `DeveloperService`).
- Validates `region ∈ {'AMERICAS','EMEA','APJ','VIRTUAL','ALL'} ∪ {null}`.
- UPSERT on `UserLearningPreferences` keyed by `user_ID` (mirrors existing role/deployment/cloud setters).
- Emits `preferences-changed` on the existing BroadcastChannel signal path.

## 7. Client — Vue island + Hugo partial

### 7.1 New island — `hugo-apps/src/homepage-events-band/`

```
homepage-events-band/
├─ index.ts                    ← island entry, mounted on data-app="homepage-events-band"
├─ EventsBand.vue              ← component (chip strip + 6 cards)
├─ tz-to-region.ts             ← Intl → region hint
├─ region-storage.ts           ← localStorage helper
└─ __tests__/
   ├─ tz-to-region.test.ts
   └─ EventsBand.test.ts
```

### 7.2 Initial region resolution priority

1. `window.__homepagePersonalized.eventsRegion` (signed-in envelope) if present.
2. `localStorage['sap-devs-homepage-events-region']` if set (survives across signed-out visits).
3. `Intl.DateTimeFormat().resolvedOptions().timeZone` → region prefix map:

| TZ prefix | Region |
|-----------|--------|
| `America/*`, `US/*`, `Canada/*` | `AMERICAS` |
| `Europe/*`, `Africa/*`, `Atlantic/*` | `EMEA` |
| `Asia/*`, `Australia/*`, `Pacific/*`, `Indian/*` | `APJ` |
| fallback | `ALL` |

`hint_used{region}` metric is emitted once per session when the TZ hint fires.

### 7.3 Chip strip behaviour

Chips: `All · Americas · EMEA · APJ · Virtual only`. Single-select. Selecting "Americas / EMEA / APJ" implies `includeVirtual=true` (matches the "physically near + anything I can join from my desk" mental model). Selecting "Virtual only" excludes physical events entirely.

On click:
- Always: write localStorage.
- Signed-in: fire-and-forget `POST /api/developer/setPreferredEventRegion`.
- Always: refetch `/api/homepage/events` with `If-None-Match` and re-render.

### 7.4 `/me/` LearningPreferences page

One extra `<Select>` for `preferredEventRegion` with a "Not set" option (writes `null`). Uses the existing v-for-over-`PROFILE_VOCAB` pattern. Save posts BroadcastChannel `'preferences-changed'`.

### 7.5 Hugo partial

`hugo/layouts/partials/homepage/events-band.html`:

```html
<section class="homepage-events-band" data-app="homepage-events-band">
  <h2>Upcoming events</h2>
  <div class="events-band__skeleton" data-role="skeleton">
    {{ range seq 6 }}<div class="event-card event-card--skeleton"></div>{{ end }}
  </div>
  <div class="events-band__chips" data-role="chips" hidden></div>
  <div class="events-band__cards" data-role="cards" hidden></div>
  <div class="events-band__empty"  data-role="empty" hidden>
    No upcoming events match this filter. <a href="/connect/">See the full events calendar →</a>
  </div>
</section>
```

Island hydration reveals `[data-role="chips|cards|empty]` and hides `[data-role="skeleton"]`. Empty state renders when the filtered fetch returns `[]`.

## 8. Failure modes

| Failure | Behaviour |
|---------|-----------|
| Both fetchers fail in 6h job | Job returns non-fatally; homepage keeps serving whatever's in DB. Metric bumps. Retries next cycle. |
| Single fetcher fails | Rows from the healthy source still upsert. `perSource` in summary shows the failure reason. |
| `regionFromLocation` returns `UNKNOWN` for a real location | Row stored `UNKNOWN`; `region_unknown[location=<enc>]` metric emitted; row shows under "All" only. |
| `CommunityEvents` empty (fresh env) | Endpoint returns `[]`; client shows empty state + link to `/connect/`. |
| `GET /api/homepage/events` 5xx or network error | Skeleton persists 8 s, then empty state. Logged at `console.debug`. |
| `setPreferredEventRegion` 5xx | Chip strip updates locally + localStorage still writes; log at `console.debug`. On next sign-in the DB value wins over the stale local one (deliberate — DB is authoritative). |
| `setPreferredEventRegion` 401 (session expiring mid-session) | Same as 5xx path — localStorage holds the intent until re-auth. Next signed-in request will re-emit via BroadcastChannel from `/me/` if the user re-saves. |
| `Intl.DateTimeFormat` unavailable | `tzToRegion` returns `'ALL'`. Same behaviour as unset preference. |
| `preferredEventRegion` corrupted in DB | `@assert.range` catches at write; endpoint validates + coerces on read. |
| `HomepageConfig.eventsBandEnabled = false` | Endpoint returns `[]`; Hugo partial elides the section. Existing kill switch. |
| `HomepageConfig.eventsBandAutoPullEnabled = false` (new) | Endpoint falls back to reading the legacy `Events` entity + returning the old shape. Rollback path — no redeploy. |

## 9. Observability

New metrics (via `srv/lib/metrics.js`):

| Metric | Meaning |
|--------|---------|
| `homepage.events.refresh{result}` | result ∈ `{ok, partial, failed}` — 1 bump per 6h cycle. |
| `homepage.events.refresh_rows{action}` | action ∈ `{inserted, updated}` — count per cycle. |
| `homepage.events.region_unknown[location=<enc>]` | 1 per row where derivation failed. Watches for drift in real-world location strings. |
| `homepage.events.requests{region,virtual,result}` | result ∈ `{200, 304, empty, 5xx}`. Drives cache-hit tuning + "no results" trend. |
| `homepage.events.pref_set{region}` | Emitted from `setPreferredEventRegion`. No PII. |
| `homepage.events.hint_used{region}` | 1 per session when TZ hint applied. |

## 10. Testing

**Unit (Vitest, in-memory SQLite):**
- `test/unit/region-from-location.test.js` — every distinct real-world location in current `CommunityEvents` + 20 crafted edges + explicit UNKNOWN cases.
- `test/unit/homepage-events-band.test.js` — filter matrix (region × includeVirtual × VIRTUAL), cache-key isolation, ordering, 6-item cap, invalid-region coercion.
- `test/unit/refresh-community-events-job.test.js` — happy path, single-source-fail, all-source-fail, region-derivation invocation, non-touching of `contentHash / lastExtractedHash / CommunityEventConceptLinks`.
- `test/unit/set-preferred-event-region.test.js` — enum validation, upsert on null and existing rows, 401 for anonymous, BroadcastChannel emission.
- `hugo-apps/src/homepage-events-band/__tests__/tz-to-region.test.ts` — one assertion per IANA prefix + fallback.
- `hugo-apps/src/homepage-events-band/__tests__/EventsBand.test.ts` — initial region priority (envelope > localStorage > TZ > 'ALL'), chip click round-trip, BroadcastChannel re-render, empty-state render.

**Hybrid (`npm run test:hybrid`, real HANA):**
- 30-row fixture spanning all regions × virtual/in-person × past/future × endDate null/set. Assert each chip returns the expected counts (memory rule: "probes must OBSERVE real rows, not assert an empty schema shape").
- Post-backfill assertion: `region` non-null on all fixture rows.

**Smoke (`test/smoke/homepage-events.test.js`):**
- `GET /api/homepage/events?region=EMEA` → 200, JSON array ≤ 6, every item has `region:'EMEA'` OR `isVirtual:true`.
- `GET /api/homepage/events?region=BOGUS` → 200 (coerced to ALL — never 400).

**Drift guards:**
- `test/unit/profile-fields-sync.test.js` extended for `preferredEventRegion`.
- New `test/unit/homepage-events-region-drift.test.js` — asserts server `regionFromLocation` and client `tzToRegion` share the AMERICAS/EMEA/APJ output vocabulary (inputs differ; enum must not).

**Pre-commit gate:**
- `npx cds deploy --to sqlite::memory:` after every `db/*.cds` edit (memory rule from #1043 — `@assert.range` violations are runtime-only).
- `superpowers:verification-before-completion` on the working island — load homepage locally, click every chip, verify DevTools shows expected `region=` param, verify BroadcastChannel round-trip from `/me/`.

## 11. Rollout

1. **PR 1 (schema + backfill + refresh job, cron disabled):** schema migration, `regionFromLocation`, `refresh-community-events-job.js`, `scripts/backfill-community-events-region.cjs`. Cron NOT yet registered. Zero user-visible change.
2. **Deploy to DEV.** Run backfill script against DEV HANA. Verify `region` column populated on all existing rows.
3. **PR 2 (cron registration):** 2-line change to `srv/cron-service.js`. Redeploy. Confirm cron fires + upserts new rows over the next 6 h.
4. **PR 3 (endpoint rewrite + Vue island + `/me/` field):** user-visible flip. Ships behind `HomepageConfig.eventsBandAutoPullEnabled=true` in DEV, `false` in PROD initially.
5. **DEV soak (~1 week).** Watch `region_unknown` metric; grow `regionFromLocation` rules as needed via follow-up PRs.
6. **PROD readiness:** backfill PROD, register cron on PROD, flip `eventsBandAutoPullEnabled=true`. Aligned with end-July 2026 cutover.

## 12. Non-goals

Listed inline in §2. Reiterated:
- No admin surface for location→region rules.
- No TechEd / user-group event types.
- No country-level granularity.
- No `.ics` calendar links.
- No deletion of legacy `Events` entity or its admin UI.

## 13. Open items (post-approval, tracked as issues if we hit them)

- Rule-drift automation: today, growing `regionFromLocation` requires a PR. If `region_unknown` metric climbs consistently, we may want an admin-editable rules table. Deferred until we see the metric shape.
- Hybrid test 30-row fixture — plan to draw from an anonymized snapshot of DEV `CommunityEvents.location` values rather than fully hand-crafted, so the parser is tested against real strings. Fixture generation script lives in the implementation plan.
