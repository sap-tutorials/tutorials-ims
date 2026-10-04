# Tutorial Quarantine Persistence + Admin UI — Design

**Issue:** sap-tutorials/tutorials-ims#2585
**Date:** 2026-10-04
**Author:** Claude (with Tom)
**Status:** Draft — awaiting review

## Problem

`scripts/validate-tutorials.ts` quarantines tutorials that fail pre-publish
validation by `renameSync`-ing the offending `.md` into
`.tutorial-cache/quarantine/`, writing `errors.json`, and exiting 0. That
directory lives only on the ephemeral GitHub Actions runner for
`rebuild-content.yml` and is discarded when the run ends. Nothing consumes
`errors.json`; there is no alert and no Admin UI surface. A tutorial can silently
drop out of the ACTIVE content snapshot (and 404 on PROD) with no durable record
of *why* — confirmed live for `btp-transport-management-cpi-01-use-case` and
`private-link-gcp`.

## Goal

Persist quarantine results centrally in HANA and surface them in the Admin UI so
they are not lost, with a view that reflects **current** state (not
history-forever) plus per-repo / over-time reporting.

## Scope decisions (confirmed with Tom)

1. **Snapshot per build.** Each run that writes a snapshot records its complete
   current quarantine set, tagged with `runId` + `manifestVersion`. The Admin
   view shows only the **latest snapshot's** set. A slug that now passes is
   simply absent from the new snapshot → auto-cleared. History is retained by
   build for reporting.
2. **DB + Admin view only.** No alerting wiring in this issue — alerting can be a
   follow-up that consumes the new table.
3. **Full rebuilds only write snapshots.** `mode=full` posts the complete
   quarantine set. Slug-targeted/catalog runs validate only a subset, so their
   quarantine set is partial and would wrongly "clear" out-of-scope slugs — they
   do **not** post. This matches the issue framing (carry-forward masks failures
   until a full rebuild).
4. **Fail-open on post failure.** If the authenticated POST to HANA fails, the
   validator logs a warning and still exits 0 — never block content publish on
   quarantine telemetry. Matches the validator's existing never-exit-non-zero
   contract and the repo's fail-open ethos.

## Architecture

```text
rebuild-content.yml (mode=full)
  → npm run validate-tutorials  (scripts/validate-tutorials.ts)
      · validates hugo/content/tutorials/*.md  (unchanged logic)
      · builds quarantined[] = { file, slug, reason }  (unchanged)
      · NEW: if full build AND CAP_BASE_URL+CONTENT_API_KEY present,
             POST the snapshot → /content/quarantine-events  (best-effort)
          ↓  Authorization: Bearer <CONTENT_API_KEY>
CAP srv  → POST /content/quarantine-events  (raw Express + contentAuthMiddleware)
      · quarantineIngestHandler  (packages/content/content-store.js)
      · one DB write per snapshot: new snapshot row + its events,
        marked as the current snapshot (supersedes prior current)
          ↓
HANA  QuarantineSnapshots (1 per build) + QuarantineEvents (N per snapshot)
          ↑
AdminService (/admin, @requires:'Admin')
  → @readonly projections → Fiori Elements list view at /admin-ui/#quarantine-events
```

### Why two entities

A snapshot header (`QuarantineSnapshots`) + child events (`QuarantineEvents`)
cleanly expresses "the current set is the latest snapshot's children." The
"current view" is `events where snapshot.isCurrent`. Reporting (count over time /
per repo) is `events` grouped by `snapshot.createdAt` / `event.sourceRepo`.
This avoids per-slug upsert/clear bookkeeping — a snapshot is atomic and
immutable once written; "clearing" is just a new snapshot not containing the slug.

## Data model — `db/tutorial-quarantine.cds` (NEW)

```cds
namespace com.sap.developers.ims;
using { com.sap.developers.ims as ims } from './schema';
using { cuid, managed } from '@sap/cds/common';

/**
 * One row per build that posts a quarantine snapshot (mode=full only, #2585).
 * The newest snapshot with isCurrent = true defines the live quarantine set;
 * writing a new current snapshot flips the prior one to false.
 */
entity QuarantineSnapshots : cuid, managed {
  runId           : String(60);      // github.run_id
  workflowUrl     : String(400);     // server_url/repo/actions/runs/<runId>
  manifestVersion : String(60);      // ContentManifest version at build time (nullable)
  buildMode       : String(20) default 'full';   // full | (future: catalog/slug)
  isCurrent       : Boolean default false;
  eventCount      : Integer default 0;
  events          : Composition of many QuarantineEvents on events.snapshot = $self;
}

/**
 * One quarantined slug within a snapshot: why it was dropped and where it came from.
 */
entity QuarantineEvents : cuid, managed {
  snapshot    : Association to QuarantineSnapshots;
  slug        : String(255) @mandatory;   // lowercase canonical slug
  sourceFile  : String(255);              // e.g. foo.md
  sourceRepo  : String(120);              // from _discovery.json repoBySlug
  reason      : String(500) @mandatory;   // validator reason string
  sourceUrl   : String(600);              // link to the source .md in its repo (nullable)
}
```

Notes:
- `cuid, managed` → UUID `ID` + `createdAt/createdBy/modifiedAt/modifiedBy`
  (house style, matches `db/tutorial-freshness.cds`).
- `isCurrent` flip is done inside the ingest handler in one transaction:
  `UPDATE QuarantineSnapshots SET isCurrent=false WHERE isCurrent=true`, then
  `INSERT` the new snapshot with `isCurrent=true` and its events.
- `sourceUrl` derived from `sourceRepo` + `sourceFile` where resolvable; else null.

## Ingest endpoint — `/content/quarantine-events` (NEW)

Raw Express route, mirroring `/content/pipeline-log` exactly (the closest
sibling: single-shot JSON POST + DB write, same auth).

- **Register** in `srv/server.js` near the other content routes (line ~974):
  ```js
  app.post('/content/quarantine-events',
    express.json({ limit: '2mb' }), contentAuthMiddleware, quarantineIngestHandler);
  ```
- **Handler** `quarantineIngestHandler` lives in `packages/content/content-store.js`
  (inside `createContentHandlers`), exported through the `srv/lib/content-store.js`
  shim like the other handlers.
- **Auth**: reuses existing `contentAuthMiddleware` (Bearer = `CONTENT_API_KEY`,
  `timingSafeEqual`; 503 unconfigured / 401 missing bearer / 403 wrong key).
- **Request body**:
  ```json
  {
    "runId": "123456",
    "workflowUrl": "https://github.com/.../actions/runs/123456",
    "manifestVersion": "...",          // optional
    "buildMode": "full",
    "events": [
      { "slug": "...", "sourceFile": "...md", "sourceRepo": "...",
        "reason": "...", "sourceUrl": "..." }
    ]
  }
  ```
- **Behaviour**: validate `buildMode === 'full'` (reject others 400 — only full
  builds define a complete set); within one tx flip prior `isCurrent` → false,
  insert snapshot (`isCurrent=true`, `eventCount=events.length`) + child events.
  Return `{ snapshotId, eventCount }`. Idempotency: a repeat POST with the same
  `runId` replaces that run's snapshot (delete-by-runId then insert) so retries
  don't double-count.
- **Route-drift guard**: this route is content-publish-adjacent and should exist
  on both srv and srv-qa; if prod-only, allowlist in
  `scripts/check-srv-qa-route-drift.ts`. (Will verify at implementation time.)

## AdminService projection — `srv/admin-service.cds` (EDIT)

```cds
using from '../db/tutorial-quarantine';           // near lines 1-15
...
@readonly entity QuarantineSnapshots as projection on ims.QuarantineSnapshots;
@readonly entity QuarantineEvents    as projection on ims.QuarantineEvents;
```

Service is already `@path:'/admin'`, `@requires:'Admin'`. No MCP/HCQL changes.

## Admin UI view — `app/admin/quarantine-events/` (NEW) + annotations (EDIT)

Mirror `app/admin/channels/`. The admin-shell manifest is **generated** by
`discover-admin-components.js` — any `app/admin/<folder>/webapp/{Component.js,manifest.json}`
is auto-discovered; **no shell manifest edit**.

Files:
1. `app/admin/quarantine-events/webapp/Component.js` — 3-line
   `AppComponent.extend("sap.tutorials.admin.quarantineEvents.Component", ...)`.
2. `app/admin/quarantine-events/webapp/manifest.json` — Fiori Elements LR/OP,
   `sap.app.id = sap.tutorials.admin.quarantineEvents` (enforced at discover
   time), dataSource `mainService` → `/admin/`, ListReport contextPath
   `/QuarantineEvents`, ObjectPage, `crossNavigation.inbounds` entry
   `QuarantineEvents-manage`.
3. `app/admin/quarantine-events/webapp/i18n/i18n.properties`.
4. **EDIT** `app/admin-annotations.cds` — add `@UI` for `AdminService.QuarantineEvents`
   (template: `StepFailures` block). LineItem columns: `slug`, `reason`,
   `sourceRepo`, `sourceFile`, `createdAt` (= last-seen build time);
   SelectionFields: `sourceRepo`, `createdAt`; read-only
   (Delete/Insert/Update Restrictions all false); `sourceUrl` as a link field.

The view binds to `QuarantineEvents` filtered to the current snapshot. Two
options for "current only":
- **(a)** Expose a `QuarantineEventsCurrent` view/projection
  (`projection on ims.QuarantineEvents where snapshot.isCurrent`) and bind the LR
  to it — cleanest for the user (no filter needed).
- **(b)** Bind to `QuarantineEvents` with a default filter on `snapshot/isCurrent eq true`.

**Chosen: (a)** — a dedicated `@readonly QuarantineEventsCurrent` projection, so
the default Admin view is already "current" with no filter ceremony, while the
raw `QuarantineEvents` + `QuarantineSnapshots` projections remain available for
over-time / per-repo reporting.

**Deploy constraint (from CLAUDE.md):** admin-UI changes need a FULL deploy
(`npm run deploy -- --env <env>`, no `--skip-build`, no `-m` scoping); Step 3.5
`check-shipped-admin-bundle.cjs` gates on bundle drift.

## Validator change — `scripts/validate-tutorials.ts` (EDIT)

- Keep all existing logic (quarantine → move file → errors.json). Add `slug` and
  `sourceRepo` to each `quarantined[]` entry (slug from frontmatter, repo from
  the existing `repoBySlug` map — both already loaded).
- After the loop, **best-effort POST** the snapshot:
  - Guard: only when `process.env.CAP_BASE_URL` **and** `process.env.CONTENT_API_KEY`
    are set **and** the build is a full build. Full-build signal: a new
    `QUARANTINE_REPORT=full` env (set only by the rebuild-content.yml full path)
    — avoids posting from the `mta.yaml` before-all build and local runs where no
    backend exists. (Simpler and more explicit than inferring mode.)
  - Mirror `publish-content.ts` fetch: `POST ${CAP_BASE_URL}/content/quarantine-events`,
    `Authorization: Bearer ${CONTENT_API_KEY}`, `Content-Type: application/json`,
    `x-initiator: ci/${RUN_ID}`. Body = `{ runId, workflowUrl, buildMode:'full', events }`.
  - Wrap in try/catch: on non-ok or thrown error, `console.warn` and continue;
    **never throw, never exit non-zero** (fail-open).
- An **empty** quarantine set on a full build still posts (so a build that fixes
  everything writes an empty current snapshot → view clears). This is how
  auto-clear happens.

## Workflow change — `.github/workflows/rebuild-content.yml` (EDIT)

Add an `env:` block to the "Validate tutorials" step (lines 631-633). Only set
`QUARANTINE_REPORT=full` when the effective mode is full:

```yaml
- name: Validate tutorials
  if: ${{ steps.mode.outputs.effective_mode != 'catalog-only' }}
  env:
    CAP_BASE_URL: ${{ steps.srv.outputs.srv_url }}
    CONTENT_API_KEY: ${{ steps.env.outputs.target == 'qa' && secrets.CONTENT_API_KEY_QA || secrets.CONTENT_API_KEY }}
    RUN_ID: ${{ github.run_id }}
    WORKFLOW_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}
    QUARANTINE_REPORT: ${{ steps.mode.outputs.effective_mode == 'full' && 'full' || '' }}
  run: npm run validate-tutorials
```

(Verify exact step-id names — `steps.mode.outputs.effective_mode`,
`steps.srv.outputs.srv_url`, `steps.env.outputs.target` — against the current
file at implementation time. Mirror into `rebuild-content-qa.yml` if it has its
own validate step.)

## Testing

- **Unit (fast, in-memory SQLite):**
  - `stepCountReason` / `shortcodeBalanceCheck` / `emptyContentCheck` — unchanged,
    existing tests stay green.
  - New: `quarantineIngestHandler` route test under `srv/__tests__/lib/`
    (template: `content-publish-routes.test.js`): 503/401/403 auth matrix;
    happy path inserts snapshot + events, flips prior `isCurrent`; non-full
    `buildMode` → 400; repeat `runId` replaces (idempotent); empty events → empty
    current snapshot.
  - New: `QuarantineEventsCurrent` returns only current-snapshot events.
  - New (validator): extract the POST into a small testable function; assert it
    no-ops when env unset and when `QUARANTINE_REPORT !== 'full'`, and that a
    failed fetch does not throw / exit non-zero.
- **Hybrid (real HANA):** covered by `npm run test:hybrid` for the entity +
  endpoint (LOB-free, so CDS QL is fine).
- **E2E:** optional advisory — admin list view renders; defer to the post-deploy
  `e2e` job (self-skips without `SMOKE_BASE_URL`).

## Non-goals

- Alerting / NGDS wiring (follow-up).
- Posting from slug-targeted or catalog runs.
- Serve-time 404 fixes (#3) — this issue only makes the *why* durable + visible.

## Open items to verify during implementation

1. Exact workflow step-ids in the *current* `rebuild-content.yml`.
2. Whether `rebuild-content-qa.yml` has its own validate step to mirror.
3. Whether the new Express route needs the srv-qa route-drift allowlist.
4. `manifestVersion` availability at validate time (nullable if not resolvable).
```