# U16 Mission Side-Navigation — Design

**Date:** 2026-05-22
**Branch (planned):** `ui-pilot/u16-mission-side-nav`
**Status:** Proposed
**Series:** UI follow-ups (U16). Continuation of the U0–U15 pilot pattern.

## Context

Tutorial pages on the U1 Object Page layout currently render a Vue-based "mini navigator" in the right column. The Vue island lives at [hugo/static/js/mini-navigator.js](hugo/static/js/mini-navigator.js) and is mounted from the partial [hugo/layouts/partials/mini-navigator.html](hugo/layouts/partials/mini-navigator.html). The partial renders a static `<aside class="mini-nav">` from Hugo frontmatter (group's tutorial list), and the Vue island fetches `/api/missions/<id>/navigation` to overlay the full mission tree with per-tutorial progress.

Two problems with the current state:
1. The Vue island is the only Vue 3 dependency surfaced inside the Object Page layout — every other client-side feature on U1 (U10 toast, U11 progress, U12 reader, U13 mermaid, U14 skeletons, U15 lightbox) uses UI5 web components and TS modules. The mini-navigator is the odd one out.
2. The static fallback only shows the *current group's* tutorials — not the full mission. The Vue island shows the full mission, but only after hydration, causing a brief flash where the user sees a smaller list that then expands.

The improvements.md backlog (line 431) calls for a `ui5-side-navigation` drawer "showing all tutorials in the current mission with completion icons". The U14 spec already coined the branch name `u16-mission-drawer`. Tom selected option A in brainstorming: **replace** the right-column mini-navigator with `<ui5-side-navigation>` rather than adding it as a new surface.

## Goals

1. Replace the right-column Vue mini-navigator with a `<ui5-side-navigation>` rendered statically from Hugo frontmatter showing the full mission tree on first paint.
2. Add per-tutorial progress bars (option C from completion-icons brainstorm) showing partial completion (`completedSteps / totalSteps`) sourced from `/api/missions/<id>/navigation` after auth.
3. Persist per-mission expand/collapse state to `localStorage` keyed by `missionId` so revisits restore the user's preferred view.
4. On first visit (no localStorage entry), expand only the group containing the current tutorial; all other groups collapsed.
5. Preserve existing responsive behavior: side-nav stacks below main content under 960px (no new mobile drawer mode in this pilot).
6. Delete the Vue mini-navigator (`mini-navigator.js`, `mini-navigator.html`) entirely — no half-finished migration.

## Non-goals

- Mobile slide-in drawer mode (option C from placement brainstorm — deferred to a future pilot if needed).
- Cross-mission browsing (the side-nav is scoped to the current mission only).
- Deep-link expand state in URL hash (localStorage only).
- Per-step granularity — progress bar reflects tutorial-level completed steps, not which specific steps are done.
- Stale-then-fresh localStorage caching of progress data (Approach 3 from brainstorm) — fetch is fast enough.
- Automated tests. Pilot is presentational; verification is manual via Hugo dev server. `npm test` (unit) must remain green.
- New dependencies. Uses already-imported `@ui5/webcomponents` plus a new side-navigation side-effect import.

## Architecture

### File map

| Path | Action | Purpose |
|---|---|---|
| `hugo/layouts/partials/mission-side-nav.html` | NEW | Renders `<ui5-side-navigation>` from frontmatter (mission title, groups, tutorials, current-item highlight) |
| `hugo/assets/js/mission-side-nav.ts` | NEW | Hydrates progress bars from `/api/missions/<id>/navigation`, manages localStorage expand state, handles toggle persistence |
| `hugo/assets/css/mission-side-nav.css` | NEW | Wrapper sizing, header bar, progress-bar overlay, max-height + overflow scroll |
| `hugo/layouts/tutorials/u1-object-page.html` | EDIT | Swap `{{ partial "mini-navigator.html" . }}` → `{{ partial "mission-side-nav.html" . }}` |
| `hugo/assets/js/ui5-bootstrap.ts` | EDIT | Add side-effect import for `@ui5/webcomponents-fiori/dist/SideNavigation.js` and item/sub-item modules; import `mission-side-nav.ts`; import `mission-side-nav.css` |
| `hugo/layouts/partials/mini-navigator.html` | DELETE | Replaced by mission-side-nav.html |
| `hugo/static/js/mini-navigator.js` | DELETE | Replaced by mission-side-nav.ts (no Vue dependency on tutorial layouts) |
| `hugo/assets/css/sap-fundamental.css` | EDIT | Remove `.mini-nav*` rules (the source file for PostCSS) |
| `hugo/static/css/sap-fundamental.css` | REGEN | Build artifact from `npm run build:css` — committed alongside the source edit |

### Rendered structure

```html
<aside class="mission-side-nav-wrap">
  <div class="msn-header">
    <a href="/tutorials/mission-{{ missionSlug }}/">{{ missionTitle }}</a>
  </div>
  <ui5-side-navigation
    data-mission-nav
    data-mission-id="{{ missionId }}"
    data-mission-slug="{{ missionSlug }}"
    data-current-slug="{{ currentTutorialSlug }}">

    <ui5-side-navigation-item text="{{ groupTitle }}" data-group-slug="{{ groupSlug }}" expanded>
      <ui5-side-navigation-sub-item
        slot="items"
        text="{{ tutorialTitle }}"
        href="/tutorials/{{ tutorialSlug }}/"
        data-tutorial-slug="{{ tutorialSlug }}"
        selected="{{ if eq tutorialSlug currentTutorialSlug }}true{{ end }}">
      </ui5-side-navigation-sub-item>
      <!-- per tutorial in group -->
    </ui5-side-navigation-item>
    <!-- per group in mission -->
  </ui5-side-navigation>
</aside>
```

The exact attribute name for the active sub-item (`selected` vs `is-selected`) and the slot capability of `<ui5-side-navigation-sub-item>` for the progress bar will be verified against `mcp__ui5-webcomponents__get_component_api componentName=ui5-side-navigation` during plan write-up. If no progress slot exists, fallback is to overlay a positioned `<div class="msn-progress">` inside the item via CSS (light DOM child of the sub-item).

### Data flow

**Build time** (Hugo, in `mission-side-nav.html`):
1. Read tutorial page params: `missionId`, `missionSlug`, `slug` (current tutorial)
2. Look up the mission page: `$mission := site.GetPage (printf "/tutorials/mission-%s" .Params.missionSlug)` — returns the page generated by `scripts/fetch-tutorials.ts:435 writeMissionPage()` with full `groups: [...]` tree
3. Iterate `$mission.Params.groups` → for each group, iterate `tutorials` → emit `<ui5-side-navigation-item>` + `<ui5-side-navigation-sub-item>` markup
4. Mark the current tutorial's sub-item with `selected`
5. Empty progress bars rendered with `data-progress="0"` placeholder

**Runtime** (`mission-side-nav.ts`):
1. `customElements.whenDefined('ui5-side-navigation').then(...)` — wait for UI5 hydration (per [[feedback_ui5_dialog_open_property]] / U10 lesson on guarding UI5 calls)
2. Read `data-mission-id` from the nav element
3. Apply localStorage expand state: read `mission-nav-expanded:<missionId>` (JSON `{ groupSlug: boolean }`), set `expanded` on each group item accordingly. Missing keys keep server-rendered default.
4. `fetch('/api/missions/<id>/navigation', { credentials: 'include' })` — same endpoint Vue island uses today
5. For each tutorial in response, find `[data-tutorial-slug="<slug>"]` and update its progress bar width: `(completedSteps / totalSteps) * 100`
6. Wire a single delegated listener on the nav root for the UI5 expand/collapse event; on toggle, read current expanded state of all groups and persist the full object to localStorage.

### localStorage shape

**Key:** `mission-nav-expanded:<missionId>`

**Value:**
```json
{ "<groupSlug>": true, "<otherGroupSlug>": false }
```

Only explicitly-toggled groups appear. Missing keys fall back to default (current group expanded, others collapsed).

**Quota safety:** all reads/writes wrapped in `try/catch` — private mode and quota errors silently fall back to defaults. Worst-case storage: ~150 bytes per visited mission.

## Edge cases

| Case | Behavior |
|---|---|
| Tutorial outside any mission (`missionId` empty) | Partial emits nothing — `<aside>` not rendered, right column shows only `tutorial-sidebar.html` |
| Mission page not found (`mission-<slug>.md` missing) | Partial guards with `with $mission := ...` and skips rendering. No build break. |
| Current tutorial not in mission's tutorial list (data drift) | Static render: no item gets `selected`. Runtime: progress bars still update on matching items. |
| Empty group (zero tutorials) | Skip the `<ui5-side-navigation-item>` entirely |
| localStorage parse failure (corrupted JSON) | `try/catch` around `JSON.parse` — fall back to default expand state |
| UI5 component fails to load | Inert markup renders as nested `<ui5-side-navigation-sub-item>` elements; minimal CSS fallback keeps it readable. `customElements.whenDefined` never resolves; progress bars stay at 0%. |
| `/api/missions/<id>/navigation` 401/network error | Catch rejection, log to console, leave progress bars at 0%. Nav remains usable for navigation. |
| Below 960px | Existing `tutorial-right-col` CSS rule drops the right column under main. `<ui5-side-navigation>` inherits that. |
| Long mission with 8+ groups | `<ui5-side-navigation>` is internally scrollable. Max-height capped at `calc(100vh - 200px)` via CSS. |

## Verification plan

Manual browser checks against local hybrid (`npm run dev:hybrid`):

1. Tutorial inside a mission → side-nav renders with mission title, all groups, current tutorial highlighted as `selected`
2. First visit (cleared localStorage): only current group expanded; other groups collapsed
3. Toggle a different group → it expands; reload page → expand state preserved
4. Switch to a different mission → its own localStorage entry is used; previous mission's state independent
5. Per-tutorial progress bars hydrate after auth: completed = 100%, partial = fractional, untouched = 0%
6. Click any sub-item → navigates to `/tutorials/<slug>/`
7. Tutorial outside a mission (no `missionId`) → no side-nav, only existing `tutorial-sidebar.html` visible
8. Resize below 960px → side-nav stacks below content; resize back → returns to right column
9. Theme toggle (light/dark) → side-nav follows Horizon theme correctly
10. Logged-out (clear cookies + reload) → static structure renders, progress bars stay at 0%, no console errors

**Console checks:**
- No errors from `customElements.whenDefined`
- No 4xx/5xx from `/api/missions/<id>/navigation` for authed user
- localStorage entry visible in DevTools after toggling a group

**Visual regression (eyeball):**
- U1 Object Page layout still works (no extra horizontal scroll, sticky behavior preserved)
- Existing `tutorial-sidebar.html` (the second right-column partial below the side-nav) still renders

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| `<ui5-side-navigation-sub-item>` doesn't expose a slot for the progress bar | Overlay a positioned `<div class="msn-progress">` as a light DOM child via CSS (verified during plan write-up via UI5 MCP) |
| UI5 v2.x API drift on selected-item attribute name | Verify against `mcp__ui5-webcomponents__get_component_api` before writing site code (per [[feedback_ui5_dialog_open_property]] lesson) |
| Vue mini-navigator deletion breaks an unknown caller | Grep `mini-navigator-mount`, `mini-navigator.js`, `MiniNavigator` import paths; remove all references in same PR |
| `/api/missions/<id>/navigation` response shape diverges from current Vue assumption | Add a runtime guard: skip progress update if response shape doesn't match expected `{ groups: [{ tutorials: [{ slug, completedSteps, totalSteps }] }] }` |
| FOUC: side-nav renders unstyled before UI5 hydration | Existing UI5 components on U1 (tabcontainer, rating, message-strip) tolerate this fine — same pattern, same outcome |

## Related work

- Predecessor pilots: [[project_u14_skeletons]], [[project_u15_lightbox]]
- UI5 v2.x lesson applies: [[feedback_ui5_dialog_open_property]]
- Worktree pattern: [[feedback_parallel_agents_worktrees]]
- Cross-page TS module pattern: [[project_u11_progress]] (gated on DOM presence in `ui5-bootstrap.ts`)
