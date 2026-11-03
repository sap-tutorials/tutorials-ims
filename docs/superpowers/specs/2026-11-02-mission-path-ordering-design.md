# Mission Completion-Path Ordering — Design

**Issue:** sap-tutorials/tutorials-ims#2990 — "Allow the Mission Admin UI to be able to set the order of the Completion Paths"
**Date:** 2026-11-02
**Repo:** `sap-tutorials/tutorials-ims` (local folder `tutorials-poc`)

## Intent / Why

A Mission owns many `CompletionPaths` (the "tracks" a learner can take through a mission —
e.g. "HANA Cloud" vs "On-prem"). Today an admin has **no way to control the order** these
paths appear in. The `CompletionPaths` entity has no order column, so:

- The Fiori admin UI lists paths in arbitrary (DB) order.
- Renderers order paths by `legacyId` — the import-sequence id, which is meaningless to an
  author and cannot be changed through the UI.
- The branching mission page renders only `paths[0]`, so "which path is primary" is currently
  decided by DB order, not by the author.

Authors need the same ordering control they already have for the **items inside** a path
(`CompletionPathItems.itemOrder`, surfaced as an editable "Order" column). This change gives
`CompletionPaths` the exact analogue.

Tom confirmed: **both the mission detail page and the public `/app-space/?eventId=…` page must
respect the admin-set order** — not just the admin table.

## Goals

- Add an author-editable order to `CompletionPaths`, mirroring the established
  `CompletionPathItems.itemOrder` pattern (field + editable LineItem column + `SortOrder`).
- Mission detail page (SSR + branching variant), the catalog build, and the **`/app-space/`
  learner page** all render paths in the admin-set order.
- Existing paths get a sensible, stable initial order with no visible disruption to authors
  (beyond the one primary-path shift Tom accepted — see Decision 6 / anti-goals).
- New paths created inline in the admin UI get an auto-assigned order (no manual typing required).

## Non-goals

- No change to **item** ordering within a path (`itemOrder` already exists and works).
- No change to the public URL/slug of any path.
- No drag-and-drop reordering — ordering is via an editable numeric "Order" column, identical to
  how `CompletionPathItems` and `GroupPathItems` already work. (Drag-drop is a possible later
  enhancement, explicitly out of scope.)
- No change to the content-publish pipeline — `CompletionPaths` are admin-authored, not published
  from tutorial markdown (verified: only `admin-service.js` writes them).
- **No change to the event analytics bars** (`event-path-buckets.js` / display monitor). Those
  deliberately sort by completion count and are a different surface from the app-space learner page.

## Anti-goals (would make this a failure even if it "works")

- Silently reordering a published mission's paths on deploy in a way Tom did not bless. The one
  accepted exception: on branching missions, the deterministic `paths[0]` primary path will move to
  the alphabetically-first path on deploy (Tom accepted this one-time shift). No *other* surface
  should change what learners see beyond applying the alphabetical initial order.
- A migration that only runs on fresh deploys and leaves real HANA data with NULL order and
  DB-dependent sort (NULL-sort differs between HANA and SQLite).

## Constraints (from CLAUDE.md / repo conventions)

- `CompletionPaths` is `cuid, LegacyKeyed`; slug is derived from `name` and unique **per mission**
  (`admin-service.js` `deriveCompletionPathSlug`, :1522-1558).
- Generated bundles `srv/lib/_shared/content.bundle.mjs` and `channels.bundle.mjs` contain compiled
  copies of `catalog-data.js` — **edit source, rebuild, never hand-edit**.
- PRs target `DEV`; `main` is protected. Open a PR, never direct-merge.
- Admin-UI (annotation) changes ship into the approuter only on a **full `mbt build`** — a
  `--skip-build` / `-m`-scoped deploy ships a stale admin bundle (Step 3.5 gate).
- New annotation markup on mission pages needs a **content rebuild** after deploy to bake into the
  HANA BLOBs. (App-space + branching mission pages are runtime CAP reads, not baked BLOBs, so those
  reflect the new order immediately after deploy without a rebuild.)
- TEST THE ACTUAL THING BEFORE CALLING IT DONE.

## Decisions made (the "how" that's settled)

1. **New field:** `CompletionPaths.pathOrder : Integer`. Direct analogue of
   `CompletionPathItems.itemOrder` (`schema.cds:477`) / `GroupPathItems.itemOrder` (`:491`).

2. **Admin UI** (`app/admin-annotations.cds`) — mirror `CompletionPathItems`:
   - `annotate AdminService.CompletionPaths { pathOrder @Common.Label: 'Order'; }`
   - Add `{ Value: pathOrder, Label: 'Order' }` as the **first** `LineItem` column (the current
     CompletionPaths LineItem is `[name, slug]` — `admin-annotations.cds:236-239`; description lives in
     `FieldGroup#General`, not the LineItem).
   - Add `PresentationVariant: { SortOrder: [ { Property: pathOrder } ] }` to the CompletionPaths
     `@UI` block (which has none today, :221-240) so the admin list sorts by it.

3. **Auto-numbering for new paths:** add a `setPathOrder` handler mirroring `setGroupItemOrder`
   (`admin-service.js:1129-1140`) — on `before('NEW','CompletionPaths.drafts')` and
   `before('CREATE','CompletionPaths')`, if `pathOrder` is null, set it to
   `max(pathOrder for this mission) + 10` (gap numbering).

4. **Write-path carry-through** in `admin-service.js`:
   - `copyMission` (:4038 INSERT): add `pathOrder: p.pathOrder` when cloning each path.
   - `promoteCommunityToMission` (:3928 INSERT): the single "Default" path gets `pathOrder: 10`.

5. **Read sites** — add path ordering `.orderBy('pathOrder', 'name')` (tiebreaker `name` to match the
   backfill intent, so NULL and explicit orders interleave predictably):
   - `packages/content/catalog-data.js:182` → `.orderBy('pathOrder', 'name')` (mission SSR).
     Must also add `pathOrder` to the `.columns('ID','name','slug','legacyId')` list there.
   - `srv/lib/build-catalog.js:22` → `.orderBy('mission_ID', 'pathOrder', 'name')` (cross-mission catalog).
     This query has **no `.columns()`** (selects all), so `pathOrder`/`mission_ID` are already present —
     only the orderBy changes.
   - **`srv/developer-service.js:675` (`getAppSpaceProgress`)** → `.orderBy('pathOrder', 'name')` —
     **this is the real `/app-space/?eventId=…` learner page.** It is a standalone
     `SELECT.from(CompletionPaths).where({mission_ID}).orderBy('legacyId')` (:673-675) whose result is
     mapped verbatim at :731, so this single query sets the path/track render order on the app-space
     page. It does **not** go through `event-path-buckets.js`.
   - **`srv/developer-service.js:562-564` (`getEventProgress`)** → same change, for ordering parity on
     the admin/event-progress view (identical `.orderBy('legacyId')` query).
   - `srv/lib/branch/mission-detail.js:40` → `.orderBy('pathOrder', 'name')` so the `paths[0]`
     "primary path" is the admin's ordered-first path. (NB: today this query has **no** orderBy at all —
     `paths[0]` is currently undefined DB order; the change makes "primary" deterministic. Combined with
     the alphabetical backfill, the primary path of existing **branching** missions becomes the
     alphabetically-first path on deploy — Tom accepted this one-time shift.)
   - `assembleMissionHierarchy` (`catalog-mission-hierarchy.js`) needs **no code change** — it
     preserves caller-supplied `paths` order (verified JSDoc :92-94 + `.map` :150). Update its JSDoc
     comment that says paths order by `legacyId` → `pathOrder`/`name` (comment only).
   - **NOT changed** (path render order irrelevant): `srv/lib/event-path-buckets.js` — its rendered
     bars are deliberately **sorted by completion count** (`computePathBuckets:207`
     `.sort((a,b)=>b.count-a.count)`), the analytics/display-monitor surface, NOT the app-space learner
     page; `navigator-catalog.js:216` and `joule-tool.js:166` (fetch paths into a Map / for ID
     collection only); the flat export `exports/completion-path.js` (`legacyId`-ordered row dump).

6. **Backfill migration (existing HANA rows):** rank each mission's existing paths by `name` A→Z and
   assign `pathOrder` 10,20,30… per mission. Idempotent (only sets rows where `pathOrder IS NULL`).
   Delivered as a repair/migration script following the existing
   `scripts/repair-mission-completion-path-data.cjs` convention (dry-run/commit/verify-only modes,
   `.migration-data` JSONL snapshot, `npx cds bind --exec -- node scripts/…` invocation), with a hybrid
   test. Rationale for alphabetical (Tom's call): author-meaningful and stable, unlike `legacyId`; the
   read-site tiebreaker is also `name` so pre- and post-backfill behavior agree.

7. **Tests** (TDD — write first, watch fail, then implement):
   - Unit: `setPathOrder` gap-numbers correctly (first path → 10, next → 20; respects explicit value).
   - Unit: `catalog-data` + `build-catalog` emit paths in `pathOrder` then `name` order (in-memory SQLite).
   - Unit: `getAppSpaceProgress` returns paths in `pathOrder` then `name` order.
   - Unit: `mission-detail` picks the `pathOrder`-first path as `paths[0]`.
   - Unit: `copyMission` preserves `pathOrder`.
   - Hybrid: backfill script ranks alphabetically per mission and is idempotent (real HANA via
     `cds bind --exec`).

## Left to the builder

- Whether to mirror the orderBy into `getEventProgress` (:562-564) as well as `getAppSpaceProgress`
  — design says yes (parity); builder confirms it's the same shape and harmless.
- Migration script filename (`scripts/backfill-completion-path-order.cjs` suggested) and npm-script
  wiring (follow the repair-script precedent).
- Confirm the draft_admin_integrity #2909 discard-reconcile hooks (`admin-service.js:1278-1310`) are a
  no-op for path order (they fire user-state rollups only; builder-check already indicates no-op).

## Rollout

1. PR to `DEV` with schema + annotations + handlers + read-site sorts + tests.
2. Deploy to DEV via **full** `npm run deploy -- --env dev` (no `--skip-build`, no `-m`).
3. Run backfill script against DEV HANA.
4. Content rebuild (`gh workflow run rebuild-content.yml -f mode=full`) so mission SSR/catalog BLOBs
   bake with the new order. (App-space + branching mission pages reflect it at runtime without rebuild.)
5. Verify in-browser (authed dev session): admin UI shows editable Order + sorts; reordering a
   mission's paths changes the mission page and the `/app-space/?eventId=…` page order.
