# U14 Skeleton Loaders — Design

**Date:** 2026-05-22
**Branch (planned):** `ui-pilot/u14-skeletons`
**Status:** Proposed
**Series:** UI follow-ups (U14–U19, dropped U17). Continuation of the U0–U13 pilot pattern.

## Context

Tutorial pages and Vue islands hydrate after first paint:

- `loadProgress()` ([hugo/assets/js/tutorial.ts:310-331](hugo/assets/js/tutorial.ts#L310-L331)) calls `/getProgress` and then mutates step check circles, "Mark as Done" buttons, TOC tint, and the progress bar. Until that resolves, a returning user sees an empty progress bar that pops to "5/8" a beat later.
- Vue islands — `TutorialNavigator.vue`, `AppSpace.vue`, `MyCompletions.vue`, `TutorialNavigatorDropdown.vue` — each fetch their own data and render blank space until done.

Navigations between tutorials, missions, and groups are full-page server-side reloads (AppRouter → CAP → HANA BLOB → HTML). The browser shows only its own progress UI during that window; we want a branded indicator.

## Goals

1. Eliminate the visible flicker when `/getProgress` hydrates the tutorial page (progress bar, step circles, Done buttons).
2. Show a Horizon-themed in-page skeleton for the **TutorialNavigator** Vue island while it fetches `/tutorials/_nav.json` + `/build/navigator`.
3. Provide a branded top-of-page navigation progress indicator during full-page navigation between tutorials/missions/groups.
4. Establish a shared `Skeleton.vue` component so future Vue islands (AppSpace, MyCompletions) can be skeleton'd in follow-up branches without re-deciding the visual treatment.

## Non-goals

- Skeletons for AppSpace.vue, MyCompletions.vue, CommandPalette.vue (deferred to follow-up branches).
- A SPA-style client-side navigation between tutorials. Tutorial HTML continues to be full-page server-rendered from HANA BLOBs.
- Skeleton for the tutorial HTML body itself. The HTML arrives in the document response; there is no client-side fetch to skeleton-over.
- A new dependency. No `@ui5/webcomponents` skeleton primitives, no NProgress library.
- Localized skeleton text. Skeletons have no text.

## Architecture

### File map

| Path | Action | Purpose |
|---|---|---|
| `hugo/assets/css/skeletons.css` | NEW | Shimmer keyframes; selectors for hydration targets; `.nav-progress-bar` overrides |
| `hugo/assets/js/ui5-bootstrap.ts` | EDIT | Import `skeletons.css`; import `nav-progress.ts` (cross-page, all layouts) |
| `hugo/assets/js/tutorial.ts` | EDIT | Flip `data-hydrated="true"` after `loadProgress()` resolves or after 1.5 s timeout |
| `hugo/assets/js/nav-progress.ts` | NEW | Click delegation + trickle animation + `pagehide`/`pageshow` lifecycle |
| `hugo/layouts/partials/head.html` | EDIT | Inline pre-paint script that sets `data-hydrated="false"` only on tutorial layouts |
| `hugo/layouts/partials/nav-progress.html` | NEW | The `<ui5-progress-indicator id="nav-progress">` element |
| `hugo/layouts/baseof.html` | EDIT | Include `partials/nav-progress.html` after the shellbar partial |
| `apps/src/shared/Skeleton.vue` | NEW | Shared component, props `kind`/`count`/`height` |
| `apps/src/navigator/TutorialNavigator.vue` | EDIT | Render `<Skeleton kind="card" count="6">` while `loading === true` |

No CAP / HANA / schema changes. No AppRouter changes.

### In-page skeleton flow (Hugo tutorial pages)

```
Browser parses head.html
  └─ inline script: if (html[data-page-kind="tutorial"]) html.dataset.hydrated = "false"

Body paints
  └─ skeletons.css matches html[data-hydrated="false"] .progress-segment / .step-check-circle / [data-action="mark-done"]
  └─ shimmer visible

tutorial.ts loadProgress() resolves (or timeout 1500 ms or catch)
  └─ html.dataset.hydrated = "true"
  └─ CSS transitions skeleton off; real state painted in same frame

Failure path:
  - /getProgress 401 (anonymous)        → Promise.race([fetch, timeout(1500)]) flips attribute
  - /getProgress network error          → catch flips attribute
  - tutorial.ts not loaded (broken JS)  → fallback flip in inline tail script (DOMContentLoaded + 2000 ms)
```

The fallback flip in the inline tail script is the safety net: if the bundle fails to load, the user is not stuck staring at shimmer indefinitely.

### Navigation progress bar flow

```
Document click
  └─ delegate.matches: a[href]
       not [href^="#"], not [target="_blank"], not [download]
       same-origin (URL constructor against location.origin)
       no modifier keys (cmd/ctrl/shift/alt/middle-click)
  └─ if match: showBar(); animate value 0 → 30 over 200 ms; setInterval trickle 30 → 90 over 2-6 s

pagehide (capture phase, once)
  └─ cancel trickle; jump value to 100; hide bar after 50 ms

pageshow with event.persisted === true (bfcache restore)
  └─ reset value to 0; hide immediately

Edge: hash-only or JS-prevented click
  └─ trickle starts but pagehide never fires
  └─ 100 ms grace timer: if document.visibilityState === 'visible' and no pagehide, abort + hide
```

### Vue Skeleton component

Single file, three modes:

```vue
<Skeleton kind="card"      count="6" />     <!-- card grid (TutorialNavigator) -->
<Skeleton kind="text-line" count="3" />     <!-- inline text shimmer (future use) -->
<Skeleton kind="rect"      height="240px" /> <!-- generic block (future use) -->
```

Internally renders `<div class="skeleton skeleton--{kind}">` repeated `count` times. Imports `'../../../hugo/assets/css/skeletons.css'` so Vite bundles the same shimmer rules into the islands. (Path crosses the `apps/` ↔ `hugo/` boundary — verified via `vite.config.ts` `resolve.preserveSymlinks` setting before commit.)

### CSS shimmer

```css
@keyframes skeleton-shimmer {
  0%   { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}

.skeleton,
html[data-hydrated="false"] .progress-segment,
html[data-hydrated="false"] .step-check-circle,
html[data-hydrated="false"] [data-action="mark-done"] {
  background: linear-gradient(
    90deg,
    var(--sapList_Background) 0%,
    var(--sapButton_Hover_Background) 50%,
    var(--sapList_Background) 100%
  );
  background-size: 200% 100%;
  animation: skeleton-shimmer 1.4s ease-in-out infinite;
  color: transparent;
  pointer-events: none;
}

@media (prefers-reduced-motion: reduce) {
  .skeleton,
  html[data-hydrated="false"] [data-action="mark-done"],
  html[data-hydrated="false"] .step-check-circle,
  html[data-hydrated="false"] .progress-segment {
    animation: none;
    opacity: 0.6;
  }
}
```

Dark mode follows automatically — Horizon CSS variables resolve to dark-theme tokens when `html.dark` is set ([MEMORY.md → U13 mermaid](C:/Users/I809764/.claude/projects/d--projects-tutorials-poc/memory/project_u13_mermaid.md)).

### Navigation bar element

```html
<!-- baseof.html, after shellbar partial -->
{{ partial "nav-progress.html" . }}
```

```html
<!-- partials/nav-progress.html -->
<ui5-progress-indicator id="nav-progress" hide-value value="0" class="nav-progress-bar" hidden></ui5-progress-indicator>
```

```css
.nav-progress-bar {
  position: fixed;
  top: 0; left: 0; right: 0;
  height: 3px;
  z-index: 9999;
  border: none;
  background: transparent;
  transition: opacity 200ms;
}
.nav-progress-bar[hidden] { display: block !important; opacity: 0; }   /* keep mounted, fade only */
.nav-progress-bar:not([hidden]) { opacity: 1; }
```

The CSS overrides `display: none` for hidden so the bar stays in the DOM and JS can animate `value` without re-mounting the component.

## Data flow

No new data flows. All hydration uses existing endpoints:
- `/getProgress` (already wired in `tutorial.ts`)
- `/tutorials/_nav.json` + `/build/navigator` (already wired in `TutorialNavigator.vue`)

No new server endpoints. No telemetry.

## Error handling

| Scenario | Handling |
|---|---|
| `/getProgress` fails (network) | `loadProgress()` catch flips `data-hydrated="true"` |
| `/getProgress` returns 401 (anon) | `apiGet` returns `null`; flip via early return path |
| `loadProgress()` never returns within 1.5 s | `Promise.race` with `setTimeout` flips attribute |
| `tutorial.ts` bundle fails to load (or JS disabled) | Inline tail script in `head.html` schedules a `DOMContentLoaded + 2 s` flip independent of the bundle. With JS fully disabled, the pre-paint script also doesn't run, so `data-hydrated` stays unset and CSS selectors don't match — no shimmer, default state painted. |
| Both the 1.5 s race and the 2 s inline fallback fire | Both flips set the same attribute to the same value; second is a no-op. Order does not matter. |
| Click delegate fires but navigation aborts | 100 ms grace timer + `visibilitychange` listener hides bar |
| `pagehide` not fired (rare) | `beforeunload` fallback listener |
| bfcache restore | `pageshow` with `event.persisted` resets bar to value=0 hidden |
| `prefers-reduced-motion` | CSS media query disables shimmer animation, uses static opacity instead |
| `ui5-progress-indicator` not yet defined when click fires | Guard with `customElements.whenDefined('ui5-progress-indicator')` (precedent: U10 toast — [MEMORY.md → U10](C:/Users/I809764/.claude/projects/d--projects-tutorials-poc/memory/project_u10_toast.md)) |

## Testing

### Manual smoke (PR-body checklist)

1. Cold-load a tutorial as a logged-in user with prior progress → shimmer visible briefly in progress bar / circles, transitions to filled state.
2. Cold-load same tutorial as anonymous → shimmer flips off within 1.5 s; default empty state painted.
3. Click an internal tutorial link → top progress bar appears, animates to ~90 %, completes on new page render.
4. Click an external link (`https://help.sap.com/...`) → no nav bar.
5. Click a hash link (`#step-3`) → no nav bar.
6. Cmd-click an internal link → opens new tab; no nav bar in current tab.
7. Browser back button after a previous-page nav → nav bar reset, no frozen state.
8. Toggle theme (light/dark) → shimmer color follows; nav bar still visible.
9. Mobile viewport (DevTools 375 × 667) → nav bar still visible above shellbar; shimmer scales.
10. `prefers-reduced-motion: reduce` (DevTools rendering tab) → shimmer is static opacity, no animation.
11. Browse to TutorialNavigator (`/tutorials/`) → 6 skeleton cards visible briefly, replaced by real cards.
12. Disable JavaScript → page renders with no skeleton (server HTML is final state).

### Automated

- No new unit tests (visual feature, no new logic to assert).
- Existing smoke suite (`npm run test:smoke`) continues to pass — verifies no regression in `/tutorials/*` HTTP paths.

### Verification command

`npm run dev` (with `npm run fetch-tutorials` already done), browse `/tutorials/sap-cap-create-application/` after seeding progress in DevTools.

## Risks & mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Shimmer leaks to non-tutorial pages | Low | Confusing flicker | All selectors prefixed `html[data-hydrated="false"]`; only set on tutorial layouts |
| Trickle animation visible during JS-prevented or hash-only clicks | Med | Bar flashes for no reason | 100 ms grace timer + `visibilitychange` abort |
| `pagehide` not fired in some Safari versions | Low | Bar stuck at 90 % | Also listen `beforeunload` |
| `data-hydrated` collides with future attribute | Low | Logic error | Distinct from `data-reader` (U12), `data-scrollspy` (U11), `data-page-kind` (U1) |
| `ui5-progress-indicator` design fights hairline use case | Med | Visual quirks | `hide-value`, custom CSS overrides height/border/background; tested across themes |
| Vue Skeleton CSS path crosses `apps/` ↔ `hugo/` boundary | Med | Build break | Verified before commit; if `vite.config.ts` rejects, copy CSS into `apps/src/shared/skeleton.css` and keep both in sync via comment + lint rule (deferred to implementation if needed) |
| `loadProgress()` timeout race fires before fetch resolves on slow networks | Low | Real progress invisible momentarily | 1.5 s timeout chosen to be longer than P95 backend latency; flip is idempotent |

## Open questions

None. All decisions resolved during brainstorm:
- Approach: A (CSS shimmer + minimal overlay)
- Scope: tutorial page hydration + nav bar + TutorialNavigator only; AppSpace/MyCompletions deferred
- Nav bar element: `ui5-progress-indicator` with trickle animation
- Skeleton component: shared Vue, three modes

## Out of scope (follow-ups)

- `ui-pilot/u14b-appspace-skeleton` — apply `<Skeleton>` to AppSpace.vue
- `ui-pilot/u14c-mycompletions-skeleton` — apply `<Skeleton>` to MyCompletions.vue
- `ui-pilot/u15-lightbox` — image lightbox/zoom (next in queue)
- `ui-pilot/u19-mobile-stepper` — mobile bottom-sheet step navigator
- `ui-pilot/u16-mission-drawer` — `ui5-side-navigation` showing mission tutorials with completion icons
- `ui-pilot/u18-profile-timeline` — `ui5-timeline` on user profile

U17 (per-step `ui5-rating-indicator`) is dropped from this batch — overlaps with the separate "Author drop-off analytics" roadmap item and the existing U6 tutorial-level rating; will be re-considered in its own design.
