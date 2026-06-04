# A/B Instrumentation for `/` vs `/browse/` — Design

- **Issue:** [#204](https://github.com/sap-tutorials/tutorials-ims/issues/204)
- **Parent:** [#174](https://github.com/sap-tutorials/tutorials-ims/issues/174) (alternative `/browse/` homepage)
- **Date:** 2026-06-04
- **Author:** Claude (with Tom's design decisions)

## Problem

Issue #174 shipped `/browse/` as a coexisting alternative homepage for the explicit purpose of A/B testing it against `/`. Without instrumentation, the A/B test produces no comparable data and no informed cutover decision is possible. #204 is the **measurement infrastructure** — it must land before any meaningful A/B period begins.

The repo currently has zero client-side analytics. `srv/lib/adobe-analytics.js` exists but is server-side only (fires beacons from CAP on tutorial completion). `AnalyticsService` (`/admin/analytics`) is admin-read-only over existing IMS entities — a query surface, not an event sink. There is no `PageView` / `FilterChange` / `ClickEvent` schema today.

## Goal

Anonymous, session-scoped client-side telemetry on `/`, `/browse/`, and `/tutorials/<slug>` that lets us answer:

1. **Daily session count per surface** (sanity / denominator)
2. **Filter usage rate** — % of sessions with ≥1 `filter_change`
3. **Card click-through rate** — % of sessions with ≥1 `card_click`
4. **Time-to-first-click** — median, p25, p75
5. **Bounce rate** — sessions with `page_view` but zero `card_click`
6. **Search usage rate** — sessions with `filter_change.kind='search'`

Plus secondary descriptive metrics (curation-rail engagement, scroll depth, pagination, time-on-page) that inform *why* one surface wins.

**Cutover decision rule:** **15,000 total sessions for "decided"** (industry-standard 95% CI / 80% power on click-through detecting ≥2pp difference) OR **2,400 sessions with ≥5pp gap on click-through** for "early-stop allowed." Click-through rate is the deciding metric; secondary metrics inform but don't trigger cutover.

## Non-goals

- **User-keyed tracking.** No `userId`, no IP, no fingerprint. Sessions are anonymous and per-tab.
- **Search-query content recording.** Only that search happened, not what was searched. (Privacy-sensitive; separate followup if ever wanted.)
- **Long-term identity / returning-visitor analysis.** `sessionStorage` cleared on tab close = correct behavior.
- **Server-side analytics beacon.** Adobe Analytics stays as-is for tutorial completions.
- **Mobile drawer instrumentation.** Drawer not shipped yet (issue #216).
- **Cookie banner consent flow.** `sessionStorage` is generally exempt; verify per [[sap-corporate-cmp]] before flag flip.
- **Decision to actually cut over.** This issue ships the *measurement*; the cutover is a separate decision.

## Locked design decisions

Captured from Tom's `AskUserQuestion` answers during brainstorming:

| # | Question | Decision |
|---|---|---|
| 1 | Destination architecture | New CAP entity + endpoint, queryable via `AnalyticsService` |
| 2 | Privacy & identity | Anonymous session ID, no user ID — `UIEvent` outside `@PersonalData` / no anonymization cascade |
| 3 | Event taxonomy | Rich — 7 event types (`page_view`, `filter_change`, `card_click` with `source`, `pagination_change`, `rail_show_all_click`, `scroll_depth`, `page_leave`); no search-query content |
| 4 | Batching strategy | Per-session batch; flush every 30s + on every `card_click` + on `pagehide` via `sendBeacon` |
| 5 | Surface boundary | Strict `/` and `/browse/` instrumented; tutorial pages fire `referred_view` to close the click→tutorial-load funnel |
| 6 | sessionId lifetime | `sessionStorage` only; `crypto.randomUUID()`-generated; per-tab |
| 7 | Dashboard / query surface | Pre-seeded SavedQueries in HANA + runbook; 6 canonical queries (5 metrics + daily session count) |
| 8 | Statistical thresholds | 15k total sessions for "decided" / 2,400 with ≥5pp gap for "early-stop"; in-query 95% CI calculation; secondary metrics descriptive |
| 9 | Shipping order | 4 sequenced PRs (schema+endpoint → frontend → tutorial-referred → SavedQueries+runbook) |

## Architecture

### Module map

```
hugo-apps/src/shared/analytics/                   [NEW]
  tracker.ts                                      Core: sessionId, batcher, sender, event API
  tracker.test.ts                                 Pure tests (no DOM)
  events.ts                                       Event-type definitions + payload validators
  page-events.ts                                  Page-level wiring (page_view, page_leave, scroll_depth)
  filter-events.ts                                useNavigatorFilters integration (filter_change)
  card-events.ts                                  Card click + pagination + rail_show_all_click
  referred-view.ts                                Tutorial-page entry point

hugo-apps/src/navigator/main.ts                   [MODIFIED — PR 2] wire trackers post-mount
hugo-apps/src/browse/main.ts                      [MODIFIED — PR 2] wire trackers post-mount
hugo-apps/src/tutorial/                           [NEW DIR — PR 3]
  main.ts                                         createApp + referredView() entry point
hugo-apps/vite.config.ts                          [MODIFIED — PR 3] add tutorial entry to rollupOptions.input

hugo/layouts/_default/baseof.html                 [MODIFIED — PR 3] <script src=/js/tutorial.js> on tutorial pages
hugo/layouts/partials/header.html                 (no change — bootstrap already loads site-wide)

db/schema.cds                                     [MODIFIED — PR 1] add UIEvent entity
srv/server.js                                     [MODIFIED — PR 1] register POST /api/ui-event handler
srv/lib/ui-event-handler.js                       [NEW — PR 1] write-side handler
srv/lib/__tests__/ui-event-handler.test.js        [NEW — PR 1] write tests

srv/analytics-service.cds                         [MODIFIED — PR 4] expose UIEvent (read-only)
srv/lib/ui-event-saved-queries.js                 [NEW — PR 4] seed script for 6 canonical queries
docs/developers/operations/ab-comparison-runbook.md  [NEW — PR 4] queries + significance calc + decision rule
```

### Boundary contract

| Module | Owns | Depends on | Public surface |
|---|---|---|---|
| `tracker.ts` | sessionId lifetime, batch buffer, flush triggers, sendBeacon vs fetch fallback | `crypto.randomUUID()`, `sessionStorage`, `navigator.sendBeacon` | `track(eventType, payload)`, `flush()`, `getSessionId()` |
| `events.ts` | Event payload shapes (TS types + runtime validators) | none | type `UIEvent`, `validateEvent(e)` |
| `page-events.ts` | `page_view` on mount, `page_leave` on `pagehide`, `scroll_depth` thresholds | `tracker.track`, `IntersectionObserver`, `pagehide` | `wirePageEvents(surface)` |
| `filter-events.ts` | `filter_change` on each filter mutation | `tracker.track`, the `useNavigatorFilters` reactive state | `wireFilterEvents(filters, surface)` |
| `card-events.ts` | `card_click`, `pagination_change`, `rail_show_all_click` via DOM event delegation | `tracker.track`, document event listeners | `wireCardEvents(surface)` |
| `referred-view.ts` | `referred_view` fired once on tutorial mount | `tracker.track`, `tracker.getSessionId` | `fireReferredView(slug)` |
| `ui-event-handler.js` | Validate payload, batch insert, return 204 | CDS `cds.run`, `UIEvent` entity | `handleUIEvent(req, res)` |
| `ui-event-saved-queries.js` | Seed 6 SavedQueries on first deploy | `cds.connect.to('AdminService')`, `SavedQueries` entity | `seedABComparisonQueries()` |

### Schema

`db/schema.cds` — new `UIEvent` entity, anonymous (no `@PersonalData`):

```cds
entity UIEvent {
  key ID            : UUID;                          // server-generated
      sessionId     : String(36) not null;           // browser-generated UUID v4
      surface       : String(32) not null;           // '/', '/browse/', '/tutorials/'
      eventType     : String(32) not null;           // page_view | filter_change | ...
      timestamp     : Timestamp not null;            // browser-side (ms precision)
      receivedAt    : Timestamp default $now;        // server-side
      payload       : LargeString;                   // JSON-serialized type-specific fields
      userAgent     : String(512);                   // truncated (first 512 chars)
      buildAt       : String(32);                    // hugo build hash for diff-attribution
}
```

Indexes: `(sessionId)`, `(surface, timestamp)`, `(eventType, timestamp)`. Ready for the canonical queries.

**Source of `buildAt`:** the tracker reads `window.__BROWSE_BUILD_AT` client-side. This global is already emitted by `hugo/layouts/browse/list.html` (per #174 PR 2). PR 2 of #204 extends the same `<script>window.__BROWSE_BUILD_AT = "{{ $browse.buildAt }}";</script>` snippet into a shared partial so `/` and `/tutorials/*` also expose it. Tracker contract: read the global, fall back to empty string if undefined, ship as-is to the server.

**Why no `@PersonalData`:** sessionId alone is not personal data (anonymous, per-tab, cleared on close, not joined to identity). `userAgent` is truncated; even at 512 chars it's not unique enough for fingerprinting in a way that joins to identity. Not joining the anonymization cascade ([[feedback-cap-anonymize-hardcoded-entities]]) is a deliberate design choice.

### Event payload shapes

`events.ts` defines TS types + runtime validators. Each event is `{ sessionId, surface, eventType, timestamp, payload }` where `payload` varies by `eventType`:

```ts
// page_view
{ path: string, referrer: string }

// filter_change
{ kind: 'type'|'level'|'product'|'topic'|'search'|'sort'|'clear-all'|'quick-new'|'quick-noLicense'
  value?: string | string[] }

// card_click
{ cardType: 'mission'|'group'|'tutorial'
  cardId: string                                    // slug or `mission-N` / `group-N`
  position: number                                  // 0-indexed within displayedItems
  source: 'grid'|'featured-rail'|'recent-rail' }

// pagination_change
{ fromPage: number, toPage: number }

// rail_show_all_click
{ railType: 'featured'|'recent', targetPath: string }

// scroll_depth
{ maxPercent: 25|50|75|100 }                        // fired once per threshold per session

// page_leave
{ durationMs: number, eventCount: number }          // eventCount as cross-check against other sources

// referred_view (tutorial pages only)
{ tutorialSlug: string, fromSurface: string, fromCardId: string }
```

Validation: each event type has an explicit validator in `events.ts`; mismatches → 400 + drop the entire batch.

## Data flow

### Write path (every event)

```
User interaction (click / scroll / mount / etc.)
    │
    ▼
hugo-apps tracker module fires event
    │
    ▼
tracker.track(eventType, payload) appends to in-memory buffer
    │
    ├── if eventType === 'card_click' → flush immediately
    ├── else if buffer ≥ 30s old (timer) → flush
    └── else → wait
    │
    ▼ (on flush)
POST /api/ui-event (batch of 1-N events as JSON)
    │  Headers: Content-Type: application/json
    │  Body: { sessionId, events: [...] }
    │
    ▼
Approuter → CAP /api/ui-event handler
    │
    ▼
ui-event-handler.js
    ├── validate sessionId is UUID-shaped (regex check)
    ├── validate events is non-empty array, each event matches one of 7 types
    ├── validate payload size < 32 KB (defensive)
    └── INSERT batch into UIEvent (single multi-row CQL)
    │
    ▼
return 204 No Content (or 4xx with reason on validation fail)
```

### Final flush on tab close

```
User closes tab / navigates away
    │
    ▼
'pagehide' listener fires (NOT 'beforeunload' — pagehide is more reliable on iOS Safari)
    │
    ▼
tracker.flush() called synchronously
    │
    ▼
navigator.sendBeacon('/api/ui-event', JSON.stringify(batch))
    │  ← reliable; browser flushes before tear-down
    │  ← 64 KB payload limit (we cap at 32 KB defensively)
    ▼
returns true if queued; false = sendBeacon unavailable or payload too big
    │
    ▼ (if false, fallback)
fetch('/api/ui-event', { method: 'POST', body: ..., keepalive: true })
```

### Failure modes & bounded errors

| Failure | Recovery |
|---|---|
| Browser doesn't support `crypto.randomUUID` | Fall back to `Math.random`-based UUID-like string |
| `sessionStorage` throws (private mode, quota) | Disable tracker entirely; one console.warn; no events fire |
| `POST /api/ui-event` 5xx | Tracker retains buffer + retries on next flush trigger. Drop after 3 failures, self-disable |
| `POST /api/ui-event` 4xx | Drop the batch, log console.warn (4xx means payload is wrong, retry won't help) |
| `navigator.sendBeacon` returns false | Fall back to `fetch({keepalive: true})` |
| `UI_EVENTS_ENABLED` env var unset on server | `POST /api/ui-event` returns 503; tracker treats same as 5xx; self-disables after 3 |
| Server-side INSERT fails (HANA hiccup) | Return 500. Tracker retries. After 3 fails, drops batch |
| Payload exceeds 32 KB | Return 413. Tracker drops batch and emits warning |

## Statistical methodology

The cutover decision uses **two-proportion z-test on click-through rate** between surfaces:

```
p1 = clicks_/_browse_ / sessions_/_browse_
p2 = clicks_/ / sessions_/
p_pool = (clicks_/_browse_ + clicks_/) / (sessions_/_browse_ + sessions_/)
SE = sqrt(p_pool * (1 - p_pool) * (1/n1 + 1/n2))
diff = p1 - p2
CI_95 = diff ± 1.96 * SE
```

**Cutover rule:**
- If `|diff| ≥ 0.05` AND CI excludes 0 (with `min(n1, n2) ≥ 1200`) → "early-stop": one surface wins.
- Else if `min(n1, n2) ≥ 7500` (15k total) AND CI excludes 0 → "decided": one surface wins on a small but real difference.
- Else if `min(n1, n2) ≥ 7500` AND CI includes 0 → "tied": surfaces equivalent at our power; pick either based on other criteria (engineering cost, follow-on roadmap).

The runbook embeds the CI calculation directly in HANA SQL using `SQRT()` and arithmetic — no external significance calculator needed.

**Secondary metrics (filter usage, time-to-first-click, scroll depth, rail engagement) are descriptive only.** They inform *why* a surface won but don't trigger cutover. Specifically called out so the team doesn't fall into "filter usage is higher on `/browse/` so it must be better" thinking — filter usage is a means, not an end.

## Test plan

| Layer | Tooling | Coverage |
|---|---|---|
| **PR 1** | Vitest, no DOM | `ui-event-handler.test.js`: 8 cases (valid batch, schema violations, oversized payload, dormant flag/503, sessionId UUID validation, batch insert success, retries on conflict, empty array) |
| **PR 2** | Vitest + happy-dom for DOM-touching tests | `tracker.test.ts`: 10 cases pure (sessionId stable, batch flush triggers, sendBeacon vs fetch fallback, retries, kill-switch). Plus integration in `useNavigatorFilters.test.ts` confirming `filter_change` fires |
| **PR 3** | Vitest + happy-dom | `referred-view.test.ts`: fires once + only when sessionId in storage + carries the slug |
| **PR 4** | Vitest, no DOM | `ui-event-saved-queries.test.js`: seed is idempotent; each query parses + lints via existing `analytics-sql-validator` |
| Manual | Tom's checklist post-deploy | Open `/`, click cards, check `UIEvent` rows show up; flip flag per-environment when ready |

## Sequencing

```
PR 1 (~3-4 days) — schema + endpoint
       │  Behind UI_EVENTS_ENABLED env var (dormant = 503 by default)
       │  Tracker module doesn't exist yet → no client-side fire path
       ↓
PR 2 (~5-7 days) — frontend tracker + / + /browse/ instrumentation
       │  All 7 event types fire from / and /browse/
       │  Tracker self-disables on 503, so safe to merge before flag flip
       │  /tutorials/ pages NOT yet instrumented (referred_view dormant)
       ↓
PR 3 (~1-2 days) — tutorial-page referred_view
       │  Adds tutorial.ts entry; loads on /tutorials/* via baseof.html
       │  Closes the click → tutorial-load funnel
       ↓
PR 4 (~2-3 days) — SavedQueries + runbook + AnalyticsService exposure
       │  Read-side; safe to land last (data already accumulating)
       │  Idempotent seed script runs on deploy
       ↓
Tom flips UI_EVENTS_ENABLED=true on tutorials-srv DEV (per-environment)
A/B test data starts accumulating
```

Each PR is independently revertible. PR 1 ships dormant; PR 2 ships safely against the dormant endpoint (tracker self-disables). PR 3 only wires tutorial pages — landing it before A/B starts means full funnel data from day one of the test. PR 4 lands last; data has been accumulating throughout PR 3's window so when SavedQueries seed, there's something to query.

## Risks & mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| SAP corporate cookie-banner CMP requires consent for `sessionStorage` | Low | Medium | Verify per [[sap-corporate-cmp]] before flag flip; sessionStorage is generally exempt as "Required" or no consent needed for session-only |
| Approuter / CAP doesn't accept `/api/ui-event` payload size | Low | Low | Test with realistic batches early; 32 KB defensive cap |
| 5xx storms log noise | Low | Low | Tracker self-disables after 3 consecutive 5xx; backoff |
| `pagehide` doesn't fire reliably on iOS Safari | Medium | Low | Two flush triggers cover it: 30s timer + immediate-on-card-click. Worst case: only the last <30s of events lost on iOS edge |
| Statistical significance copy-paste error in runbook | Low | High | In-query CI calculation in HANA SQL (no spreadsheet step); worked examples checked into runbook |
| HANA storage cost grows unboundedly | Low | Low | Estimate at 50-250 MB/day at our session scale; trivial. Plan a `ui-event-gc` cron for events older than 90 days as a follow-up if it becomes an issue |
| `UI_EVENTS_ENABLED` flag accidentally flipped on PROD before A/B | Low | Medium | Per-environment flag flip; runbook documents the order (DEV → QA → PROD) and the verification step (look for events in `UIEvent` table) |

## Followup issues (file separately)

These are explicitly out-of-scope for this work but worth tracking:

1. **Search-query content recording** — fire `search_query` events with truncated/lowercased term for "what are users searching for?" analysis. Privacy-sensitive (search terms can be PII-adjacent — names, error messages); decide consent model before implementation.
2. **Per-user (logged-in) analysis** — extend `UIEvent` with optional `userId`, join `@PersonalData` annotation, extend anonymization cascade. Answers "do users with progress saved behave differently on `/browse/`?"
3. **Long-term returning-visitor tracking** — `localStorage` + cookie consent, distinguish "first-time visitor" from "returning visitor over weeks." Harder; needs CMP work.
4. **`UIEvent` GC cron** — daily/weekly delete of events older than (e.g.) 90 days. Gates on confirming HANA storage cost is real.
5. **Real-time A/B dashboard** — instead of SavedQueries + runbook, a chart-based view in admin shell. Defer until cutover decision actually needs sub-day visibility (current rule: weekly check is fine).

## References

- Issue: [#204](https://github.com/sap-tutorials/tutorials-ims/issues/204)
- Parent: [#174](https://github.com/sap-tutorials/tutorials-ims/issues/174) — alternative `/browse/` homepage
- Spec for parent: [docs/superpowers/specs/2026-06-02-browse-layout-design.md](2026-06-02-browse-layout-design.md)
- Existing analytics infrastructure (server-side beacon): [srv/lib/adobe-analytics.js](../../../srv/lib/adobe-analytics.js)
- Existing query surface: [srv/analytics-service.cds](../../../srv/analytics-service.cds)
- SavedQueries infrastructure (Phase 4): [project_analytics_builder_phase4.md](../../../C:\Users\I809764\.claude\projects\d--projects-tutorials-poc\memory\project_analytics_builder_phase4.md) (memory)
- Anonymization cascade (avoided): [feedback-cap-anonymize-hardcoded-entities.md](../../../C:\Users\I809764\.claude\projects\d--projects-tutorials-poc\memory\feedback_cap_anonymize_hardcoded_entities.md) (memory)
- Cookie banner constraints: [sap-corporate-cmp.md](../../../C:\Users\I809764\.claude\projects\d--projects-tutorials-poc\memory\reference_sap_corporate_cmp.md) (memory)
