# Site-wide Alert System (issue #548)

**Status:** Draft
**Date:** 2026-06-26
**Author:** Tom Jung (via Claude brainstorming session)
**Issue:** [#548 — wire up the alert feature in tutorial system for things like major product launches and Devtoberfest activities](https://github.com/sap-tutorials/tutorials-ims/issues/548)

## Problem

The platform has two existing banner mechanisms, neither of which fits the issue:

- [`hugo/layouts/partials/tutorial-banners.html`](../../../hugo/layouts/partials/tutorial-banners.html) — per-tutorial, build-time, driven by frontmatter (`deprecated`, `notice`, `warning`). Cannot toggle without re-running `fetch-tutorials` + Hugo + publish.
- [`hugo/layouts/partials/qa-banner.html`](../../../hugo/layouts/partials/qa-banner.html) — site-wide but baked from a Hugo site param. Right scope, wrong cadence.

The product surface in [`hugo/layouts/partials/header.html`](../../../hugo/layouts/partials/header.html) already declares `<ui5-shellbar … show-notifications notifications-count="">` — the Fiori notification bell is wired into the chrome but no producer feeds it today.

We need a site-wide, admin-managed alert mechanism that an editor can switch on/off without a rebuild, so campaign messages ("Devtoberfest starts Monday", "S/4HANA Cloud Public 2511 just launched") can appear and disappear on a schedule.

## Goals

1. Admin can author and schedule an alert in the existing `/admin-ui/` shell using the same Fiori-Elements pattern as `Events`, `FeaturedTasks`, `Advocates`.
2. Active alerts appear on the existing shellbar bell as `ui5-li-notification` rows in a popover, with a badge count.
3. Alerts can run on a schedule (`startsAt` + `endsAt`) OR ad-hoc (null `endsAt`, admin flips `active` off when done).
4. Three audiences supported: `ALL` (anonymous + authenticated), `AUTHENTICATED` (logged-in only), `ADMIN` (admins only).
5. Per-device dismissal via `localStorage`; dismissals never resurrect.
6. Saving an alert does NOT trigger a Hugo / content rebuild — alerts are runtime-served.
7. New code path lands behind no feature flag (no rollout staging needed for v1).

## Non-Goals

- Markdown rendering in alert body — HTML-escape only in v1.
- Per-user dismiss persistence (cross-device) — `localStorage` only.
- URL-prefix targeting — audience enum is the only filter beyond `active` + date window.
- Per-tutorial alert badges — orthogonal to the bell, future concern.
- Push / browser-notifications API — no permission prompt of visitors.
- Real-time updates via WebSocket — 5-min in-tab poll is plenty.
- Linkage to the `Events` entity — deferred; can be added later as a nullable association without migration concern.
- i18n of alert title/body — English-only per project policy.

## Architecture

```
sap-tutorials/tutorials-ims                    (NEW = green; reuses = blue)
─────────────────────────────────────────────────────────────────────────
                                   ┌────────────────────────────┐
                                   │  Admin (XSUAA Admin role)  │
                                   └─────────────┬──────────────┘
                                                 │ Fiori Elements V4
                                                 ▼
                   ┌──────────────────────────────────────────────┐
                   │  /admin-ui/#alerts-display                   │  NEW
                   │  app/admin/alerts/   (peer of events, etc.)  │
                   └────────────────────┬─────────────────────────┘
                                        │  OData $batch (draft)
                                        ▼
                   ┌──────────────────────────────────────────────┐
                   │  AdminService.Alerts  (draft-enabled)        │  NEW projection
                   │  + AdminService.AlertCtaTargets (unbound RO) │  NEW projection
                   └────────────────────┬─────────────────────────┘
                                        │
                                        ▼
                   ┌──────────────────────────────────────────────┐
                   │  ims.Alerts  (cuid, managed)                 │  NEW entity
                   │  HANA table created by HDI                   │
                   └────────────────────┬─────────────────────────┘
                                        │  cds.ql in srv code
                       ┌────────────────┴────────────────┐
                       ▼                                 ▼
        ┌──────────────────────────┐         ┌──────────────────────────┐
        │ GET /api/alerts          │  NEW    │ GET /api/alerts/me       │  NEW
        │ public, no auth          │         │ XSUAA-authenticated      │
        │ audience = ALL only      │         │ ALL + AUTHENTICATED      │
        │ Cache-Control public,    │         │   + ADMIN if isAdmin     │
        │   max-age=60, SWR=300    │         │ Cache-Control private,   │
        │                          │         │   max-age=30             │
        └────────────┬─────────────┘         └────────────┬─────────────┘
                     │                                    │
                     │  In-memory LRU/TTL, debounce-purged on AdminService.Alerts save
                     │                                    │
                     └─────────────────┬──────────────────┘
                                       │  fetch()
                                       ▼
        ┌────────────────────────────────────────────────────────────────┐
        │  hugo-apps/src/alerts/main.ts  +  Alerts.vue                   │  NEW island
        │  Mounts on every page (baseof.html) except previewMode and qa  │
        │  1. Reads <html data-authenticated> set by header.html         │  REUSED
        │  2. Picks /api/alerts vs /api/alerts/me                        │
        │  3. Filters out localStorage-dismissed ids                     │
        │  4. Sets #app-shellbar notifications-count                     │
        │  5. Mounts <ui5-popover id="sb-alerts-popover">                │  NEW partial
        │     containing <ui5-list> of <ui5-li-notification> rows        │
        │  6. Wires notifications-click on the shellbar                  │
        │  7. Polls every 5 min while document.visibilityState=visible   │
        └────────────────────────────────────────────────────────────────┘
                                       │
                                       ▼
                          ┌────────────────────────┐
                          │  ShellBar bell (already │  REUSED
                          │  in header.html)        │
                          └────────────────────────┘
```

## Data Model

New entity in [`db/schema.cds`](../../../db/schema.cds), placed alongside `FeaturedTasks` to mirror "admin-curated runtime content":

```cds
entity Alerts : cuid, managed {
  title         : String(200)                                         @mandatory;
  body          : String(2000);                                       // optional, HTML-escaped on render
  severity      : String(20) enum {
    Information; Success; Warning; Error;
  } default 'Information'                                             @mandatory;
  audience      : String(20) enum { ALL; AUTHENTICATED; ADMIN; }
                                  default 'ALL'                       @mandatory;
  startsAt      : Timestamp                                           @mandatory;
  endsAt        : Timestamp;                                          // null = ad-hoc, "on until I turn it off"
  ctaLabel      : String(60);
  ctaUrl        : String(500);
  dismissible   : Boolean default true;
  active        : Boolean default true;                               // kill switch, independent of date window
}
```

**Why these choices:**

- `cuid` (not `LegacyKeyed`) — new entity, no IMS-era migration concern.
- **No `@assert.unique`** — multiple concurrent alerts are explicitly supported (Devtoberfest + product launch can coexist; bell shows N).
- `active` separate from the date window — gives admin a one-click "off" without editing `endsAt`. Mirrors `Events.active`.
- `body` cap of 2 000 chars — well above what fits in a notification card; v1 renders as plain escaped text. Cap exists to bound payload and discourage long-form content (which belongs in a CTA-linked page).
- `ctaLabel` + `ctaUrl` both optional and independent — admin can have an info-only alert with no link.

**Reserved-word audit:** `severity`, `audience`, `body`, `active`, `dismissible` are not reserved in HANA SQL or in the project's existing entities (`Events.active` already exists). No conflicts.

**Audit logging:** **NOT** in [`db/audit-logging.cds`](../../../db/audit-logging.cds) — alerts contain no PII and are admin-curated content, not user data. No `@PersonalData` annotations.

**Change tracking:** **YES** in [`db/change-tracking.cds`](../../../db/change-tracking.cds). Admin saves to alerts appear in the changelog tile — every change to a public-facing message is reviewable. Per memory `feedback_changelog_curation_singletons_and_ai_tables`, `Alerts` is neither a config singleton nor AI-generated, so it does not qualify for the no-changelog allowlist.

**Rebuild classifier:** [`srv/lib/_classify-rebuild-mode.js`](../../../srv/lib/_classify-rebuild-mode.js) — explicitly map `Alerts` to `null` (no rebuild). Hybrid test asserts this. This is the whole point of the issue: turn an alert on/off without rebuilding Hugo.

## Read Endpoints

Two endpoints added to the express bridge in [`srv/server.js`](../../../srv/server.js), implemented in a new module `srv/lib/alerts-endpoint.js` (exports `mountAlertEndpoints(app, srv)` + `invalidateAlertsCache()`).

### `GET /api/alerts` (public)

- **Auth:** none.
- **Filter:** `audience = 'ALL' AND active = true AND startsAt ≤ now AND (endsAt IS NULL OR endsAt > now)`.
- **Response:**
  ```json
  {
    "alerts": [
      {
        "id": "01J…cuid",
        "title": "Devtoberfest starts Monday",
        "body": "Join the kickoff on the developers.sap.com hub.",
        "severity": "Information",
        "ctaLabel": "Open hub",
        "ctaUrl": "/devtoberfest/",
        "dismissible": true,
        "startsAt": "2026-09-28T07:00:00.000Z",
        "endsAt":   "2026-10-31T23:59:00.000Z"
      }
    ],
    "fetchedAt": "2026-06-26T12:34:56.000Z"
  }
  ```
- **Headers:** `Cache-Control: public, max-age=60, stale-while-revalidate=300`. Matches the `/api/advocates` shape.
- **Guarantees:** never returns `audience != 'ALL'` rows, even if requested with credentials.

### `GET /api/alerts/me` (authenticated)

- **Auth:** XSUAA session. Returns 401 if anonymous. Equivalent to a service-level `@requires: 'authenticated-user'`.
- **Filter:** `audience IN ('ALL', 'AUTHENTICATED')`, plus `'ADMIN'` rows iff `req.user.is('Admin')` (reuses the existing role-check helper in `srv/lib/`).
- **Response:** same shape as `/api/alerts`.
- **Headers:** `Cache-Control: private, max-age=30`. Shorter TTL because the payload is role-dependent.

### Caching

Bounded in-memory TTL cache keyed by `(endpoint, role-flag)`, 60 s TTL, ~10 keys max — same pattern as [`srv/lib/secret-resolver.js`](../../../srv/lib/secret-resolver.js). Debounce-purged on `AdminService.Alerts` CREATE/UPDATE/DELETE via a `cds.on('served')` hook that wires `invalidateAlertsCache()` into the AdminService after-handlers. Within ~5 s of admin save, both endpoints return the new state on next request.

### Query implementation

Pure `cds.ql` — no raw SQL (project rule). Pseudo-code:

```js
const now = new Date()
const rows = await SELECT.from(Alerts).where({
  active: true,
  startsAt: { '<=': now },
  or: [{ endsAt: null }, { endsAt: { '>': now } }],
  audience: { in: allowedAudiences },   // ['ALL'] | ['ALL','AUTHENTICATED'] | ['ALL','AUTHENTICATED','ADMIN']
})
```

## Admin UI

New Fiori Elements V4 List Report + Object Page at `app/admin/alerts/`, peer of `app/admin/events/`, `app/admin/featuredtasks/`, `app/admin/advocates/`. Draft-enabled per the project default (`@odata.draft.enabled` on the AdminService projection — per memory `feedback_fiori_cap_editing_default_draft`).

**Shell wiring:** added as a `componentUsage` in [`app/admin-shell/webapp/manifest.json`](../../../app/admin-shell/webapp/manifest.json). Side-nav entry "Alerts" in [`Shell.controller.js`](../../../app/admin-shell/webapp/controller/Shell.controller.js)'s nav model, target hash `#alerts-display`. Icon: `notification-2`.

**Service projection** in [`srv/admin-service.cds`](../../../srv/admin-service.cds):

```cds
@odata.draft.enabled
entity Alerts as projection on ims.Alerts;

@readonly entity AlertCtaTargets : {
  key url : String(500);
      label : String(100);
};
```

`AlertCtaTargets` is an in-memory unbound entity backed by an `srv.on('READ', 'AlertCtaTargets', ...)` handler in `srv/admin-service.js` that returns the canonical CTA target list from [`srv/lib/alert-cta-targets.js`](../../../srv/lib/alert-cta-targets.js):

| label                | url                      |
|----------------------|--------------------------|
| Home                 | `/`                      |
| Browse               | `/browse/`               |
| Devtoberfest         | `/devtoberfest/`         |
| Developer Advocates  | `/developer-advocates/`  |
| My Completions       | `/me`                    |
| App Space            | `/app-space`             |
| Event Display        | `/event-display`         |

Updating the list is a code-only change in v1 — no admin-of-admins UI needed.

**Annotations** in [`app/admin-annotations.cds`](../../../app/admin-annotations.cds):

```cds
annotate AdminService.Alerts with @(
  UI.LineItem: [
    { $Type: 'UI.DataField', Value: active,    Label: 'On' },
    { $Type: 'UI.DataField', Value: severity,  Criticality: severityCrit },
    { $Type: 'UI.DataField', Value: audience },
    { $Type: 'UI.DataField', Value: title },
    { $Type: 'UI.DataField', Value: startsAt,  Label: 'Start (UTC)' },
    { $Type: 'UI.DataField', Value: endsAt,    Label: 'End (UTC)' },
  ],
  UI.SelectionFields: [ active, severity, audience ],
  UI.HeaderInfo: {
    TypeName: 'Alert', TypeNamePlural: 'Alerts',
    Title: { Value: title }, Description: { Value: severity },
  },
  UI.Facets: [
    { $Type: 'UI.ReferenceFacet', Label: 'General',        Target: '@UI.FieldGroup#General' },
    { $Type: 'UI.ReferenceFacet', Label: 'Scheduling',     Target: '@UI.FieldGroup#Scheduling' },
    { $Type: 'UI.ReferenceFacet', Label: 'Call to action', Target: '@UI.FieldGroup#Cta' },
  ],
  UI.FieldGroup #General:    { Data: [ { Value: title }, { Value: body }, { Value: severity }, { Value: audience }, { Value: active }, { Value: dismissible } ] },
  UI.FieldGroup #Scheduling: { Data: [ { Value: startsAt }, { Value: endsAt } ] },
  UI.FieldGroup #Cta:        { Data: [ { Value: ctaLabel }, { Value: ctaUrl } ] },
);

annotate AdminService.Alerts {
  severity @Common.ValueListWithFixedValues: true
           @assert.range: true;
  audience @Common.ValueListWithFixedValues: true
           @assert.range: true;
  ctaUrl   @Common.ValueList: {
             CollectionPath: 'AlertCtaTargets',
             SearchSupported: true,
             Parameters: [
               { $Type: 'Common.ValueListParameterInOut',        LocalDataProperty: ctaUrl, ValueListProperty: 'url' },
               { $Type: 'Common.ValueListParameterDisplayOnly',                              ValueListProperty: 'label' }
             ]
           }
           @Common.ValueListWithFixedValues: false;  // suggests, but free text allowed
};

extend AdminService.Alerts with {
  virtual severityCrit : Integer;  // 1=Error, 2=Warning, 3=Information/None, 5=Success
};
```

`severityCrit` is computed in `srv.on('READ', 'Alerts', after)` — pure mapping, no IO — and drives the `Criticality` colouring of the List Report row indicator so admins can scan active-alert state at a glance.

**i18n:** new `app/admin/alerts/webapp/i18n/i18n.properties` plus matching annotation `@Common.Label` keys.

## Frontend Island

**Files:**

- `hugo-apps/src/alerts/main.ts` — Vite entry; boots after `customElements.whenDefined('ui5-shellbar')`.
- `hugo-apps/src/alerts/Alerts.vue` — Vue 3 component that owns the popover content render.
- `hugo-apps/src/alerts/dismiss-filter.ts` — pure function: `(alerts, dismissedSet) => visibleAlerts`. Unit-tested.
- `hugo-apps/src/alerts/severity-priority.ts` — pure function: `severity → ui5 priority`. Unit-tested.
- `hugo-apps/src/alerts/endpoint-select.ts` — pure function: `(authenticated) => endpointUrl`. Unit-tested.
- New Vite entry in [`hugo-apps/vite.config.ts`](../../../hugo-apps/vite.config.ts) → emits `hugo/static/js/alerts.js`.
- New Hugo partial `hugo/layouts/partials/alerts-popover.html` (popover markup only; no logic).
- [`hugo/layouts/_default/baseof.html`](../../../hugo/layouts/_default/baseof.html) — include the partial and script tag, both gated `{{ if and (not site.Params.qa) (not site.Params.previewMode) }}`.

**Boot sequence:**

1. Read `<html data-authenticated="true"|undefined>` (set by [`header.html`](../../../hugo/layouts/partials/header.html) `checkAuth`).
2. Fetch the right endpoint:
   - authenticated → `/api/alerts/me` (credentials: include)
   - anonymous → `/api/alerts`
   - On network failure → fail silently (zero alerts; never throw a visible error). Bell stays empty.
3. Compute `visible = dismissFilter(alerts, readDismissedSet())`.
4. Update `#app-shellbar`:
   - `notifications-count` attribute → `String(visible.length)` (empty string when 0 — UI5 renders no badge).
   - Populate `#sb-alerts-list` inside the popover with one `<ui5-li-notification>` per row.
5. Wire the `notifications-click` event on `#app-shellbar` to open `#sb-alerts-popover`, mirroring the `sb-nav-popover` open/close pattern at [`header.html`:139](../../../hugo/layouts/partials/header.html#L139). Reuse the `closeAllExcept(...)` helper.
6. Per-row close event → `localStorage.setItem('alerts.dismissed:' + id, '1')` → recompute `visible` → re-render → decrement `notifications-count`.
7. "Dismiss all" footer button iterates the currently visible ids.
8. CTA click — same-origin `/foo` → `window.location.href`; external → `window.open(..., '_blank', 'noopener,noreferrer')`.

**Severity → UI5 priority mapping:**

| `severity`    | `ui5-li-notification` `priority` |
|---------------|----------------------------------|
| `Error`       | `High`                           |
| `Warning`     | `Medium`                         |
| `Success`     | `Low`                            |
| `Information` | `None`                           |

A `data-severity` attribute is also set on each row to allow a small CSS hook to recolor the priority dot to the Fundamental Styles severity palette if Tom decides UI5's default colours need tuning later (out of scope for v1).

**Empty state:** when `visible.length === 0`, the popover still opens and renders a single `<ui5-illustrated-message name="NoNotifications">` "You're all caught up."

**Live refresh:** in-tab `setInterval` polls every 5 min while `document.visibilityState === 'visible'`. Paused on hidden tabs. No WebSocket — alerts are not real-time-critical, and 5 min staleness matches the 60 s server-side cache plus the author's mental model.

**QA channel:** `site.Params.qa === true` → island is skipped entirely (matches the existing QA gate for joule, cmd-palette, etc.).

**Preview channel:** `site.Params.previewMode === true` → island is skipped (authors previewing tutorials don't see prod alerts).

**Accessibility:**
- The bell's `accessible-name` is set by UI5 ShellBar default.
- `notifications-count` is announced by UI5.
- `<ui5-li-notification title-text="...">` provides the accessible name per row.
- Empty state is announced via the standard `<ui5-illustrated-message>` ARIA shape.

**Bundle-collision guard:** the postbuild collision check (`scripts/check-build-collisions.ts`) runs against the new `alerts.js` Vite output. The name `alerts` is not currently used by any Hugo `js.Build` output, so no rename is needed.

## Testing

### Unit (Vitest in-memory SQLite, `npm test`)

- `srv/lib/__tests__/alerts-endpoint.test.js`:
  - Active + date-window filter math (active=false drops; pre-start drops; post-end drops; null endsAt never drops on the end side).
  - Audience filter — public endpoint only returns `ALL`; `/api/alerts/me` returns `ALL` + `AUTHENTICATED`; ADMIN-only rows visible iff `req.user.is('Admin')`.
  - Cache TTL bust on save — after `INSERT`/`UPDATE`/`DELETE` on `AdminService.Alerts`, next GET reflects the change.
  - `Cache-Control` / `ETag` headers correct on both endpoints; 401 on anonymous `/api/alerts/me`.

- `srv/lib/__tests__/alert-cta-targets.test.js`:
  - READ handler returns the canonical list.
  - Idempotent on multiple READs.

- `hugo-apps/src/alerts/__tests__/dismiss-filter.test.ts` — given an alert list + dismissed-set, returns only visible.
- `hugo-apps/src/alerts/__tests__/severity-priority.test.ts` — mapping table.
- `hugo-apps/src/alerts/__tests__/endpoint-select.test.ts` — picks `/api/alerts/me` iff authenticated.

### Hybrid (real HANA, `npm run test:hybrid`)

Guarded by `ALLOW_HYBRID_WRITES=true` (per [`test/hybrid/_guard.js`](../../../test/hybrid/_guard.js)). Inserts a `__TEST__`-prefixed alert and cleans up in `afterAll`.

- `test/hybrid/alerts.test.js`:
  - Insert + read via the public endpoint → present.
  - Flip `audience=AUTHENTICATED` → public endpoint drops it.
  - Set `active=false` → both endpoints drop it.
  - Catches the case where SQLite + spec review miss real-HANA reserved words or column-name foot-guns (per memory `feedback_skip_hybrid_test_costs_two_pr_cycles`).

- `test/hybrid/alerts-rebuild-classifier.test.js`:
  - Saving an `Alerts` row does NOT enqueue a rebuild dispatch (`_classify-rebuild-mode.js` returns `null`).

### Smoke (HTTP against deployed, `npm run test:smoke`)

- `test/smoke/alerts.test.ts`:
  - `GET /api/alerts` → 200, valid JSON envelope, `Cache-Control: public, max-age=60`, no `Set-Cookie`.
  - `GET /api/alerts/me` unauthenticated → 401.
  - `OPTIONS` not exposed.

## Operations & Docs

- Add both endpoints to [`docs/developers/operations/testing-endpoints.md`](../../../docs/developers/operations/testing-endpoints.md) (auth + scope columns).
- New runbook `docs/authors/operations/scheduling-alerts.md` — when to use which severity, audience semantics, "active=false is the kill switch", dismissal semantics, that alerts never trigger a rebuild, and the up-to-60 s freshness expectation after admin save.
- Add to the Gotchas section of [`CLAUDE.md`](../../../CLAUDE.md):
  > **Alert saves do NOT trigger rebuilds** — runtime-served via `/api/alerts*`. Cache-bust on `AdminService.Alerts` save is the only freshness mechanism; up-to-60 s delay between admin save and visitor seeing the new state is expected.

## Rollout

Single PR.

1. Schema change → `cds build --production` to refresh `db/last-dev/csn.json` (per memory `feedback_cds_build_production_not_cds_compile_for_last_dev`).
2. HDI deploy creates the `Alerts` table (no data migration).
3. After deploy, an admin creates the first alert in `/admin-ui/#alerts-display`, sets `startsAt` 2 min out, `active=true`, watches the bell on a separate tab — notification appears within ~60 s.
4. Issue closes when the first real campaign (Devtoberfest, or next product launch) ships through this surface end-to-end.

## Risks

- **Cache-freshness mismatch** — admin saves but doesn't see change immediately. Mitigation: in-memory cache bust on save (within ~5 s) and a hint in the admin tile after save ("Live in up to 60 s").
- **Dark/light theme contrast** — `ui5-li-notification` ships theme-aware; ui5-overrides.css already loaded sitewide. No bespoke CSS expected.
- **Auth state read race** — the island reads `<html data-authenticated>` after `customElements.whenDefined('ui5-shellbar')`, but [`header.html`](../../../hugo/layouts/partials/header.html) `checkAuth()` is also async. If the island fetches before `checkAuth` completes, it could pick `/api/alerts` for an authenticated user (showing only ALL alerts, missing AUTHENTICATED/ADMIN). Mitigation: island awaits an `auth-resolved` `CustomEvent` dispatched by `header.html` after `checkAuth` completes (cheap addition to the existing flow); falls back to a 200 ms `setTimeout` if the event never fires (e.g. `/auth/user` 5xxed).
- **HANA reserved words** — verified `severity`, `audience`, `body`, `active`, `dismissible` are not reserved; `Events.active` already exists in production.
- **Bundle name collision** — `alerts.js` is not currently used by Hugo `js.Build`; postbuild collision check fails the build if that ever changes.

## Open Questions

None at design time — all five core questions answered during brainstorming. The `linkedEventId` association to `Events` is explicitly deferred to a later iteration.

## References

- Existing per-tutorial banners: [`hugo/layouts/partials/tutorial-banners.html`](../../../hugo/layouts/partials/tutorial-banners.html)
- Existing channel banner: [`hugo/layouts/partials/qa-banner.html`](../../../hugo/layouts/partials/qa-banner.html)
- ShellBar wiring (notification slot already present): [`hugo/layouts/partials/header.html`](../../../hugo/layouts/partials/header.html)
- Admin tile pattern reference: [`app/admin/featuredtasks/`](../../../app/admin/featuredtasks/), [`app/admin/advocates/`](../../../app/admin/advocates/)
- Cache pattern reference: [`srv/lib/secret-resolver.js`](../../../srv/lib/secret-resolver.js)
- Public-endpoint pattern reference: `/api/advocates` (see [`srv/server.js`](../../../srv/server.js))
- Change-tracking curation memory: [`feedback_changelog_curation_singletons_and_ai_tables`](../../../C:/Users/I809764/.claude/projects/d--projects-tutorials-poc/memory/feedback_changelog_curation_singletons_and_ai_tables.md)
- Hybrid-test discipline memory: [`feedback_skip_hybrid_test_costs_two_pr_cycles`](../../../C:/Users/I809764/.claude/projects/d--projects-tutorials-poc/memory/feedback_skip_hybrid_test_costs_two_pr_cycles.md)
