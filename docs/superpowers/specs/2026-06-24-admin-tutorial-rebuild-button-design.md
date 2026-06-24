# Admin UI "Rebuild this tutorial" button — Design

> Spec brainstormed 2026-06-24 with Tom. Adds a header action button to the admin Tutorials Fiori Elements ObjectPage so admins can self-serve a single-tutorial republish without forcing a fake-edit-save dance or asking ops to dispatch the workflow manually. Reuses [`scheduleRebuild`](../../../srv/lib/rebuild-trigger.js)'s existing 60-second debounce, slug-targeted classification (#429), and Phase-2-scoped prefetch (#613). Closes the manual-dispatch UX gap PR #610 partially closed at the CLI surface, but extends it into the admin UI where day-to-day operators live.

## Summary

When an admin opens a single tutorial at `/admin-ui/#/tutorials/<ID>`, they see a new header action button **"Rebuild this tutorial"** next to the existing **Edit** / **Delete** / **AskJoule** buttons. Clicking it:

1. Shows a confirm dialog with the tutorial title.
2. On confirm, calls a new bound action `AdminService.rebuildContent` on the Tutorials entity.
3. The action handler resolves the tutorial's slug, audit-logs the intent, and invokes `scheduleRebuild(reason, { mode: 'slug-targeted', slug })`.
4. Returns a result object to the UI.
5. The UI shows a toast: "Rebuild dispatched for "<title>". The page will refresh in ~2 minutes."

The dispatch reuses the existing 60-second debounce so a burst of button clicks coalesces into one workflow_dispatch (existing `SLUG_ACCUMULATOR_CAP=50` slug-merge behavior). End-to-end wall clock for the resulting rebuild matches PR #615's measured `slug-targeted` time: ~2m 22s.

## Context — why this exists

Today's options for an admin who wants to republish ONE tutorial (e.g. because a parser fix landed, or the source markdown in GitHub got edited but Hugo hasn't picked it up):

| Option | Friction |
|---|---|
| Edit the tutorial in the admin UI and save | Forces a fake change. Admin needs to find a field to mutate-and-revert OR live with a noisy change-tracking entry. |
| SSH to a dev box and run `gh workflow run rebuild-content.yml -f slug=<slug>` | Requires CLI access, an admin PAT for `gh`, and remembering the exact slug. Not self-serve. |
| Ask ops to dispatch the workflow | Cross-team friction. Slow. |

A dedicated button gives admins an explicit, intent-bearing surface that doesn't require fake edits, CLI access, or ops involvement. Closes the gap PR #610 opened at the workflow-dispatch CLI surface — the admin UI is where admins actually live.

The feature also lays groundwork for later author self-service (tracked separately in [#617](https://github.com/sap-tutorials/tutorials-ims/issues/617)). For v1 the button is admin-scope-only; the per-tutorial-ownership and author-scope work is a separate design problem.

## Settled decisions (from 2026-06-24 brainstorming with Tom)

1. **Admin only for v1.** Author self-service is tracked in [#617](https://github.com/sap-tutorials/tutorials-ims/issues/617) — bigger auth-restructure story (per-row ownership, scope binding decisions, UI shell split). Out of scope here.

2. **Fire-and-forget toast.** No persistent "last rebuild" status column on the row. Toast confirms dispatch; admin manually refreshes after ~2 minutes if they want to see the result. Persistent status indicators tracked as a future ask.

3. **Header button on the ObjectPage** (tutorial detail page), not a row-level action on the ListReport. Matches the existing `AskJouleAction` pattern. Single-tutorial scope is intent-obvious.

4. **Reuse existing `scheduleRebuild` + 60s debounce.** No bypass-debounce mode, no new short-debounce. Two admins clicking Rebuild on different tutorials within 60s merge into ONE dispatch with both slugs (existing slug-accumulator behavior). Same semantics as today's admin Tutorial CRUD writes.

5. **Confirm dialog before dispatch.** `MessageBox.confirm` with the tutorial title interpolated. Prevents accidental clicks; gives the admin a chance to verify they're on the right tutorial.

6. **Audit-log every dispatch.** Emit `auditEvent('TutorialRebuildTriggered', { user, tutorialId, slug, source: 'admin-ui:tutorial-detail' })` before calling `scheduleRebuild`. Reuses the existing audit-event pattern from Secrets (`SecretValueWritten`, `SecretValueRotated`). Useful for tracing intent vs the existing change-tracking entries which only record CRUD writes.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│ Admin UI — Fiori Elements ObjectPage (app/admin/tutorials/)     │
│ /admin-ui/#/tutorials/<ID>                                       │
│                                                                  │
│  ┌─────────────────────────────────────┐                         │
│  │ Header actions toolbar              │                         │
│  │  [Edit] [Delete] [AskJoule]         │                         │
│  │  [Rebuild this tutorial]  ◄── NEW   │                         │
│  └─────────────────────────────────────┘                         │
│  Press handler → confirm dialog → bound-action call              │
└────────────────────────────┬────────────────────────────────────┘
                             │ OData v4 POST
                             │ /admin/Tutorials(ID)/AdminService.rebuildContent
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│ AdminService.rebuildContent (bound action on Tutorials)         │
│ srv/admin-service.cds + srv/admin-service.js                     │
│                                                                  │
│  1. Resolve req.params[0].ID → Tutorials.slug (CQL SELECT)      │
│  2. Reject if slug is null/empty (data-quality guard)           │
│  3. auditEvent('TutorialRebuildTriggered', { user, slug, ... }) │
│  4. scheduleRebuild('admin-ui:rebuild-button:<user>', {         │
│       mode: 'slug-targeted', slug                                │
│     })                                                           │
│  5. Return { dispatched, slug, debounced, workflowUrl }         │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│ srv/lib/rebuild-trigger.js — scheduleRebuild() (UNCHANGED)      │
│  60s debounce + mode-priority merge + dispatch to GH Actions    │
└─────────────────────────────────────────────────────────────────┘
```

Defense in depth:

| Layer | Enforcement |
|---|---|
| Approuter route `/admin-ui/` | XSUAA scope `Admin` (existing — no change) |
| AdminService service-level `@requires: 'Admin'` (existing) | All bound actions inherit |
| Action handler (new) | Validates slug present; defaults `req.user.id` to `'anonymous'` for defensive logging |
| `scheduleRebuild` | No additional auth check — AdminService scope is the gate; internal-srv-only API |

## Changes by file

### 1. `srv/admin-service.cds` — bound action declaration

Extend the existing Tutorials projection (around line 20) with a bound action:

```cds
extend service AdminService with {
  entity Tutorials actions {
    @Core.OperationAvailable: true
    @Common.IsActionCritical: true
    action rebuildContent() returns RebuildContentResult;
  };

  type RebuildContentResult {
    dispatched : Boolean;
    slug       : String;
    debounced  : Boolean;
    workflowUrl: String;
  };
}
```

The `@Common.IsActionCritical: true` annotation causes Fiori Elements to render the button with a "destructive" visual treatment (red highlight) and would surface a confirmation if we relied on FE's built-in dialog. We still ship our own confirm dialog in the controller-extension because we want full control over the message text (tutorial title interpolated).

### 2. `srv/admin-service.js` — handler registration

```js
admin.on('rebuildContent', 'Tutorials', async (req) => {
  const tutorialId = req.params[0].ID;
  const { Tutorials } = cds.entities('com.sap.developers.ims');
  const row = await SELECT.one.from(Tutorials).columns('slug', 'title').where({ ID: tutorialId });
  if (!row?.slug) {
    return req.reject(400, 'Tutorial has no slug; cannot rebuild');
  }

  await auditEvent('TutorialRebuildTriggered', {
    user: req.user?.id ?? 'anonymous',
    tutorialId,
    slug: row.slug,
    source: 'admin-ui:tutorial-detail',
  });

  await scheduleRebuild(`admin-ui:rebuild-button:${req.user?.id ?? 'anonymous'}`, {
    mode: 'slug-targeted',
    slug: row.slug,
  });

  return {
    dispatched: true,
    slug: row.slug,
    debounced: true,
    workflowUrl: 'https://github.com/sap-tutorials/tutorials-ims/actions/workflows/rebuild-content.yml',
  };
});
```

`scheduleRebuild` and `auditEvent` are already imported in `admin-service.js` for other actions. No new imports needed beyond confirming the locations.

### 3. `app/admin-annotations.cds` — UI action binding

Annotate the action so Fiori Elements renders it. The existing Tutorials annotations live at `app/admin-annotations.cds:502-612`. Add a header `DataFieldForAction` in the `@UI.HeaderFacets` for Tutorials:

```cds
annotate AdminService.Tutorials with @UI : {
  Identification : [
    // ... existing entries ...
    {
      $Type : 'UI.DataFieldForAction',
      Label : '{i18n>RebuildTutorialButton}',
      Action: 'AdminService.rebuildContent',
      ![@UI.Importance] : #High,
    },
  ],
};
```

Putting it in `Identification` (vs `LineItem`) makes it appear in the OP header next to Edit/Delete/AskJoule rather than per-row in the list. Existing AskJoule action uses the same Identification entry point — pattern consistency.

### 4. `app/admin/tutorials/webapp/manifest.json` — i18n + (optional) press override

If we want the button label localized per browser locale, add to `i18n/i18n.properties`:

```properties
RebuildTutorialButton=Rebuild this tutorial
```

The default OData-action-bound button uses the i18n label automatically from the annotation; no manifest change required UNLESS we want a custom press handler. We DO want one (for the confirm dialog + toast) so we override:

```json
"sap.ui5": {
  "extends": {
    "extensions": {
      "sap.ui.controllerExtensions": {
        "sap.fe.templates.ObjectPage.ObjectPageController": {
          "controllerName": "sap.tutorials.admin.tutorials.ext.RebuildTutorial"
        }
      }
    }
  }
}
```

With this controller extension, the bound action's press is intercepted by `onRebuildTutorial` in `ext/RebuildTutorial.js`.

### 5. `app/admin/tutorials/webapp/ext/RebuildTutorial.js` — controller extension (new file)

```js
sap.ui.define([
  'sap/m/MessageBox',
  'sap/m/MessageToast',
], (MessageBox, MessageToast) => {
  'use strict';
  return {
    onRebuildTutorial: function (oEvent) {
      const oContext = this.getView().getBindingContext();
      const oData = oContext.getObject();
      const sTitle = oData.title || oData.slug || '(this tutorial)';

      MessageBox.confirm(
        `Rebuild tutorial "${sTitle}"? This dispatches a workflow that will republish the tutorial's content to HANA in about 2 minutes.`,
        {
          title: 'Rebuild tutorial',
          actions: [MessageBox.Action.OK, MessageBox.Action.CANCEL],
          emphasizedAction: MessageBox.Action.OK,
          onClose: (sResult) => {
            if (sResult !== MessageBox.Action.OK) return;
            const oModel = this.getView().getModel();
            const oAction = oModel.bindContext(
              'AdminService.rebuildContent(...)',
              oContext,
              { $$inheritExpandSelect: true },
            );
            oAction.execute().then(() => {
              MessageToast.show(
                `Rebuild dispatched for "${sTitle}". The page will refresh in ~2 minutes.`,
                { duration: 5000 },
              );
            }).catch((err) => {
              MessageBox.error(`Could not dispatch rebuild: ${err.message ?? err}`);
            });
          },
        },
      );
    },
  };
});
```

Pattern matches the existing `ext/AskJoule.js` controller-extension already in this directory.

### 6. `srv/lib/__tests__/admin-rebuild-tutorial.test.js` — unit tests (new file)

Vitest, unit project, uses `cds.test()` + `_resetForTests({ dispatchFn })` to mock the GH dispatch:

| Test | Asserts |
|---|---|
| dispatches with `mode=slug-targeted` + slug | scheduleRebuild called once; opts.mode='slug-targeted'; opts.slug equals row's slug |
| emits `TutorialRebuildTriggered` audit event | mock auditLog.log called with `('SecurityEvent', { data: { action: 'TutorialRebuildTriggered', user, tutorialId, slug, source: 'admin-ui:tutorial-detail' }})` |
| reason string includes user id | scheduleRebuild reason arg matches `/^admin-ui:rebuild-button:.+/` |
| rejects 400 when slug is null | scheduleRebuild NOT called; audit event NOT emitted; req.reject(400) |
| rejects 400 when slug is empty string | same |
| returns `{ dispatched, slug, debounced, workflowUrl }` shape | UI contract stable |
| anonymous user defaulted | `req.user.id` absent → user='anonymous' in audit + reason; defensive — @requires gate blocks unauthenticated upstream |

We do NOT re-test the debounce, mode-merge, or token resolution — those are covered by [srv/lib/__tests__/rebuild-trigger.test.js](../../../srv/lib/__tests__/rebuild-trigger.test.js).

### 7. `test/smoke/admin-endpoints.test.js` — 403 smoke test (additive)

One assertion: `POST /admin/Tutorials('<id>')/AdminService.rebuildContent` returns 403 when called without an Admin scope token. Defense-in-depth check against the `@requires: 'Admin'` gate.

### 8. Optional `test/hybrid/admin-rebuild-tutorial.test.js` — hybrid test (gated)

Gated by `HYBRID_REBUILD_TESTS=true` env var. Smoke-tests the wire-format end-to-end against real HANA via `cds bind --exec`. Uses `__TEST__`-prefixed tutorial rows per the existing hybrid-test guard at [test/hybrid/_guard.js](../../../test/hybrid/_guard.js).

## Error & edge-case handling

| Scenario | Behavior |
|---|---|
| Tutorial row has null/empty slug (legacy data) | `req.reject(400, 'Tutorial has no slug; cannot rebuild')` → UI shows `MessageBox.error` |
| Tutorial row not found | CDS auto-404 from the bindContext path before our handler runs |
| `GITHUB_DISPATCH_TOKEN` unreachable from credstore + env | `scheduleRebuild` silently no-ops (existing behavior); handler still returns `dispatched: true` because the schedule was queued. Boot-time log (`[rebuild-trigger] GITHUB_DISPATCH_TOKEN unreachable...`) flags this to ops. We do NOT surface "token missing" to the admin UI — that's an ops problem, not an admin-action problem. |
| Audit-log write fails | `auditEvent` already swallows errors silently. Rebuild still dispatches. |
| User double-clicks Rebuild | Both calls invoke `scheduleRebuild`; second merges into the same debounce window. UI toast on second click confirms "Rebuild dispatched" — accurate. |
| Two admins rebuild different tutorials within 60s | Both slugs merge into one dispatch with `slugs: "a,b"` (existing slug-accumulator behavior, capped at 50). |
| Admin clicks Rebuild then immediately edits & saves the same tutorial | Save's classifier also calls `scheduleRebuild`; second-merge into same window. One dispatch fires. No data loss. |
| Source markdown deleted from GitHub upstream | `fetch-tutorials.ts` errors at the Fetch step (existing behavior). Admin sees the failed run via the workflow URL. No new failure mode introduced. |

## Testing strategy

See §3 of the brainstorming session and the test file list in "Changes by file" above. Summary:

- **Unit** (primary): 7 tests in `srv/lib/__tests__/admin-rebuild-tutorial.test.js`. Mock the GH dispatch via `_resetForTests({ dispatchFn })`. ~50 LOC of test code.
- **Smoke**: 1 additive assertion in `test/smoke/admin-endpoints.test.js` for the 403 path.
- **Hybrid** (opt-in): `HYBRID_REBUILD_TESTS=true` runs `test/hybrid/admin-rebuild-tutorial.test.js` against real HANA. Optional to avoid burning CI budget on every hybrid run.
- **No UI tests**: existing admin tile controller-extensions (including AskJoule) are not unit-tested in this codebase. We rely on the server-side contract tests + manual verification for v1.

### Manual verification checklist (included in PR description)

1. Build admin shell: `npm --prefix app/admin-shell run build`
2. Deploy or `cds watch` + `npm run start:approuter`
3. Navigate to `/admin-ui/#/tutorials`, open a tutorial
4. Click "Rebuild this tutorial" → confirm dialog appears with correct tutorial title
5. Click OK → toast appears within ~1s
6. Click Cancel → no toast, no dispatch (verify via `gh run list --branch main --limit 1`)
7. Open the GitHub Actions workflow runs page → run appears within 60s with `trigger-source: admin-ui:rebuild-button:<your-user-id>`
8. Within the run, `Determine effective rebuild mode` shows `slug-targeted (explicit ...)`
9. After ~2 min, the run completes and the tutorial's content is republished

## Rollout

### Deployment shape

- CAP srv changes (admin-service.cds + .js) → redeploy `tutorials-srv` via MTA
- Admin shell static asset (manifest.json + ext/RebuildTutorial.js) → bundled via `componentUsages` and copied into approuter `static/admin-ui/` by the same MTA deploy

No DB schema changes. No new env vars. No new XSUAA scopes. No new secrets.

### Pre-deploy checklist

| Check | How |
|---|---|
| `GITHUB_DISPATCH_TOKEN` reachable on target srv | `cf logs tutorials-srv --recent \| grep rebuild-trigger` — look for `[rebuild-trigger] active`. Fix via `/admin-ui/#secrets-display` if needed. |
| Audit-logging plugin (`@cap-js/audit-logging`) configured | Already enabled. No action. |
| Admin Tutorials app builds clean | `npm --prefix app/admin-shell run build` succeeds locally. |

### Rollout sequence

1. Land this spec (you're reading it).
2. Implementation PR — single PR with all 8 file touches (6 changes + 2 test additions). Target <300 LOC diff.
3. Local hybrid verification — `npm run dev:hybrid`, exercise the manual checklist.
4. Deploy to DEV — MTA deploy.
5. PROD readiness — project is DEV-only until July 2026 cutover. No feature flag needed (the surface area is small enough that "remove it" is one CDS line + one annotation).

### Backwards compatibility

Additive everywhere. No breaking changes to existing endpoints, schemas, or UI tiles. The new audit event type `TutorialRebuildTriggered` is opaque to existing audit-log consumers (they treat unknown action types as passthrough).

## Observability

After deploy, watching for:

1. **GH Actions runs** — `gh run list --workflow rebuild-content.yml` shows runs with `trigger-source: admin-ui:rebuild-button:<user-id>` when admins click the button.
2. **Audit-log queries** — `SELECT * FROM AUDIT_LOG WHERE DATA LIKE '%TutorialRebuildTriggered%' ORDER BY TIMESTAMP DESC LIMIT 10` shows recent button uses.
3. **CF logs** — `[rebuild-trigger]` lines on the srv app surface dispatch outcomes.

## Out of scope (explicitly)

To forestall scope creep, these are documented here as deferred:

- **Author-surface access** — [#617](https://github.com/sap-tutorials/tutorials-ims/issues/617).
- **Per-row "last rebuild" status indicator on the list** — needs new DB fields + polling or websocket. Defer until ops asks for it.
- **Bulk rebuild** (select N tutorials → rebuild all) — bounded by the existing `SLUG_ACCUMULATOR_CAP=50` slug-merge anyway; multiple button clicks within the debounce window coalesce organically.
- **Per-tutorial debounce or rate-limit** beyond the 60s global window — YAGNI for v1.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Admin double-clicks Rebuild → 2 audit-log entries but only 1 GH dispatch | Acceptable. Audit-log entries are intent records; the merged dispatch is the action. Both useful in different forensics. |
| Admin clicks Rebuild then edits and saves the same tutorial → 2 scheduleRebuild calls, 1 dispatch | Same debounce-window behavior; one dispatch. No data loss. |
| Admin clicks Rebuild on a tutorial whose source markdown was deleted upstream | `fetch-tutorials.ts` errors gracefully; admin sees the failed run via the workflow URL. No new failure mode. |
| GH dispatch token expires mid-day; admin clicks Rebuild expecting success | `scheduleRebuild` silently no-ops, audit log records intent, no dispatch fires. Mitigation: admin checks workflow runs page; finding no new run, asks ops to rotate the token (existing runbook). No regression from today's admin-write behavior. |

## Related

- PR #606 — parser fence-awareness fix that surfaced the workflow-dispatch UX gap
- PR #610 — Phase 1 of #609: auto-infer `mode=slug-targeted` from CLI dispatch
- PR #615 — Phase 2 of #609: scope Phase 2 metadata prefetch (7m → 2m)
- PR #616 — operations runbook + measurements docs
- Issue [#429](https://github.com/sap-tutorials/tutorials-ims/issues/429) — original 3-mode rebuild classifier (the auto-classification this spec composes with)
- Issue #433 — multi-slug filter (`slugs` workflow input)
- Issue #617 — broader auth-restructure for author UI access
- Runbook: [docs/developers/operations/rebuild-content-workflow.md](../../developers/operations/rebuild-content-workflow.md)
