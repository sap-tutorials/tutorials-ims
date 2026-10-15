# URL Health Check for Tutorials, Missions, and Groups — Design

**Issue:** [sap-tutorials/tutorials-ims#2787](https://github.com/sap-tutorials/tutorials-ims/issues/2787)
**Date:** 2026-10-15
**Status:** Approved design — ready for implementation plan

## Problem

Two integrity gaps in the published content graph:

1. **Membership integrity (Part 1).** Active (published) Missions and Groups may
   contain tutorials that have been deleted or made inactive, leaving dead or
   excluded items inside live learning paths.
2. **URL reachability (Part 2).** Published tutorial, mission, and group
   endpoints may not actually be HTTP-reachable on the public site (broken
   routing, missing `ContentCurrent` row, slow responses).

Both need to be visible to admins in the Admin UI, runnable on demand, and
checked automatically on a schedule.

## Decisions (from brainstorming)

- **Trigger:** both — a nightly scheduled job AND an on-demand "Run scan now"
  button in the Admin UI, funneled through the same job.
- **Part 1 coverage:** reuse the existing `completionHealth()` membership check
  and **extend** it to also flag `DELETED` children and children that are
  published but have no `ContentCurrent` row (`not-served`).
- **Part 2 target set:** all ACTIVE tutorials + published missions + published
  groups.
- **Probe target:** the real deployed **public** URLs
  (`HomepageConfig.publicBaseUrl` → `https://developers.sap.com`), so the probe
  exercises the true end-user path including approuter routing.
- **Persistence:** Part 2 writes **per-row status columns** on
  `Tutorials`/`Missions`/`Groups` (like `homepage-link-health.js` does on
  shelves). Latest-run-only — each scan overwrites.
- **Part 1 storage:** membership findings are **edge facts**, not row
  properties, so they are **computed live** by the extended `completionHealth()`
  each time the tab is opened (DB-only, cheap). No new report entity.
- **Alerting:** a scan that finds BROKEN URLs raises a WARNING via the existing
  `alerting.raise()` path (same policy as `homepage-link-health.js`).

## Architecture

```text
Part 2 (URL reachability) — scheduled + on-demand job
  registerJob('url-health-check', nightly @ off-minute)  →  runUrlHealthCheck(logId, opts)
    collect targets:  ACTIVE Tutorials      → /tutorials/<slug>/
                    + published Missions    → /missions/<slug>/
                    + published Groups      → /tutorials/group-<slug>
    resolve base:     resolvePublicBaseUrl(db)                      [reused]
    probe:            runHealthCheckLoop(rows, resolveUrl, updateRow)[reused]
    persist:          UPDATE row.linkStatus / lastChecked (skip if override set)
    alert:            buildBrokenLinksAlert → alerting.raise(WARNING)[reused pattern]

Part 1 (membership integrity) — computed live, not stored
  completionHealth()  [extended]  →  findUnhealthyEntities(db)
    published Groups via GroupPathItems, Missions via CompletionPaths/Items
    flag child reason: 'unresolved' | 'inactive' | 'empty' | 'deleted'(new) | 'not-served'(new)
```

### Admin UI

New screen `app/admin/health/` embedded in the `sap.tnt.ToolPage` shell, nav
entry under **Reporting** (`requiredScope: 'Admin'`), two tabs:

- **URL Status** — ListReport over Tutorials/Missions/Groups filtered to rows
  with a `linkStatus`, showing status + `lastChecked`, an override toggle, and a
  **Run scan now** action (unbound `runUrlHealthScan()` → `JobControls.runJob('url-health-check')`).
- **Membership Issues** — read-only list bound to the extended
  `completionHealth()` function result.

## Components

### New files

| File | Purpose |
|---|---|
| `srv/jobs/url-health-check-job.js` | `runUrlHealthCheck(logId, opts)` — collect targets, probe, persist, alert |
| `srv/lib/health-url-resolver.js` | `resolveEntityUrl({kind, slug}, baseUrl)` + `collectHealthTargets(db)` → `[{kind, legacyId, slug, url, override}]` |
| `app/admin/health/webapp/{Component.js, manifest.json, ext/*}` | FE screen, two tabs |

### Modified files

| File | Change |
|---|---|
| `db/schema.cds` | add shared `aspect LinkHealth { linkStatus; lastChecked; linkStatusOverride; }` to `Tutorials`, `Missions`, `Groups` |
| `srv/lib/completion-reconcile.js` | extend `findUnhealthyEntities` reasons: `deleted`, `not-served` (via `filterServableSlugs`) |
| `srv/admin-service.cds` | expose link-health columns on projections; add unbound `runUrlHealthScan()` action |
| `srv/jobs/scheduler.js` | `registerJob({jobName:'url-health-check', schedule, ttlMs, fn})` in `registerJobs()` (off-minute, not :00/:30) |
| `app/admin-shell/webapp/manifest.json` | componentUsage `sap.tutorials.admin.health` |
| `app/admin-shell/webapp/model/navigation.json` | nav entry under Reporting, `requiredScope:'Admin'` |

### Key interfaces

```js
// srv/lib/health-url-resolver.js
collectHealthTargets(db) // → one row per probe target, de-duplicated by url
// [{ kind:'TUTORIAL'|'MISSION'|'GROUP', legacyId, slug, url, override }]
//   TUTORIAL: status NULL|'ACTIVE'          → /tutorials/<slug>/
//   MISSION:  published=true, status active → /missions/<slug>/
//   GROUP:    published=true, status active → /tutorials/group-<slug>

resolveEntityUrl({ kind, slug }, baseUrl) // lowercases slug; builds absolute URL

// in url-health-check-job.js
updateRow(row, status) // dispatch UPDATE to entity by row.kind; skip if override set
```

## Reuse ledger

Reused as-is from the existing codebase (no reinvention):

- `srv/jobs/homepage-link-health.js`: `runHealthCheckLoop` (concurrency-4 worker
  pool, 200ms sleep, HEAD→GET fallback, OK/SLOW/BROKEN), `checkOne`,
  `toAbsoluteUrl`, `resolvePublicBaseUrl`, `buildBrokenLinksAlert`.
- `srv/jobs/scheduler.js` + `srv/cron-service.js`: job registry, `runJobByName`,
  `runWithLock` chassis, `logJobItem`, `JobControls.runJob` manual trigger.
- `srv/lib/completion-reconcile.js`: `findUnhealthyEntities` (Part 1 core).
- `srv/lib/servable-slugs.js`: `filterServableSlugs` for the `not-served` check
  (ContentCurrent presence).

New code is confined to: the URL resolver + target collection, three column
additions, two new reason codes, the job wrapper, and the FE screen.

## Error handling & fail-open

- Probe failures are the expected output, not errors — `checkOne` catch-all →
  `BROKEN`, never throws out of the loop.
- Job runs under the `runWithLock` chassis: returns `{ok:false, error}` on fatal
  failure (DB down) so it fails-shut and alerts, without crashing the scheduler.
- `resolvePublicBaseUrl` falls back to `https://developers.sap.com`.
- Per-row UPDATE isolated per row; one bad write doesn't abort the batch.
- No content BLOBs touched — only metadata columns, so the "never SELECT a BLOB
  alongside metadata" LOB-locator rule does not apply.

## Edge cases

- **Slug casing** — lowercase before building the URL (canonical form 301s
  otherwise → false SLOW/redirect noise).
- **Redirects** — renamed tutorials/missions 301 to canonical via
  `GroupSlugRedirects`/`MissionSlugRedirects`; `fetch` follows redirects by
  default, so a 3xx→200 chain reads as OK.
- **Override** — `linkStatusOverride` set → skip probe-driven status change AND
  surface as "pinned" in the UI.
- **Mission reachable two ways** (`/missions/<slug>/` and
  `/tutorials/mission-<slug>`) — probe only the canonical `/missions/<slug>/`.
- **Dedup** — a tutorial inside multiple groups is one URL → one probe.
- **Scan latency** — ~N URLs × (200ms / 4 workers); bounded, runs in the job,
  never blocks a request.

## Testing

- **Unit (`npm test`, in-memory SQLite):**
  - `collectHealthTargets` — correct URL per kind, filters inactive/unpublished,
    dedups by url.
  - `resolveEntityUrl` — casing + base-url fallback.
  - extended `findUnhealthyEntities` — emits new `deleted` / `not-served`
    reasons.
  - `updateRow` — honors override (no status change when pinned).
  - `checkOne` OK/SLOW/BROKEN mapping with mocked `fetch`.
- **Hybrid (`npm run test:hybrid`, real HANA via `cds bind`):** scan writes
  `linkStatus`/`lastChecked`; override pins across a re-run.
- **Manual verify before "done" (Tom's #1 rule):** run the job via
  `JobControls.runJob`, confirm rows updated + alert raised on a seeded broken
  slug; load the Admin UI health screen — both tabs render, **Run scan now**
  works end to end.

## Deployment notes

- `health-url-resolver.js` is a new `srv/lib/` module. Per CLAUDE.md, re-walk the
  transitive `./` imports from `srv/lib/content-store.js` and confirm whether it
  enters that graph; if so, add it to the `srv-qa` `cp` list in
  `.deploy/mta.yaml`. Expected: job-only, NOT in the content-store graph — verify
  during implementation.
- Admin-UI change ⇒ **full deploy** (`npm run deploy -- --env <env>`, no
  `--skip-build`, no `-m` scoping); the admin bundle is raw-copied by the MTA
  approuter builder and Step 3.5 (`check-shipped-admin-bundle.cjs`) gates drift.
- Nightly schedule: pick an unused off-minute (e.g. `:17`), not `:00`/`:30`.
