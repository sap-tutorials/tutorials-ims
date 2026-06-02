# Search "Options" Filter — Design

**Status:** Approved
**Issue:** [sap-tutorials/tutorials-ims#175](https://github.com/sap-tutorials/tutorials-ims/issues/175)
**Date:** 2026-06-01

## Problem

The legacy AEM-hosted Tutorial Navigator (`developers.sap.com/tutorial-navigator.html`) ships a small filter group titled **"Options"** with three toggle switches: **New tutorials**, **No license**, **Community**. Our Hugo + Vue replacement at [`hugo-apps/src/navigator/TutorialNavigator.vue`](../../../hugo-apps/src/navigator/TutorialNavigator.vue) does not surface these toggles, so users coming from the legacy URL lose access to filters they relied on.

Scope decision: ship parity for **New tutorials** and **No license** only. **Community** is out of scope — it would require modeling tutorial source-repo as a first-class facet, and the value to users is unclear now that the community repo's tutorials already mix into the main catalog.

## Goals

- Restore parity with the legacy "Options" toggles for the two we are shipping.
- Keep visual uniformity with the rest of the navigator's filter panel — no new control vocabulary.
- Persist toggle state in the URL so filtered views are shareable and back/forward-friendly.
- No data migration. No content republish.

## Non-goals

- The **Community** toggle (deferred; out of scope).
- Adding facet counts (e.g. "(247 new)") next to the toggles. They are binary post-filters, not faceted selections.
- Adding the toggles to the toolbar count bar at [`TutorialNavigator.vue:721`](../../../hugo-apps/src/navigator/TutorialNavigator.vue#L721) — that bar is a Type-quick-filter convenience, not a global toggle home.
- Server-side `tagBag NOT LIKE '%tutorial>license%'` filtering. The license post-filter runs client-side; HANA fuzzy-search matching `NOT LIKE` against `tagBag` defeats the indexed search column and is an anti-pattern for this view.

## UX

The two new toggles render as two more checkbox rows inside the existing **Type** column at [`TutorialNavigator.vue:707`](../../../hugo-apps/src/navigator/TutorialNavigator.vue#L707), separated from the type values by a thin divider:

```
Type
─────
☐ Mission
☐ Group
☐ Tutorial
─────────  ← thin divider
☐ New tutorials
☐ No license
```

- Both toggles default off.
- Both compose AND with all other filters.
- Visual style matches the existing `.filter-option` checkbox rows — no toggle-switch affordance, deliberately, so the navigator's filter panel keeps a single control vocabulary.
- The corner NEW badge already rendered on cards stays unchanged. The "New tutorials" toggle merely narrows the list.
- The license chip rendering and `requiresLicense()` exclusion logic in [`hugo-apps/src/shared/license.ts`](../../../hugo-apps/src/shared/license.ts) are unchanged.

### URL persistence

| State | URL |
|-------|-----|
| Both off (default) | params omitted |
| New tutorials on | `?new=1` |
| No license on | `?noLicense=1` |
| Both on | `?new=1&noLicense=1` |

Read/write through `URLSearchParams` so `new` (a JS reserved word) is only ever a string key, never a property name. localStorage mirrors the same keys, with URL-as-source-of-truth on load — same pattern the navigator already uses for `filters.types` and `filters.experience`.

## Data flow

Two distinct query paths in the navigator. Both already exist; both need a small extension.

### Browse mode (no search term)

Client-side filter against `_nav.json` + `/build/navigator`.

- **`item.isNew`** — already attached to every nav item at [`TutorialNavigator.vue:402`](../../../hugo-apps/src/navigator/TutorialNavigator.vue#L402) and [`:535`](../../../hugo-apps/src/navigator/TutorialNavigator.vue#L535) by the existing `isWithinNewWindow()` helper using a 31-day window from `NEW_BADGE_WINDOW_MS` at [`TutorialNavigator.vue:316`](../../../hugo-apps/src/navigator/TutorialNavigator.vue#L316). No data work.
- **License signal** — `displayTagSlugs[]` is already on every nav item; reuse [`requiresLicense()`](../../../hugo-apps/src/shared/license.ts#L12).
- Filtering happens in the existing `filteredItems` computed — single place to extend.

### Search mode (term ≥ 2 chars)

Server-side via `SearchService` in [`srv/search-service.cds`](../../../srv/search-service.cds) and [`srv/search-service.js`](../../../srv/search-service.js).

- **`SearchableItems` projection** — at [`db/views.cds:75-109`](../../../db/views.cds#L75-L109) does not project `createdAt` today. We add it. The column already exists on the underlying `Tutorials` / `Missions` / `CompletionPaths` entities; the change is purely a projection alias addition.
- **`searchableItems` entity in the service definition** — at [`srv/search-service.cds`](../../../srv/search-service.cds) gains `createdAt: Timestamp` so the field is exposed to OData consumers.
- **New tutorials toggle** — when `isNew=true`, [`useSearch.ts`](../../../hugo-apps/src/navigator/useSearch.ts) appends `createdAt gt <now-31d-ISO>` to the OData `$filter` it builds. The 31-day cutoff is computed once per request in JS (matching the constant from `TutorialNavigator.vue`, so the two stay in lockstep — see "Shared constant" below).
- **No license toggle** — when `noLicense=true`, [`useSearch.ts`](../../../hugo-apps/src/navigator/useSearch.ts) post-filters the response page client-side using `requiresLicense()`. Since the search is paged at `$top=20`, post-filtering one page at most prunes 20 rows — cheap and avoids the HANA fuzzy-search anti-pattern of `tagBag NOT LIKE '%tutorial>license%'`.

### Shared constant

The 31-day window must match between the badge logic in `TutorialNavigator.vue` and the OData filter in `useSearch.ts`. Today the constant is private to the Vue file. We extract it into a new `hugo-apps/src/shared/freshness.ts` exporting `NEW_WINDOW_MS` and `isWithinNewWindow()`; both `TutorialNavigator.vue` and `useSearch.ts` import from there. Keeping freshness logic separate from `license.ts` avoids overloading that module with semantically unrelated concerns.

## Components touched

| File | Change |
|------|--------|
| [`hugo-apps/src/navigator/TutorialNavigator.vue`](../../../hugo-apps/src/navigator/TutorialNavigator.vue) | Add 2 checkboxes under Type with a divider; extend the `filters` reactive object with `isNew: boolean` and `noLicense: boolean`; extend `filteredItems` computed; extend URL sync to read/write `new` and `noLicense` query params |
| [`hugo-apps/src/navigator/useSearch.ts`](../../../hugo-apps/src/navigator/useSearch.ts) | Accept `{ isNew, noLicense }` in search options; append `createdAt gt …` to the OData filter when `isNew`; client-post-filter the response page with `requiresLicense()` when `noLicense` |
| [`db/views.cds`](../../../db/views.cds) | Add `createdAt` to the `SearchableItems` projection (additive; aliasing 3 underlying entity columns) |
| [`srv/search-service.cds`](../../../srv/search-service.cds) | Add `createdAt: Timestamp` to the projected entity |
| [`srv/search-service.js`](../../../srv/search-service.js) | None expected. The `after READ` strip-list at [`search-service.js:119-128`](../../../srv/search-service.js#L119-L128) already strips `bodyText` and `_searchRank`; `createdAt` should pass through unchanged. Re-verify during implementation |
| New shared constant | Either a new `hugo-apps/src/shared/freshness.ts` exporting `NEW_WINDOW_MS` or extend the existing `license.ts` |

## What we are NOT doing

- Not adding `getFacets` counts for the toggles. They are binary, not faceted.
- Not changing the existing NEW badge ribbon, license chip rendering, or `requiresLicense()` semantics.
- Not adding the toggles to the toolbar count bar.
- Not implementing the **Community** toggle.
- Not adding feature flags. Schema change is additive; URL is backward-compatible.

## Edge cases

- **Null `createdAt` on legacy rows.** Some imported tutorials from the IMS migration may have null `createdAt`. The existing `isWithinNewWindow()` helper returns `false` for null → toggle hides them. Consistent with how the NEW badge already behaves. Documented; no migration.
- **License slug renames.** `LICENSE_SLUG = 'tutorial>license'` is a single-source-of-truth constant in [`hugo-apps/src/shared/license.ts:5`](../../../hugo-apps/src/shared/license.ts#L5). If AEM-style slugs are ever renamed, one constant changes.
- **Both toggles + active search term + other filters.** Compose with `filters.taskType`, `filters.experience`, `filters.topics`, `filters.products` via AND. Verified in unit tests.
- **Browse mode performance.** Nav data is loaded once at boot; toggling is instant — no extra fetch.
- **URL key safety.** `new` is a JS reserved word. We never use it as an object key — only as a `URLSearchParams` string key. Safe.
- **QA channel.** Both data signals (`isNew`, `displayTagSlugs`) exist in the QA srv. The `db/views.cds` change is shared. No QA-specific gating; no `srv-qa` cp-list addition needed (no new file imports).

## Testing

Three workspaces, matching `vitest.config.ts`:

| Workspace | Test | File |
|-----------|------|------|
| **unit** | `useSearch.test.ts` extensions: (1) `{ isNew: true }` appends `createdAt gt …` to the OData filter with the correct ISO timestamp; (2) `{ noLicense: true }` strips license-tagged rows from the response page; (3) both flags compose correctly | [`hugo-apps/src/navigator/useSearch.test.ts`](../../../hugo-apps/src/navigator/useSearch.test.ts) |
| **unit** | `TutorialNavigator.test.ts` extensions: (1) checkbox change updates `filters.isNew`/`filters.noLicense`; (2) URL query params `?new=1&noLicense=1` round-trip through `URLSearchParams`; (3) `filteredItems` correctly post-filters in browse mode for both flags individually and combined | [`hugo-apps/src/navigator/TutorialNavigator.test.ts`](../../../hugo-apps/src/navigator/TutorialNavigator.test.ts) |
| **hybrid** | New: verify `SearchableItems` projects `createdAt` against real HANA, and `$filter=createdAt gt <ts>` returns the expected subset. Read-only — no `__TEST__` data needed | new file `test/hybrid/search/options-filter.test.js` |
| **smoke** | Extend existing search smoke to assert `SearchableItems` includes `createdAt` and accepts the filter | [`test/smoke/search.smoke.test.js`](../../../test/smoke/search.smoke.test.js) |

## Rollout

- Schema change is additive (one new field on a projection). Safe to deploy in any order.
- No data migration. No content republish needed.
- Backward-compatible URLs: existing share links without `new`/`noLicense` params keep working.
- After deploy, smoke test passes → done. No feature flag.

## Notes for the planner

- During implementation, explicitly verify the `after READ` strip-list at [`srv/search-service.js:119-128`](../../../srv/search-service.js#L119-L128) does not strip `createdAt`. If it does, add an exception. Either decision should be made deliberately and called out in the plan, not deferred.
- The hybrid test is read-only; do not set `ALLOW_HYBRID_WRITES=true` for it. The guard in [`test/hybrid/_guard.js`](../../../test/hybrid/_guard.js) only needs to gate INSERT/UPDATE/DELETE, which this test won't perform.

## Open questions

None at design time.
