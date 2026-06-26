# Issue #617 — Broaden `Tutorial.Author` access to author-relevant admin tiles — Design

> Spec brainstormed 2026-06-26 with Tom. Closes the gap [#617](https://github.com/sap-tutorials/tutorials-ims/issues/617) opened: the admin shell at `/admin-ui/` is gated by the `Admin` scope across all 26 tiles, so authors holding only `Tutorial.Author` can't reach the tutorial inspection, feedback view, change log, tag browser, analytics, or the per-tutorial rebuild button shipped by the [2026-06-24 admin rebuild-button spec](2026-06-24-admin-tutorial-rebuild-button-design.md). v1 of this work ships a **read-mostly** author surface inside the existing admin shell: six tiles, one bound write action (`rebuildContent`), no per-row ownership filtering.

## Summary

Authors who hold the `Tutorial.Author` XSUAA scope can now load `/admin-ui/` and see a curated subset of tiles. The shell decides which tiles to render based on the caller's scopes (read via `/auth/user` at boot); the OData backend is the trust boundary, not the JS bundle.

The author tile set is:

1. **Tutorial Health** (read) — the existing dashboard at `/admin-ui/#/dashboard`.
2. **Tutorials** (read all tutorials, full-row OP, plus the `rebuildContent` bound action).
3. **Tags** (read the full tag taxonomy).
4. **Feedback** (read tutorial feedback across all tutorials).
5. **Changelog** (read `sap.changelog.Changes` rows scoped to `entity = 'AdminService.Tutorials'`).
6. **Analytics** (the existing Vue analytics-explorer SPA, role-aware: entity-browser tab works, SQL tab is hidden for authors).

The authorization posture is **scope-based, not row-based**: any holder of `Tutorial.Author` (granted via XSUAA role-collection assignment, not self-service) sees the whole tutorial catalog. We do not introduce per-row ownership filtering for v1 — that trades an unbounded backfill story (`Tutorials.author` FK isn't 100% populated, `TutorialMeta.ownerEmail` is the legacy parallel) for security theater inside a team of trusted SAP-employee authors. Symmetric with how `/tutorials-qa/*` already works: any `Tutorial.Author` can read any QA-channel tutorial.

## Context — why this exists

Today the admin UI at `/admin-ui/` is gated by the `Admin` XSUAA scope across all 26 tiles. Authors (holding `Tutorial.Author`) have:

- A read-only OData surface at `/author/` with `Tutorials` (5 columns: ID/slug/title/primaryTag/status), `Tags`, `MyTutorials`, `AnalyticsBranchPerformance`, `AnalyticsBranchTopPick`, plus four actions (`reviewTutorial`, `snoozeTutorial`, `generateOsVariants`, `isSlugAvailable`).
- The QA-channel preview at `/tutorials-qa/*` (gated by `Tutorial.Author`, sourced from `*-Contribution` repos via `tutorials-srv-qa`).
- The Tutorials VS Code authoring plugin (which talks to `/author/`).

What authors *don't* have today:

- A way to inspect a tutorial's full lifecycle metadata (status, publish flag, contributor list, completion stats, feedback aggregate).
- A way to see what readers said about their tutorials.
- A way to see what changed and when on a tutorial.
- A way to self-serve a rebuild after pushing markdown to GitHub when Hugo hasn't rebuilt.

Each of those forces a "file a ticket / ask an admin" round-trip. The [2026-06-24 admin rebuild button spec](2026-06-24-admin-tutorial-rebuild-button-design.md) explicitly deferred the author surface to this issue. This is that work.

## Settled decisions (from 2026-06-26 brainstorming with Tom)

1. **v1 ships rebuild + feedback view + changelog view + Tags read + Analytics.** All four areas the issue called out, plus Analytics (added in the brainstorm).
2. **Shared shell, scope-gated tiles.** No separate `app/author-shell/`. The `app/admin-shell/` bundle filters its `navigation.json` based on caller scopes. The bundle ships admin-only component code to authors — accepted as a non-secret given the SAP-employee threat model.
3. **Extend `AuthorService` with new projections** rather than relaxing `AdminService` with per-entity `@restrict`. CAP's `@requires` is service-scoped; the admin-service.cds comment at lines 64-68 explicitly calls out "a single service surface cannot cover both audiences." The codebase pattern is **two projections, one underlying view** — already used for `AnalyticsBranchPerformance`.
4. **No per-row ownership filtering.** Authors are trusted SAP employees granted `Tutorial.Author` through XSUAA role-collection assignment. The boundary is the scope. (Deferred to v2 if a use case emerges: a client-side "My tutorials" filter using the existing `MyTutorials` projection.)
5. **Any author can rebuild any tutorial.** Symmetric with read access. The 60-second `scheduleRebuild` debounce, slug-targeted classification, and per-dispatch audit event (`source: 'author-ui:rebuild-button:<user>'`) bound abuse risk.
6. **`/admin-ui/` route accepts either scope.** Drops the explicit `scope: '$XSAPPNAME.Admin'` from the approuter route. XSUAA still authenticates; the shell + OData backends enforce per-tile authorization. Same for `/analytics-ui/`.
7. **Conditional shell title: "Admin Console" / "Author Console".** Set once at boot from `/auth/user` scopes. Different `document.title` helps multi-tab disambiguation.
8. **Tags read-only, Feedback read-only.** No author write surface beyond `rebuildContent`. Tag label edits stay admin-only (cascade into tutorial cards / filter checkboxes — admins should own that). Feedback moderation is a separate future feature.
9. **Changelog filtered to Tutorials-only rows.** Hides Mission/Group/Event/Tag/Advocate change noise; hides admin operational signal (Prizes, ImsConfig, etc.).
10. **Analytics tile: role-aware Vue SPA.** The existing `analytics-explorer` SPA at `/analytics-ui/` becomes role-aware. Entity browser works for authors against a new `AuthorService.Analytics*` curated subset. SQL tab is hidden for authors with a banner ("Ad-hoc SQL queries are admin-only.").

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│  Approuter  /admin-ui/  and  /analytics-ui/                          │
│  xs-app.json route: accepts EITHER $XSAPPNAME.Admin                  │
│                      OR     $XSAPPNAME.Tutorial.Author               │
│  Serves the SAME static bundles for both scope classes.              │
└──────────────────────────────────────────────────────────────────────┘
                │
                │ HTTP GET /admin-ui/index.html → Component.js → /auth/user
                ▼
┌──────────────────────────────────────────────────────────────────────┐
│  admin-shell (app/admin-shell/webapp/)                               │
│                                                                      │
│  Boot:                                                               │
│    1. fetch /auth/user → { scopes: [...], userName, email }          │
│    2. derive userRole =                                              │
│       scopes.includes('Admin')          ? 'admin'                    │
│       scopes.includes('Tutorial.Author') ? 'author'                  │
│       else                                : 'anonymous'              │
│    3. Render NoAccess view if userRole === 'anonymous'.              │
│    4. Set window title to 'Admin Console' or 'Author Console'.       │
│    5. Filter navigation.json by requiredScope (keep if undefined or  │
│       userRole satisfies it; admins satisfy author tiles too).       │
│    6. Bind admin-tile components to /admin/.                         │
│       Bind author-visible tile components to /author/ when           │
│       userRole === 'author', /admin/ when userRole === 'admin'.      │
└──────────────────────────────────────────────────────────────────────┘
                │                                            │
        ┌───────┴────────┐                          ┌────────┴────────┐
        ▼                ▼                          ▼                 ▼
┌──────────────────┐ ┌──────────────────────────┐ ┌──────────────┐ ┌─────────────────────┐
│ AdminService     │ │ AuthorService (extended) │ │ analytics-   │ │ /auth/user           │
│ /admin/          │ │ /author/                 │ │ explorer Vue │ │ srv/server.js        │
│ @requires Admin  │ │ @requires Tutorial.Author│ │ /analytics-  │ │ returns scopes,      │
│                  │ │                          │ │  ui/         │ │ userName, email     │
│ (unchanged)      │ │ existing surface +       │ │              │ │                      │
│                  │ │   Tutorials (full row)   │ │ role-aware:  │ │                      │
│                  │ │   TutorialFeedback       │ │ admin → /    │ │                      │
│                  │ │   TutorialFeedbackAgg.   │ │   admin/     │ │                      │
│                  │ │   TutorialChanges        │ │   analytics/ │ │                      │
│                  │ │   Analytics* subset      │ │ author → /   │ │                      │
│                  │ │   rebuildContent action  │ │   author/    │ │                      │
└──────────────────┘ └──────────────────────────┘ └──────────────┘ └─────────────────────┘
                │                  │
                └────────┬─────────┘
                         ▼
            ┌─────────────────────────────────┐
            │  HANA (single backing store)    │
            │  ims.Tutorials, ims.Tags,       │
            │  ims.TutorialFeedback,          │
            │  sap.changelog.Changes,         │
            │  ims.CompletionAnalytics, …     │
            └─────────────────────────────────┘
```

**Two key principles:**

- **One bundle, two roles.** The `app/admin-shell/` bundle stays single. The shell decides which tiles to render. The OData backend is the trust boundary, not the JS bundle.
- **Two services, one schema.** `AuthorService` re-projects the entities authors need on top of the same `db/schema.cds` + `db/views.cds` tables. CAP's `@requires` is service-scoped, so this is the canonical pattern (already in use for `AnalyticsBranchPerformance`).

## OData surface additions

### `srv/author-service.cds` — new and changed projections

| Change | Surface | Notes |
|---|---|---|
| Widen | `entity Tutorials as projection on ims.Tutorials` (full row, read-only) | Replaces the current 5-column slim projection. Wildcard `*` to bring in all columns the admin Tutorials OP consumes. Backward compatible with existing consumers (lint rule, VS Code plugin — both slug-driven). Inverse associations to validation/code-check/AI-author entities are NOT re-exposed in v1 (those would force five more @readonly projections for the OP facets; defer to a follow-up if author Tutorials OP starts demanding them). |
| New | `@readonly entity TutorialFeedback as projection on ims.TutorialFeedback` | Identical shape to `AdminService.TutorialFeedback`. |
| New | `@readonly entity TutorialFeedbackAggregate as projection on ims.TutorialFeedbackAggregate` | Drives the Feedback tile and a future feedback header cell on the Tutorials OP. |
| New | `@readonly entity TutorialChanges` — projection on `sap.changelog.Changes` filtered to `entity = 'AdminService.Tutorials'` | Authors see only Tutorials-row change-tracking entries. The literal `'AdminService.Tutorials'` filter is hardcoded with a comment because the change-tracking plugin records the source service projection name. If `AdminService.Tutorials` is ever renamed, this filter breaks — admin renames are rare and grep-discoverable. |
| New | `@readonly entity Tasks as projection on ims.Tasks` | Curated Analytics surface (matches `AnalyticsService.Tasks`). |
| New | `@readonly entity CompletionAnalytics as projection on ims.CompletionAnalytics` | Curated Analytics surface. |
| New | `@readonly entity ActiveLearnersDaily as projection on ims.ActiveLearnersDaily` | Curated Analytics surface. |
| New | `@readonly entity TaskRecords as projection on ims.TaskRecords` | Curated Analytics surface; admin-equivalent. |
| New | `@readonly entity CodeCheckSubmissions as projection on ims.CodeCheckSubmissions { ID, tutorialSlug, stepNumber, language, verdict, modelName, promptTokens, completionTokens, latencyMs, errorReason, createdAt, modifiedAt, user }` | Same column subset as admin (excludes question/answer text; PII risk). |
| New | `@readonly entity ValidateAnswerSubmissions as projection on ims.ValidateAnswerSubmissions { ID, tutorialSlug, stepNumber, questionId, verdict, modelName, promptVersion, promptTokens, completionTokens, latencyMs, errorReason, createdAt, modifiedAt, user }` | Same column subset as admin. |
| New | `@readonly entity UIEvents as projection on ims.UIEvent` | Curated Analytics surface. |
| Existing | `@readonly entity AnalyticsBranchPerformance` | Already on AuthorService. |
| Existing | `@readonly entity AnalyticsBranchTopPick` | Already on AuthorService. |
| New | `function listExposedEntities() returns array of { name; sqlName; label }` | Mirrors `AnalyticsService.listExposedEntities` but returns only the curated author subset. Drives the `analytics-explorer` entity-browser dropdown. |
| New (action) | `extend entity AuthorService.Tutorials with actions { @Core.OperationAvailable: true @Common.IsActionCritical: true action rebuildContent() returns AdminService.RebuildContentResult; }` | Symmetric with the admin button. Reuses `srv/lib/rebuild-trigger.js` `scheduleRebuild()`. Audit event: `auditEvent('TutorialRebuildTriggered', { user, tutorialId, slug, source: 'author-ui:rebuild-button' })`. **Type-sharing decision (settled):** reuse `AdminService.RebuildContentResult` rather than re-declaring on AuthorService — CDS supports cross-service type references, the type is dispatch-result-only (no security surface), and any future shape change stays in one place. |

### What is NOT added

- `runSelectQuery` stays admin-only on `AnalyticsService`. Authors get the entity-browser tab; the SQL playground is admin-only.
- Tags writes — `AuthorService.Tags` remains `@readonly` (already is).
- Feedback writes (no markAddressed, no moderation, no reply) — v1 is read-only.
- Tutorials writes — the new full-row projection is `@readonly`.
- No new XSUAA scope. We reuse the existing `Tutorial.Author` scope.

### Handler implementation pointer

The new `rebuildContent` handler lives in `srv/author-service.js`. It does what the admin handler in `srv/admin-service.js` does (resolve `req.params[0].ID` → slug, audit, call `scheduleRebuild`), with a different `source` string. Shared logic can be lifted into `srv/lib/rebuild-trigger.js` (or a new sibling) if duplication is uncomfortable; the plan-writing phase decides.

## UI shell wiring

### `app/admin-shell/webapp/model/navigation.json`

Add a `requiredScope` field per entry. Add `dataServicePath` / `authorPath` per entry so the shell knows which OData URL to bind for the author role.

Example transformation:

```jsonc
{
  "key": "tutorials",
  "title": "Tutorials",
  "icon": "sap-icon://education",
  "requiredScope": "Tutorial.Author",   // visible to author + admin
  "adminPath": "/admin/",
  "authorPath": "/author/"
},
{
  "key": "secrets",
  "title": "Secrets",
  "icon": "sap-icon://locked"
  // NO requiredScope → admin-only by default
}
```

The full filtered tile list for authors:

| Tile key | Group | Surface URL when role=author | Surface URL when role=admin |
|---|---|---|---|
| `dashboard` (Tutorial Health) | Content | `/author/` (read-only stats; the dashboard is mostly aggregated counts, already read-only on admin) | `/admin/` |
| `tutorials` | Content | `/author/` | `/admin/` |
| `tags` | Content | `/author/` | `/admin/` |
| `feedback` | Content | `/author/` | `/admin/` |
| `changelog` | Content | `/author/` (TutorialChanges projection) | `/admin/` |
| `analyticsExternal` (opens `/analytics-ui/`) | Reporting | `/author/` (role-aware Vue SPA) | `/admin/analytics/` |

Admin-only tiles (no `requiredScope` set): Events, Missions, Groups, Accomplishments, Prizes, Operations, Pipeline Log, Job Log, Joule Settings, Account Merges, Privacy, Categories, Concepts, Advocates, Alerts, Secrets, UI Events Settings, Search Settings, Navigator Settings, Display Settings, Tenant Settings, Knowledge Graph, Devtoberfest, Completion analytics, Statistics, Data Export, Board.

Authors see **6 tiles in 2 groups** (Content: Tutorial Health, Tutorials, Tags, Feedback, Changelog; Reporting: Analytics).

### `app/admin-shell/webapp/controller/Shell.controller.js`

New boot sequence (replacing the current onInit logic):

```javascript
onInit: async function () {
  const auth = await this._loadAuthUser();   // fetch('/auth/user')
  const scopes = new Set(auth?.scopes || []);
  const userRole = scopes.has('Admin')
    ? 'admin'
    : scopes.has('Tutorial.Author')
      ? 'author'
      : 'anonymous';

  this.getView().getModel('userContext').setProperty('/', {
    role: userRole,
    userName: auth?.userName,
    email: auth?.email,
    consoleTitle: this.getResourceBundle().getText(`consoleTitle.${userRole}`)
  });

  if (userRole === 'anonymous') {
    this.getRouter().navTo('noAccess', {}, true);
    return;
  }

  this._filterNavigation(userRole);
  document.title = this.getResourceBundle().getText(`documentTitle.${userRole}`);
}
```

`_filterNavigation(userRole)` walks `navigation.json` and removes entries where `requiredScope` is set and `userRole === 'author'` doesn't satisfy it. (`userRole === 'admin'` is a superset — admin sees all tiles.) Predicate, in one line:

```javascript
// Keep tile if: no scope requirement, OR caller is admin (sees everything),
// OR caller is author AND tile's requiredScope is 'Tutorial.Author'.
const keep = !entry.requiredScope
          || userRole === 'admin'
          || (userRole === 'author' && entry.requiredScope === 'Tutorial.Author');
```

When binding component data sources (existing `_wireAdminContextToHtml` pattern), the shell looks at the tile's `adminPath` / `authorPath` and binds the right URL.

### `app/admin-shell/webapp/Component.js` and `manifest.json`

Add a second OData data-source `authorService` pointing at `/author/`:

```jsonc
"dataSources": {
  "adminService": { "uri": "/admin/", "type": "OData", "settings": { "odataVersion": "4.0" } },
  "authorService": { "uri": "/author/", "type": "OData", "settings": { "odataVersion": "4.0" } }
}
```

Add a corresponding `author` model in `sap.ui5.models` that the author-visible components bind to instead of `admin` when `userRole === 'author'`.

### `app/admin-shell/webapp/view/NoAccess.view.xml` (NEW)

Single Fiori-shell page showing:

- Heading: "You don't have access to the Admin Console."
- Body: "This console requires the `Admin` or `Tutorial.Author` scope. If you're a tutorial author, please request access via SAP Cloud Identity."
- A `Request access` button linking to a configurable URL (env var or static placeholder for v1).

### `app/admin-shell/webapp/i18n/i18n.properties`

```properties
consoleTitle.admin=Admin Console
consoleTitle.author=Author Console
consoleTitle.anonymous=No access
documentTitle.admin=Admin Console
documentTitle.author=Author Console
documentTitle.anonymous=No access — Tutorials Platform
noAccess.heading=You don't have access to this console.
noAccess.body=This console requires the Admin or Tutorial.Author scope.
noAccess.requestAccess=Request access
```

### `app/analytics-explorer/` (Vue SPA)

Role-aware changes:

- New boot fetch to `/auth/user` (parallel to the existing data load).
- Computed `userRole` derived from scopes.
- Entity-browser tab:
  - `userRole === 'admin'`: data source is `/admin/analytics/`; entity list comes from `listExposedEntities()` on `AnalyticsService`.
  - `userRole === 'author'`: data source is `/author/`; entity list comes from `AuthorService.listExposedEntities()`.
- SQL tab: hidden when `userRole === 'author'`. A small `<sap-ui5-banner>` (or equivalent message strip) at the top reads: **"Ad-hoc SQL queries are admin-only. Contact an admin to run a SELECT against curated analytics tables."**
- 403 / NoAccess: when `userRole === 'anonymous'`, redirect to `/admin-ui/#/noAccess` (single-source-of-truth for the message).

### `approuter/xs-app.json`

Two route changes:

```diff
 {
   "source": "^/admin-ui/(.*)$",
   "target": "/admin-ui/$1",
   "localDir": "static",
-  "authenticationType": "xsuaa",
-  "scope": "$XSAPPNAME.Admin"
+  "authenticationType": "xsuaa"
+  // Tile-level authorization is enforced by AdminService (@requires Admin)
+  // and AuthorService (@requires Tutorial.Author). The bundle itself is
+  // accepted by any authenticated user; the shell renders NoAccess
+  // when the caller holds neither scope.
 },
 {
   "source": "^/analytics-ui/(.*)$",
   "target": "/analytics-ui/$1",
   "localDir": "static",
-  "authenticationType": "xsuaa",
-  "scope": "$XSAPPNAME.Admin"
+  "authenticationType": "xsuaa"
+  // Bundle is role-aware; OData backends enforce per-tile authorization.
 }
```

Implications:

- **Bundle disclosure.** The `admin-shell` bundle ships admin-only component code (Secrets, Joule Settings, etc.) to any authenticated user with `Tutorial.Author`. Network requests reveal tile *existence* via `componentUsages` paths even when data calls 401. Accepted as a non-secret given the SAP-employee threat model.
- **Anonymous users (no qualifying scope).** Still pass `authenticationType: 'xsuaa'`, so they hit the IDP. After login, if they hold neither scope, the shell renders the NoAccess view. This is materially worse UX than today (today they 403 at the approuter); we accept it because the only way to discover the scope-narrowing today is to read the cockpit role-collection definitions. The NoAccess view tells them what scope they need.

## Test plan

Three layers, matching the project's `unit / hybrid / smoke` Vitest workspaces.

### Unit (`test/unit/`, in-memory SQLite, fast)

- `author-service-tutorials.test.js` — `AuthorService.Tutorials` returns full row for a `Tutorial.Author` principal; returns 401 for anonymous; verifies the projection wildcard exposes all admin-side columns.
- `author-service-feedback.test.js` — `TutorialFeedback` + `TutorialFeedbackAggregate` projections read for any `Tutorial.Author`; POST/PATCH/DELETE return 405 (read-only enforcement).
- `author-service-changelog.test.js` — `AuthorService.TutorialChanges` projection returns only rows where `entity = 'AdminService.Tutorials'`; rows for Missions/Groups/Tags/etc. are filtered out at the query level. Test seeds both kinds of rows; asserts only Tutorials rows surface.
- `author-service-rebuild.test.js` — `AuthorService.Tutorials.rebuildContent` calls `scheduleRebuild` with `mode: 'slug-targeted'` and `source: 'author-ui:rebuild-button:<user>'`; audit event emits `TutorialRebuildTriggered` with the right shape. Mock `scheduleRebuild`; verify call args, don't actually dispatch.
- `author-service-analytics.test.js` — curated analytics projections (CompletionAnalytics, CodeCheckSubmissions, etc.) are read-only and returnable under `Tutorial.Author`. `runSelectQuery` is NOT exposed on AuthorService (verified by attempting the action and asserting `not-defined` / 404).
- `admin-shell-navigation-filter.test.js` (UI5 unit) — `Shell.controller.js` filters `navigation.json` correctly given each of the three `userRole` values; verifies `consoleTitle` resolves to the right i18n key.

### Hybrid (`test/hybrid/`, real HANA via `cds bind --exec`, requires `cf login`)

- `617-author-service-tutorials.test.js` — bind a real `Tutorial.Author` JWT, hit `/author/Tutorials?$top=5`, assert full-row shape + status code + admin-only columns surface correctly.
- `617-author-rebuild-action.test.js` — invoke `rebuildContent` against a real seeded tutorial slug; assert the dispatched workflow URL has `mode=slug-targeted&slug=<slug>` shape. Gated by an env var (e.g. `HYBRID_DISPATCH_TESTS=true`) so it doesn't fire a real GitHub `workflow_dispatch` on every CI run. Following the `HYBRID_AI_TESTS=true` precedent.
- `617-author-changelog-filter.test.js` — seed two `sap.changelog.Changes` rows (one for `AdminService.Tutorials`, one for `AdminService.Missions`); assert the author projection returns only the Tutorials row.
- `617-analytics-author-surface.test.js` — assert `/author/CompletionAnalytics?$top=5` returns rows under a `Tutorial.Author` token AND `/author/runSelectQuery(sql='SELECT 1')` returns `not-defined`.

### Smoke (`test/smoke/`, HTTP against deployed)

- `author-scope-routes.smoke.test.js` (NEW) — with a `Tutorial.Author`-only token:
  - GET `/admin-ui/index.html` → 200
  - GET `/admin/Tutorials?$top=1` → 403
  - GET `/author/Tutorials?$top=1` → 200
  - GET `/admin/Missions?$top=1` → 403
  - GET `/analytics-ui/` → 200
  - GET `/author/CompletionAnalytics?$top=1` → 200
  - GET `/auth/user` → returns `scopes` array containing `Tutorial.Author`.
- `admin-scope-routes.smoke.test.js` (UPDATE existing) — confirm admin route surface is unchanged (no regression).

### Manual verification checklist (added to PR description)

1. Smoke-test as admin: load `/admin-ui/`, see all 26 tiles, header reads "Admin Console", `document.title` reads "Admin Console".
2. Smoke-test as author: load `/admin-ui/`, see 6 tiles in 2 nav groups (Content × 5, Reporting × 1), header reads "Author Console", `document.title` reads "Author Console".
3. Author clicks Tutorials → sees full list → opens any tutorial → sees full OP (read-only) → presses **Rebuild this tutorial** → confirm dialog → toast confirms dispatch → GitHub Actions run shows up with `source: 'author-ui:rebuild-button:<user>'` in the workflow_dispatch payload.
4. Author opens `/analytics-ui/` → entity-browser tab loads against `/author/`; SQL tab is hidden; banner reads "Ad-hoc SQL queries are admin-only."
5. Unauthorized user (neither scope, e.g. a bare-Everyone XSUAA principal) loads `/admin-ui/` → after IDP login, shell renders NoAccess view with the "Request access" link.

## Risks & non-goals

### Risks

- **Bundle disclosure.** Authors can see admin-only tile *existence* via the `admin-shell` bundle's network requests (`componentUsages` paths). The data is gated by OData `@requires`, so reading values requires the right scope, but the *presence* of the tile leaks. Acceptable for SAP-employee authors; called out explicitly so we don't pretend the bundle is a security boundary.
- **`/auth/user` shape compatibility.** The boot sequence assumes `/auth/user` returns `{ scopes: [...], userName, email }`. The plan-writing phase verifies the actual response shape against `srv/server.js` and adjusts the parsing if needed (e.g. if scopes come back as `$XSAPPNAME.Tutorial.Author` rather than bare `Tutorial.Author`).
- **AdminChanges projection portability.** The `TutorialChanges` filter (`entity = 'AdminService.Tutorials'`) hardcodes the admin projection name. If we ever rename `AdminService.Tutorials` (unlikely; would also break the existing admin Tutorials tile, so we'd notice immediately), the author Changelog goes blank. Mitigation: comment with grep-discoverable name in `srv/author-service.cds`.
- **Curated analytics duplication.** Eight `@readonly entity X as projection on ims.X` projections are duplicated between `AnalyticsService` and `AuthorService`. CAP's service-scoped `@requires` makes this unavoidable (already in use for `AnalyticsBranchPerformance`). If a column changes on a backing view, both projections might need updates — mitigated by the wildcard `*` in most cases, but column-subsetted ones (`CodeCheckSubmissions`, `ValidateAnswerSubmissions`) need to stay in sync. Mitigation: cross-reference comment in both .cds files.
- **NoAccess UX regression.** Today an unauthorized user 403s at the approuter route. After v1, they pass through IDP login, then hit the shell's NoAccess view. The extra hop is slower; the gain is a self-service explanation ("you need Tutorial.Author scope; here's how to request it") that today's 403 doesn't provide.

### Non-goals (v1)

- **Per-row ownership filtering.** Any `Tutorial.Author` sees every tutorial. Deferred to v2 if a use case emerges.
- **"My tutorials" filter UX.** No client-side toggle. The existing `AuthorService.MyTutorials` projection (which filters by `TutorialMeta.ownerEmail` → caller's `Users.email`) is unchanged but not surfaced as a separate tile.
- **Author write actions beyond rebuild.** No Tag label edits, no Feedback moderation, no Tutorials edits, no Categories. Strictly read + rebuild.
- **Separate `author-shell` bundle.** Rejected. One shell, scope-gated tiles.
- **New XSUAA scope.** Reuses the existing `Tutorial.Author` scope. xs-security.json is not modified.
- **New branding assets.** Same SAP Horizon theme; only the title string changes.
- **Author-visible inverse associations on Tutorials OP.** The admin Tutorials OP has facets for `validationSpecs`, `codeCheckSpecs`, `aiRequests`, `completionStats`. Re-exposing those on the author-side Tutorials projection requires five more `@readonly` projections plus association rewiring. v1 ships without them; the author Tutorials OP shows the row + feedback aggregate, nothing else.

## Future work

- Author-facing inverse-association facets on the Tutorials OP (validation, code-check, AI authoring, completion stats).
- A `My tutorials` toggle in the Tutorials ListReport using the existing `MyTutorials` projection.
- Limited author write surface (Tag label edits, Feedback mark-addressed) once Tom + the author cohort agree on the right boundary.
- An `Author Console` initial-route landing page (a curated dashboard showing the author's recent rebuilds, their pending review notifications, their feedback inbox) replacing the shared `Tutorial Health` initial route.
- Author Tags write surface (label-only) gated by an additional scope class if Tom wants to delegate taxonomy curation.

## Implementation pointers (not the plan — that comes next)

**First plan step (gate everything else):** verify the `/auth/user` response shape in `srv/server.js`. The boot pseudocode in §"UI shell wiring" assumes `{ scopes: [...], userName, email }` with scopes as bare strings (`'Tutorial.Author'`, not `'$XSAPPNAME.Tutorial.Author'`). If the actual shape differs, the role-derivation logic adjusts before any downstream task starts. This is the cheapest lock-in: one Read, then commit.

**Natural plan-split (advisory for plan-writer):** the work decomposes cleanly into two PRs if the plan-writer wants to keep PRs small:
- **PR A — Core 5 tiles** (Tutorial Health, Tutorials, Tags, Feedback, Changelog) + approuter relax on `/admin-ui/` only + shell role detection + NoAccess view + `rebuildContent` action.
- **PR B — Analytics tile** (8 new projections on AuthorService, `listExposedEntities`, analytics-explorer role-awareness, `/analytics-ui/` approuter relax).

PR A is the larger half (shell + new service surfaces + write action). PR B is contained (one file + Vue SPA changes). Either ships independently; a single PR also works.

**Files touched:**

- `srv/author-service.cds` — six new projections, one new function, one bound action, one `extend service` block for the type reference.
- `srv/author-service.js` — `rebuildContent` handler (mirror of `AdminService.rebuildContent`); `TutorialChanges` filter wiring if the projection needs a `before READ` for SQLite/HANA portability.
- `app/admin-shell/webapp/Component.js` — second `authorService` data-source.
- `app/admin-shell/webapp/controller/Shell.controller.js` — boot sequence rewrite (auth/user → role → filter nav).
- `app/admin-shell/webapp/model/navigation.json` — `requiredScope` + `adminPath` + `authorPath` per entry.
- `app/admin-shell/webapp/view/NoAccess.view.xml` — NEW.
- `app/admin-shell/webapp/i18n/i18n.properties` — title + NoAccess strings.
- `app/analytics-explorer/` — role-aware boot; SQL tab v-if; entity-browser URL routing.
- `approuter/xs-app.json` — drop scope on `/admin-ui/` and `/analytics-ui/` routes.
- `test/unit/` + `test/hybrid/` + `test/smoke/` — per Section "Test plan".

## Related work

- [2026-06-24 admin tutorial rebuild button design](2026-06-24-admin-tutorial-rebuild-button-design.md) — the v1 ship of `rebuildContent` on `AdminService.Tutorials` and its dispatch / debounce / audit-log plumbing.
- [2026-06-24 tutorials admin tile expansion design](2026-06-24-tutorials-admin-tile-expansion-design.md) — recent expansion of the admin Tutorials OP with validation/code-check/AI-author facets.
- [2026-06-24 tutorial authorship FK design](2026-06-24-tutorial-authorship-fk-design.md) — the `Tutorials.author` FK whose existence influenced (but doesn't drive) the per-row ownership decision in §"Settled decisions".
- [2026-06-21 issue 385 PR-3 AuthorService design](2026-06-21-issue-385-pr3-authorservice-design.md) — the most recent AuthorService extension, which set the read-only-projection-on-ims-view pattern this design reuses.
- [2026-05-23 admin analytics explorer design](2026-05-23-admin-analytics-explorer-design.md) — the existing `analytics-explorer` Vue SPA architecture this design extends with role-awareness.
