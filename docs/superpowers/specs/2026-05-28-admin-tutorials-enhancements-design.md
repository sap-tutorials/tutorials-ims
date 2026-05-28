# Admin UI Tutorials — Enhancements (Issue #95)

**Status:** approved (Tom, 2026-05-28)
**Issue:** [sap-tutorials/tutorials-ims#95](https://github.com/sap-tutorials/tutorials-ims/issues/95)

## Problem

Admins working in the Tutorials Fiori Elements app at `/admin-ui/#/tutorials/` cannot:

1. See feedback for a tutorial without leaving for the standalone Feedback app.
2. Ask Joule for tutorial-specific improvement ideas without retyping the slug/title.
3. Filter or view the Owner field — owner data lives in `TutorialMeta` and is only visible from the Tutorial Health dashboard.

Issue #95 asks for all three on the Tutorial admin object page.

## Goals

- Add a Feedback section (aggregate KPIs + recent submissions) on the Tutorial object page.
- Add a header action **"Ask Joule for tutorial improvement suggestions"** that auto-sends a seeded prompt referencing this tutorial.
- Add Owner (read-only) to the Tutorials list filter bar (with value help), list column, and object-page detail.

## Non-goals

- Promoting `owner` / `ownerEmail` from `TutorialMeta` onto the `Tutorials` entity itself. (Out of scope; would require a HANA migration.)
- Editing owner from the Tutorial object page. Owner stays editable only on the existing Tutorial Health dashboard (`TutorialDashboard.view.xml`), which writes to `TutorialMeta`.
- New Joule starter chips, persona changes, or tool changes. Joule's behavior on the seeded prompt is whatever the existing admin persona + tools produce.
- Per-row "Ask Joule" buttons on the list report. Confined to the object page header.

## Architecture

Three additive changes layered on the existing Fiori Elements app:

```
app/admin/tutorials/  (Fiori Elements; manifest + one ext controller)
       │
       ▼ AdminService projections (srv/admin-service.cds)
   Tutorials  ──assoc──►  TutorialMeta             (existing entity, 1:1 in practice)
                    └──►  meta.owner               (read-only, value-help)
   Tutorials  ──assoc──►  TutorialFeedbackAggregate (existing view, slug = slug)
   Tutorials  ──assoc──►  TutorialFeedback          (existing entity, slug = slug)
   TutorialOwnerPickList  (NEW: SELECT DISTINCT owner FROM TutorialMeta)

approuter/static/js/joule.js
   window.joule.openWithMessage({ text })  ── extends global API
```

No schema changes. No migration. All three asks land via:

- `srv/admin-service.cds` — three new associations + one read-only projection.
- `app/admin-annotations.cds` — UI annotations.
- `approuter/static/js/joule.js` — one new exported function.
- `app/admin/tutorials/webapp/ext/AskJoule.controller.js` — new file (~25 LOC).
- `app/admin/tutorials/webapp/manifest.json` — register the controller extension.

## Components

### 1. Owner field on the Tutorials list and object page

**Backend — `srv/admin-service.cds`:**

Add to the existing `Tutorials` projection:

```cds
entity Tutorials as projection on ims.Tutorials {
  *,
  cast(legacyId as String) as legacyIdStr : String,
  meta : Association to TutorialMeta on meta.tutorial.ID = ID
};
```

Add a new read-only projection:

```cds
@readonly
@cds.redirection.target: false
entity TutorialOwnerPickList as
  select distinct owner from ims.TutorialMeta where owner is not null;
```

Single-column entity, key = `owner`. The `DISTINCT` is supported on both HANA and SQLite. The projection is unauthenticated against `ims.TutorialMeta` (already in AdminService scope).

**Annotations — `app/admin-annotations.cds`:**

Add `meta.owner` to:

- `UI.SelectionFields` — appears in the filter bar.
- `UI.LineItem` — new column "Owner", inserted after `slug`.
- `UI.FieldGroup#General` — read-only field on the object page.

Hang `@Common.ValueList` on `meta.owner` pointing at `TutorialOwnerPickList` with a single `ValueListParameterInOut` on `owner`.

Apply `@Common.FieldControl: #ReadOnly` so the object page renders Owner as text and the dashboard remains the only edit path.

**1:1 contract caveat:** Schema defines `meta` as `Composition of many TutorialMeta` (`db/schema.cds:34`). In practice `tutorial-meta-init.js` writes exactly one row per tutorial, so the reverse `Association to TutorialMeta` is safe. If duplicates ever exist, Fiori Elements binds the first row — acceptable per Tom (no guard required).

### 2. Feedback section on the Tutorial object page

**Backend — `srv/admin-service.cds`:**

Add two more associations to the `Tutorials` projection:

```cds
feedbackSummary : Association to TutorialFeedbackAggregate
                    on feedbackSummary.tutorialSlug = slug,
feedbackItems   : Association to many TutorialFeedback
                    on feedbackItems.tutorialSlug   = slug
```

Both target entities already exist as `@readonly` projections in `AdminService`. No new physical view needed; `TutorialFeedbackAggregate` is already defined in `db/views.cds:159`.

**Annotations — `app/admin-annotations.cds`:**

Add a new `UI.ReferenceFacet` "Feedback" to `Tutorials`, holding two sub-facets:

```cds
{ $Type: 'UI.ReferenceFacet', ID: 'FeedbackSummary',
  Target: 'feedbackSummary/@UI.FieldGroup#FeedbackSummary',
  Label:  'Summary' },
{ $Type: 'UI.ReferenceFacet', ID: 'FeedbackItems',
  Target: 'feedbackItems/@UI.LineItem#TutorialFeedback',
  Label:  'Recent Submissions' }
```

`FieldGroup#FeedbackSummary` on `TutorialFeedbackAggregate` reads:
`responseCount`, `avgNps`, `promoters`, `detractors`, `avgUseCase`, `avgRelevance`, `avgDuration`, `avgStructure`, `avgInteresting`, `avgVisuals`.

`LineItem#TutorialFeedback` is added as a sibling annotation set on `TutorialFeedback` (the existing default `LineItem` is reused for the standalone Feedback admin app and stays unchanged). Columns: `submittedAt`, `npsScore`, `wasAuthenticated`, `comment`, plus the six rating columns.

If a tutorial has zero feedback rows, `feedbackSummary` is null and FE renders blank fields — acceptable per the design discussion.

### 3. "Ask Joule for improvement suggestions" header action

**Joule API extension — `approuter/static/js/joule.js`:**

Add `openWithMessage` next to the existing `openWithStepContext`, mirroring the same deferred-pending pattern:

```js
openWithMessage({ text } = {}) {
  const opts = { autoSendText: typeof text === 'string' ? text : '' };
  if (!this._ready) { this._pendingOpen = opts; return; }
  _openImpl(opts);
},
```

Inside `_openImpl(opts)`, after `panel.hidden = false` and the auth check, if `opts.autoSendText` is a non-empty string, call `send(opts.autoSendText)` (the existing exported sender) instead of rendering starters. Total addition: ~10 lines.

**Controller extension — `app/admin/tutorials/webapp/ext/AskJoule.controller.js`:**

```js
sap.ui.define([], () => ({
  onAskJoule(oEvent) {
    const ctx = this.getView().getBindingContext();
    if (!ctx) return;
    const title = ctx.getProperty('title') || '';
    const slug  = ctx.getProperty('slug')  || '';
    const text  = `Please suggest improvements for the tutorial "${title}" (slug: ${slug}). ` +
                  `Consider feedback comments, NPS score, step structure, and clarity.`;
    const w = window.parent || window;
    if (w.joule && typeof w.joule.openWithMessage === 'function') {
      w.joule.openWithMessage({ text });
    }
  }
}));
```

`window.parent` — admin sub-apps load via `componentUsages` in the shell at `app/admin-shell/webapp/index.html`, which owns `window.joule`. There's no iframe between them, so `window.parent === window`; the fallback `|| window` keeps it correct in either case.

**Manifest wiring — `app/admin/tutorials/webapp/manifest.json`:**

Under `sap.ui5.extends.extensions`, register an object-page header action whose press handler calls `AskJoule.controller.js#onAskJoule`. Title: "Ask Joule for tutorial improvement suggestions"; icon: `sap-icon://discussion`.

## Data flow

```
[Owner filter]
  user types/selects Owner
    └── FE issues OData $filter=meta/owner eq 'Acme'
         └── AdminService projects Tutorials with meta association
              └── HANA join Tutorials ⇄ TutorialMeta on tutorial_ID = ID

[Owner value help]
  user opens dropdown
    └── FE GET /admin/TutorialOwnerPickList?$select=owner
         └── AdminService runs SELECT DISTINCT owner FROM TutorialMeta WHERE owner IS NOT NULL

[Feedback section]
  user expands Feedback facet on tutorial X
    └── FE GET /admin/Tutorials(<id>)?$expand=feedbackSummary,feedbackItems($top=N)
         └── feedbackSummary → TutorialFeedbackAggregate row for X.slug
         └── feedbackItems   → TutorialFeedback rows where tutorialSlug = X.slug

[Ask Joule]
  user clicks header action
    └── AskJoule.onAskJoule reads {title, slug} from binding context
         └── window.parent.joule.openWithMessage({ text: "Please suggest improvements ..." })
              └── joule.js opens panel, awaits auth, calls send(text)
                   └── existing /chat/stream pipeline
```

## Error handling

- **`feedbackSummary` is null** (no feedback yet): FE renders blank summary fields. No empty-state needed for v1.
- **`meta` is null** (TutorialMeta row missing): Tutorial-meta-init runs at content publish time; in the rare case a row hasn't been created, owner column is empty — non-fatal.
- **`window.joule` missing or pre-2026-05-28 build**: Optional-chain `openWithMessage`; button silently no-ops. Admin shell always loads `joule.js`, so this is defensive only.
- **Auth lapsed**: `_openImpl` already redirects to `/login` with a `joule=open` returnTo. The autoSendText is lost across the redirect — acceptable for v1; user clicks the button again post-login.

## Testing

**Unit (vitest, in-memory SQLite — `test/admin-service.test.js`):**
- `GET /admin/Tutorials?$expand=meta&$top=1` returns a row with `meta.owner` populated when a TutorialMeta row exists.
- `GET /admin/TutorialOwnerPickList` returns a unique list when seeded with duplicate owners on TutorialMeta.
- `GET /admin/Tutorials(<id>)?$expand=feedbackSummary` returns aggregate KPIs after seeding `TutorialFeedback` rows.
- `GET /admin/Tutorials(<id>)?$expand=feedbackItems` returns only rows where `tutorialSlug` matches.

**Hybrid (`test/hybrid/admin-tutorials.test.js`):**
- Smoke that `TutorialOwnerPickList` compiles and returns rows on HANA.
- Smoke that `$expand=feedbackSummary` works on HANA (the cast/aggregation chain in the view).

**Manual:**
1. `npm run dev:hybrid`, browse to `/admin-ui/#/tutorials/`.
2. Filter bar: Owner field present; clicking value-help opens dropdown of distinct owners.
3. List column: Owner shows.
4. Open a tutorial; General facet shows Owner read-only; Feedback facet shows summary + recent submissions.
5. Click "Ask Joule for tutorial improvement suggestions" — Joule opens, user message pre-sent, response streams.

**Skipped on purpose:** smoke tests against deployed DEV. The change is HTML-only on the FE side and metadata + read-only on the backend; CI deploy + manual hits are sufficient. Hybrid covers the new HANA-bound projections.

## Files

| File | Action |
| --- | --- |
| `srv/admin-service.cds` | modify (+ 3 assoc projections, + 1 picklist projection) |
| `app/admin-annotations.cds` | modify (+ owner column/filter/field, + Feedback facet, + LineItem#TutorialFeedback) |
| `approuter/static/js/joule.js` | modify (+ openWithMessage API, ~10 LOC) |
| `app/admin/tutorials/webapp/manifest.json` | modify (register controller extension) |
| `app/admin/tutorials/webapp/ext/AskJoule.controller.js` | create (~25 LOC) |
| `test/admin-service.test.js` | modify (+ owner / feedback / picklist cases) |
| `test/hybrid/admin-tutorials.test.js` | modify or create (HANA smokes for new projections) |

## Risks

- **Draft activation on Tutorials** rebuilds composition children. The `meta` association is exposed read-only and not part of any field group that drafts will write through, so this should be safe — but the implementation plan must verify by running the existing `before('UPDATE')` hook test path on the Tutorials projection with the new field.
- **`SELECT DISTINCT` on HANA at scale**: `TutorialMeta` has ≤ tutorial-count rows (~1k today). Performance is non-issue; no index work needed.
- **`window.parent` assumption**: Re-checked at design time; the admin shell mounts admin sub-apps as same-window UI5 components, not iframes. The `|| window` fallback covers both.

## Out of scope / YAGNI

- Editable owner on the Tutorial object page.
- Promoting owner to the Tutorials entity.
- Per-row Ask-Joule action on the list report.
- Empty-state illustration for Feedback when zero submissions.
- Separate Joule starter chip kind for "tutorial-improve" — auto-send bypasses starters entirely.
