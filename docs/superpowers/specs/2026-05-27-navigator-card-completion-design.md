# Tutorial Navigator: Show Completion Status on Cards

**Issue:** [sap-tutorials/tutorials-ims#80](https://github.com/sap-tutorials/tutorials-ims/issues/80)
**Date:** 2026-05-27
**Status:** Approved

## Problem

The Tutorial Navigator (the public `/tutorials/` browse page) renders mission, group, and tutorial cards in a unified grid, but it does not surface a signed-in user's completion progress on those cards. Users who have completed tutorials see no indication of their progress when browsing — they have to enter a tutorial detail page or visit `/me/` to know what they've finished. The reference visual (a 100% progress ring with a green check on the top-left of the card) already exists on AppSpace track cards but has not been applied to the Navigator.

## Goal

Show per-user completion status on Navigator cards for signed-in users, using the same corner-ring visual pattern that AppSpace uses today. Anonymous users see no change to the page.

## Non-Goals

- Fractional progress on mission and group cards (the data layer only knows "completed: yes/no" for those entity types).
- Live updates of progress on completion within an open navigator session — a page reload picks up the new state.
- A "sign in to see your progress" nudge for anonymous users — separate growth-marketing decision out of scope here.
- Reformulating AppSpace to use the new shared component — left as a follow-up; the lift is one-directional in this change.

## Decisions

The following design decisions were validated during brainstorming and form the contract for the implementation.

### D1 — Scope: all three card types

All three Navigator card types (tutorial, mission, group) display the indicator when the signed-in user has progress. The issue title says "Tutorial Cards" but the screenshot's intent is uniform treatment across the grid; mission and group completion data is already returned by `getUserProgress`.

### D2 — Anonymous users see no indicator

For an anonymous visitor, the Navigator looks pixel-identical to today. No ring, no reserved corner space, no sign-in nudge, no extra requests that 401. Anonymous browsing is the dominant traffic pattern on `/tutorials/` and adding noise there is the wrong tradeoff.

### D3 — Indicator only appears when progress > 0%

Even for a signed-in user, an unstarted tutorial — or a tutorial sitting at 0% (TaskRecord exists but no steps done) — shows no ring. Only `completedSlugs` (100%) and `inProgress` items with `progressPercent > 0` get a ring. This trims the wire payload and keeps unstarted cards visually quiet.

### D4 — Visual: corner ring matching the AppSpace + screenshot pattern

Top-left SVG ring with percent text inside, identical geometry to [AppSpace.vue:319-329](hugo-apps/src/app-space/AppSpace.vue#L319-L329). Title/description/type label indent ~3rem on cards that have a ring; cards without a ring keep today's exact padding. On 100% complete, the ring is fully green and the inside text becomes a check (✓) instead of "100%".

### D5 — Data path: new public-but-auth-aware endpoint `/build/my-progress`

A new CAP endpoint mirroring the existing public `/build/*` pattern. Approuter route is `authenticationType: "none"`; the CAP handler reads `cds.context.user`. Anonymous users get an empty-shape payload with HTTP 200 — no redirect, no 401. This avoids reusing the `xsuaa`-gated `/api/getUserProgress()` (which would force auth-redirect handling) and avoids a serial `/auth/user` → `/api/...` roundtrip.

### D6 — Render timing: cards-first, ring fades in independently

Cards render the moment `tutorials.value` populates from the existing two fetches. The new third fetch (`/build/my-progress`) runs in parallel; when it resolves, rings appear with a 150ms opacity fade — no layout shift (no corner space is reserved when there's no ring) and no hard snap. The progress fetch is **not** part of the navigator's `loading` gate.

## Architecture

### Data flow

```
Browser navigator onMounted:
  Promise.all([
    fetch /tutorials/_nav.json     → tutorial entries (existing)
    fetch /build/navigator         → mission/group catalog (existing)
    fetch /build/my-progress       → user progress (NEW, public auth-aware)
  ])

Cards render as soon as the first two resolve.
Progress ref updates independently when the third resolves.
ProgressRing renders per-card via cardProgress(item) helper.
```

### Wire format: `GET /build/my-progress`

Same shape for anonymous and signed-in users; only the contents differ.

```json
{
  "authenticated": true,
  "tutorials": {
    "completedSlugs": ["build-cap-app-with-joule"],
    "inProgress":     [{ "slug": "use-hana-cloud", "progressPercent": 60 }]
  },
  "missionSlugs": ["abap-dev-get-started"],
  "groupSlugs":   ["cap-essentials"]
}
```

Anonymous response: `{ authenticated: false, tutorials: { completedSlugs: [], inProgress: [] }, missionSlugs: [], groupSlugs: [] }`.

Headers: `Cache-Control: private, no-store` to ensure no shared cache serves one user's progress to another.

The handler filters out any `inProgress` entry where `progressPercent === 0` before returning.

## Components

### 1. `srv/server.js` — handler `app.get('/build/my-progress', ...)`

~25 lines. Calls `getUserProgress(req.user)` from [srv/lib/user-progress.js](srv/lib/user-progress.js) (existing, no changes). Reshapes the result into the slim wire format. Anonymous users naturally get the empty-shape payload because `getUserProgress` already returns empty arrays when `dbUserId` is null. Wraps the call in try/catch — internal errors return the empty-shape payload with HTTP 200 (logged via `cds.log('navigator')`), never breaking the public navigator.

### 2. `approuter/xs-app.json` — route entry

Add a route entry for `^/build/my-progress$` with `authenticationType: "none"`, `destination: "srv-api"`, `csrfProtection: false`. Must be placed **above** any catch-all so it matches first. Pattern matches the existing public `/build/*` routes already in the file.

### 3. `hugo-apps/src/shared/ProgressRing.vue` — new file

Pure presentational Vue component. Props: `percent: number` (0–100), `complete?: boolean`. Lifts the SVG geometry from `AppSpace.vue` and generalizes it (removes `.track-card--*` selectors, scopes its own CSS). When `complete`, displays `✓` instead of the percent text and uses the green stroke. Includes an `aria-label` like `"60% complete"` or `"Completed"`; the visual SVG and text are decorative (`aria-hidden`).

### 4. `hugo-apps/src/navigator/TutorialNavigator.vue` — modified

- New refs: `progress` (initially `{ tutorials: { completedSlugs: new Set(), inProgress: new Map() }, missionSlugs: new Set(), groupSlugs: new Set() }`), `progressLoaded` (boolean).
- `onMounted`: third parallel `fetch('/build/my-progress', { credentials: 'include' })`. On success, populate `progress` with sets/maps for O(1) lookup; flip `progressLoaded` true. On failure, log and leave `progress` at its empty default.
- `cardProgress(item: CardItem): { percent, complete } | null` helper returns the per-card state or null. For tutorial cards: completion check first, then in-progress map, then null. For mission/group cards: slug-set membership → `{ percent: 100, complete: true }` or null. Slugs are extracted from `item.href` using the existing `/tutorials/(?:mission|group)-?` prefix conventions.
- Template: each `<a class="nav-card">` gets `<ProgressRing v-if="cardProgress(item)" v-bind="cardProgress(item)" />` and a `nav-card--has-progress` class when a ring is present, applying the ~3rem indent to title/description/type label.
- Fade-in: `data-progress-loaded` attribute on the navigator root toggles when the fetch resolves; CSS rule `[data-progress-loaded] .progress-ring { opacity: 1 }` with a 150ms transition from the initial `opacity: 0`.

### Search-mode parity

When `searchMode.value` is true, `displayedItems` is built from search backend results instead of `paginatedItems`. Search results carry the same `type`/`href` shape, so `cardProgress(item)` works without a code-path branch.

## Error Handling

| Failure | Behavior |
|---|---|
| `/build/my-progress` network error or non-200 | Browser logs to console; cards still render; `progress` stays empty-default. |
| Backend exception inside handler | Caught, logged via `cds.log('navigator')`; returns empty-shape payload with HTTP 200. |
| TaskRecord with legacyId no longer mapped to a slug | Already filtered upstream by `getUserProgress`. |
| User signs in while page is open | Out of scope — reload picks up new state. |
| Slug collision between mission and group with same slug | Disambiguated via `item.href` prefix (`/tutorials/mission-...` vs `/tutorials/group-...`). |
| `inProgress` with `progressPercent: 0` | Filtered both server-side (handler) and client-side (`cardProgress`); belt-and-suspenders. |

## Testing Strategy

### Unit

- **`test/unit/build-my-progress.test.js`**
  - Anonymous user → 200, empty-shape body, `Cache-Control: private, no-store`.
  - Signed-in user with completed + in-progress + 0% records → 0% record excluded, others present.
  - TaskRecords with orphan legacyIds → excluded (inherited from `getUserProgress`).
  - Backend exception → 200 with empty-shape payload (caller never propagates).
- **`test/unit/progress-ring.test.js`**
  - Renders percent text when `complete=false`.
  - Renders check mark when `complete=true`.
  - `stroke-dasharray` reflects the `percent` prop value.

### Hybrid

Skipped — no new HANA-specific behavior. `getUserProgress` is already exercised by hybrid tests through the `getMyCompletions` / `getEventProgress` paths.

### Smoke

Add one case to the existing public-endpoint smoke file: anonymous `GET /build/my-progress` returns 200 with `authenticated: false`. Confirms the approuter route is wired correctly and there's no auth redirect.

### Manual

Per project rule "test UI in a browser before reporting complete":
1. `npm run dev:hybrid` against DEV HANA.
2. Browse `/tutorials/` signed-in as a known user with completed tutorials → confirm rings appear on completed/in-progress cards with correct geometry and color.
3. Same page in incognito → confirm zero rings, no console 401s, layout identical to before.
4. Capture before/after screenshots for the PR.

## Build Sequence

This is a single-PR change. The order of work below is for the implementer, not for phased rollout.

1. Backend handler in `srv/server.js`.
2. Backend unit tests.
3. Approuter route entry in `approuter/xs-app.json` (verify route order).
4. Smoke test for the new public endpoint.
5. `ProgressRing.vue` shared component + unit tests.
6. Navigator wiring (`TutorialNavigator.vue`): third fetch, `progress` ref, `cardProgress` helper, template insert, indent class, fade-in CSS.
7. Manual verification (signed-in + anonymous), capture screenshots.
8. Open PR against `main` with before/after screenshots and "Closes #80" in the body.

## Risks

- **xs-app.json route order**: if `/build/my-progress` is placed after a catch-all, the route never matches. Verified at implementation time against the current file.
- **Vite `@shared` path alias**: `ProgressRing.vue` is the first new file under `hugo-apps/src/shared/`. Verify the existing alias resolves before adding more imports.
- **Cache-Control compliance with downstream caches**: `Cache-Control: private, no-store` is sufficient for browser and approuter; no CDN sits in front of the CAP backend in production.
