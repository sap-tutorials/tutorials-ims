# Design: Temporarily-Unavailable at the Path-Item (Tutorial) level — rework of #2864

**Issue:** https://github.com/sap-tutorials/tutorials-ims/issues/2864
**Date:** 2026-10-21
**Author:** Tom (via Claude Code)

## Intent / the why

Ops needs a **quick kill-switch** to pull a **single tutorial inside a mission's
completion path** out of circulation the moment it breaks or its backend goes
down for maintenance — without editing source repos or running a destructive
retire. The tutorial's row stays **visible** so users understand the gap is
deliberate and temporary (greyed out + a "Temporarily Unavailable" badge, with
the reason as a tooltip), but its link is **not clickable** while flagged.
Flipping the flag back restores the link. Because the real surface is served
live from HANA, the effect is **instant** — no content rebuild.

#2864 was first built at the **Mission header** level
(`Missions.temporarilyUnavailable`), which disables an entire mission — too
coarse to be useful. This reworks it to the correct granularity: the individual
**path item** (`CompletionPathItems` row — the `Order / Type / Task` rows in the
admin mission editor's "Path Items" table).

## Goals

- A per-path-item `temporarilyUnavailable` boolean + `unavailableReason` string
  on `CompletionPathItems`.
- Admin flips the toggle + edits the reason on the **path-item row's detail form**
  (annotation-only; not inline in the table).
- On the public **SSR mission landing page** (`/tutorials/mission-<slug>/`), a
  disabled path item renders **greyed out, not clickable, with a "Temporarily
  Unavailable" badge** and the reason surfaced as a **tooltip/aria-label**; the
  rest of the path and the mission stay fully live. Effect is **instant** on the
  next page load after the toggle — no rebuild.
- The mission-level flag and ALL its wiring are **removed** (Tom: "It doesn't
  logically make any sense").

## Non-goals / anti-goals

- **Not** a content-retire. Content is NOT removed from HANA; only the link is
  suppressed and the row is styled.
- **Not** the tutorial-page right-rail **side nav** (`mission-side-nav.html`):
  its plain per-tutorial loop is **dead at runtime** (mission pages are SSR'd,
  `site.GetPage` returns nil, `$groups` is empty) and it renders only alt-group
  branches live. v1 targets the SSR mission landing page only. If a disabled
  tutorial still shows clickable in the side-nav's alt-group branches, that's a
  tracked follow-up, not v1 scope.
- **Not** Groups' `GroupPathItems` (missions only, per the issue + screenshot).
- **Not** the `/build/mission/:slug` alt-group feed render in v1 (see follow-up).
- Do **not** touch the PROD flow or deploy anything as part of the PR.

## Constraints (verified against live code — load-bearing)

1. **The live per-tutorial links on the mission page come from SSR, not baked
   frontmatter.** `/tutorials/mission-<slug>/` is server-rendered by
   `packages/content/catalog-renderer.js` `renderMission`, fed by
   `packages/content/catalog-data.js` `loadMissionContext`, which **already
   SELECTs `CompletionPathItems` at request time** (`catalog-data.js:192`). This
   is why the flag can be honored **instantly** with no rebuild. (The design's
   first draft wrongly assumed static-frontmatter rows via
   `mission-side-nav.html:74` — that loop is dead at runtime; corrected here.)
2. **The shared hierarchy helper drops per-item data.**
   `packages/content/catalog-mission-hierarchy.js` `assembleMissionHierarchy`
   collapses each `CompletionPathItems` row to identity strings
   (`directTutorialIdentities` / `tutorialIds`), discarding the row. The tutorial
   objects in `groups[].tutorials[]` are projected from the `Tutorials` row keyed
   by `tutorial_ID`, with no back-link to the path item. So the new flag must be
   correlated in separately (see Part D). **The correlation key is the path item,
   not the tutorial** — the same tutorial can appear in multiple paths/missions,
   so a `Map` keyed by `tutorial_ID` alone is wrong; key by `(path_ID,
   tutorial_ID)` or the path-item ID in mission context.
3. `/build/mission/:slug` (`srv/lib/branch/mission-detail.js`) is a separate
   alt-group/branching overlay feed. It currently carries the mission-level early
   return (646d9b9e0) that must be reverted.
4. The admin Path Items table is **Fiori Elements annotation-driven**; its
   Type/Task columns are custom-wired manifest fragments. Editing the new
   Boolean/String on the **path-item Object Page / FieldGroup** is annotation-only
   (chosen); inline-in-table would need manifest + fragment work (rejected).
5. Project rules: feature PRs target **DEV** (not main); open a PR, never
   direct-merge; TEST THE ACTUAL THING before calling it done.

## How it's built (the decided parts)

### Part A — Revert the mission-level feature

My call: manual reversal, not `git revert`, since we're replacing not just
undoing — keeps one coherent PR. Remove `temporarilyUnavailable` /
`unavailableReason` and all wiring from the **Missions** path:

- `db/schema.cds:89-90` — drop the two fields from `entity Missions`.
- `db/views.cds:97` — drop the `mission.temporarilyUnavailable` filter clause.
- `srv/lib/navigator-catalog.js:223` — drop the column + the
  `temporarilyUnavailable != true` where-filter.
- `srv/lib/branch/mission-detail.js:40-44` — remove the mission-level early return.
- `srv/lib/build-catalog.js:63` — remove the field emit.
- `scripts/fetch-tutorials.ts` + `scripts/parsers/types.ts` — remove the
  mission-level `temporarilyUnavailable`/`unavailableReason` emit on the mission
  card literal.
- `hugo-apps/src/shared/cards/MissionCard.vue`, `hugo-apps/src/shared/types.ts`,
  `hugo/layouts/partials/browse/_partials/card-mission.html` — remove the
  mission-card badge markup + type field. **Keep** the
  `.nav-card__unavailable-badge` CSS rule in `card.css:210` (reused by Part D).
- `app/admin-annotations.cds:130-131,154,172-173` — remove the mission-level
  labels + LineItem/FieldGroup entries.
- `srv/page-fallback/page-browse.html`, `page-tutorial-navigator.html` — remove
  mission-level references.
- Delete tests `test/unit/srv/mission-detail-unavailable.test.js` and
  `test/unit/srv/navigator-catalog-unavailable.test.js`; revert the mission-badge
  fixtures/cases in `scripts/__tests__/fetch-tutorials-browse-channel.test.ts`,
  `hugo-apps/.../cards.fixtures.json`, and the regenerated `*.expected.html`.
- `db/` migration tables (`Missions.hdbmigrationtable`, `last-dev/csn.json`) —
  regenerate (follow bad6118e1's convention) so the dropped columns produce a
  correct migration.
- Leave generated `hugo/public*/**` artifacts to be overwritten by the next
  `build:all`; do not hand-edit them.

### Part B — Add the flag to `CompletionPathItems`

- `db/schema.cds` `entity CompletionPathItems` (~:471): add
  `temporarilyUnavailable : Boolean default false;` and
  `unavailableReason : String(500);`.
- `srv/admin-service.cds:448-457` — surface both in the `CompletionPathItems`
  projection.
- Regenerate migration table for `CompletionPathItems` + `last-dev/csn.json`.

### Part C — Admin UI (Fiori Elements, annotation-only, row detail form)

- `app/admin-annotations.cds`:
  - Add field labels: `temporarilyUnavailable` → 'Temporarily Unavailable',
    `unavailableReason` → 'Unavailable Reason' (`@UI.MultiLineText`).
  - Add both as `{ Value: ... }` entries to the `CompletionPathItems`
    **FieldGroup / Facets** (the path-item detail form at `:311-331`), NOT to the
    table LineItem. This gives an editable toggle + reason when the admin opens a
    path-item row's detail.
- No manifest or custom-fragment change (confirmed: detail-form Boolean/String is
  plain FE).

### Part D — SSR mission page: suppress link + badge + tooltip (instant)

- `packages/content/catalog-data.js` `loadMissionContext`: the function already
  SELECTs `CompletionPathItems` (`:192`). Also select the two new columns, and
  build a correlation keyed by **path item** (`(path_ID, tutorial_ID)` or
  path-item ID), then stamp `temporarilyUnavailable` + `unavailableReason` onto
  each tutorial object it emits into `groups[].tutorials[]`. If
  `assembleMissionHierarchy` (`catalog-mission-hierarchy.js`) sits between the
  SELECT and the tutorial projection, thread a parallel per-path-item map through
  it (widen its output) rather than re-keying by tutorial_ID alone — Constraint #2.
- `packages/content/catalog-renderer.js` `renderMission` (per-tutorial `<a
  href>` emit, mirror of the group path at `:125`/`:137`): when the tutorial's
  `temporarilyUnavailable` is set —
  - render the title **without** an `<a href>` (or as a non-navigable element),
    so the row is not clickable but the text stays visible;
  - add a greyed/disabled CSS class to the card;
  - emit a **"Temporarily Unavailable"** badge reusing the
    `.nav-card__unavailable-badge` visual conventions;
  - set a `title`/`aria-label` (tooltip) to `unavailableReason` when present, so
    users see why.
- Add the greyed-out + disabled-row CSS (badge class already exists; add a
  disabled-card rule in the SSR page's stylesheet, matching Horizon).

### Part E — GraphQL

- `srv/graphql/schema.graphql`: regenerate via the existing `npm run build:sdl`
  so the new `CompletionPathItems` fields appear. Do not hand-edit.

## Tests (TDD — the actual thing, per Tom's #1 rule)

1. **Unit (CAP, in-memory SQLite):** admin projection exposes the two new
   `CompletionPathItems` fields and they round-trip on upsert. Replaces the
   deleted mission-level tests.
2. **SSR render unit:** given a `loadMissionContext` result with one path item
   `temporarilyUnavailable:true` (+ reason), `renderMission` emits that
   tutorial's title **without** an href, with the badge, and with the reason as
   `title`/`aria-label`; a normal item still emits a clickable `<a href>`. Assert
   on the HTML string (positive + negative). This is the load-bearing behavior
   test — it proves the kill-switch actually kills the link.
3. **loadMissionContext correlation test:** a path item flagged in one path does
   not flag the same tutorial appearing in a different path/mission (guards the
   Constraint-#2 keying bug).
4. **Regression:** full `npm test` green; mission-level tests are gone, not
   skipped.
5. **Manual/visual before "done":** `npm run dev:hybrid` (or local CAP + seed),
   flag one path item in the admin Path Items detail form, load
   `/tutorials/mission-<slug>/`, confirm the row is greyed with badge + tooltip
   and the link is dead, and un-flagging restores it live — **no rebuild**.
   Deploy is out of scope; local verify is the gate.

## What's left to the builder

- Exact CSS for the greyed/disabled card state (match Horizon + existing badge).
- Precise correlation plumbing through `assembleMissionHierarchy` vs. a direct
  correlate in `loadMissionContext` — pick the smaller-blast-radius option that
  keeps the per-path-item key (Constraint #2); update that helper's callers +
  tests if widened.
- Migration-table regeneration command sequence (follow bad6118e1).
- Follow-up (NOT v1): honor the flag in the `/build/mission/:slug` alt-group feed
  + `MissionAltGroupHighlight.vue` so the tutorial-page side-nav alt-group
  branches also grey out. File as a tracked issue if the side nav shows a stale
  clickable link for a disabled item.
