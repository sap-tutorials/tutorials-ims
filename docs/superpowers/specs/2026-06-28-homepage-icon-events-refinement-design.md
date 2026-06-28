# Homepage refinement: missing icons + events empty-state + guard broadening

**Date:** 2026-06-28
**Author:** Tom Jung (with Claude)
**Status:** Approved (pending spec review)

## Context

The new developer-portal homepage (PR [#446], spec [2026-06-27-639-developer-homepage-design](2026-06-27-639-developer-homepage-design.md)) is live on DEV with three visible regressions:

1. **Inconsistent icons.** Four shellbar menu items (Learn, Build, Integrate, Connect) render with empty icon slots; three verb tiles (Learn, Build, Integrate) on the homepage do the same. The icon names ARE in the templates — the icons are simply not registered in the UI5 bootstrap.
2. **Events band shows "Could not load upcoming events"** even when the DB is just empty.
3. **Build-time icon guard didn't catch (1)** — for two distinct reasons: the deploy that shipped the broken icons appears to have bypassed `postbuild:apps`, AND the guard regex only sees `icon="…"` attribute literals — it can't see icon names that live inside Hugo template data structures. Specifically, verb-spine.html stores the six tile icons in a `slice (dict … "icon" "learning-assistant" …)` block, then expands them at build time via `<ui5-icon name="{{ $vIcon }}">`. The static guard runs against pre-expansion source, so the literal `"learning-assistant"` etc. are invisible to today's regex.

This PR fixes the user-visible regressions (1 + 2) and closes the regex gap in (3). The "why did postbuild:apps get bypassed" question is a separate investigation tracked in [#706].

## Goals

- All six verb tiles + all twelve shellbar menu items render their icons.
- Build and Connect use the same icon on the tile and the menu (decision below).
- EventsBand distinguishes "fetch failed" from "DB is empty" with appropriate copy.
- `check-icon-imports.ts` catches icon names that appear as literal strings inside Hugo `dict` blocks (e.g. `"icon" "learning-assistant"`), so the verb-spine bug class is statically detectable on every build going forward.

## Non-goals

- Seeding actual events data ([#700]).
- YouTube API key + playlist ID configuration ([#701]).
- HomepageShelves seed verification ([#702]).
- Community lane RSS reachability probing ([#703]).
- Notifications/alerts setup ([#704]).
- Legacy redirects seed ([#705]).
- Why `postbuild:apps` got bypassed on the deploy that shipped these icons ([#706]).

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Build icon (tile + menu) | `developer-settings` | Domain-specific "developer tooling". Tile already uses this. |
| Connect icon (tile + menu) | `customer-and-contacts` | Reads as "community" (people silhouette). Tile already uses this. |
| Guard regex scope | Add a second pattern for Hugo `dict`-literal icon entries (e.g. `"icon" "learning-assistant"`) | Verb-spine.html stores the six tile icons in a `dict` block, then expands them at runtime via `<ui5-icon name="{{ $vIcon }}">` — invisible to today's `icon="…"`-only regex. A regex on `"icon"\s+"<name>"` catches all six in source with zero false positives in the current tree. |
| Empty-state copy | `"No upcoming events scheduled."` | Authoritative, matches dashboard tone. |
| Verification depth | Local unit + guard run only | CI smoke + check-icon-imports cover the rest. |
| Test additions | Guard regression test + EventsBand component test | Cheap, lock in both fixes against future regressions. |
| Postbuild bypass investigation | Out of scope, tracked in [#706] | Orthogonal — fix the visible bug first, investigate process gap separately. |

## Changes

### 1. Register three missing UI5 icons

[hugo/assets/js/ui5-bootstrap.ts](../../../hugo/assets/js/ui5-bootstrap.ts) — append in the icon block (after `customer-and-contacts.js`):

```ts
import "@ui5/webcomponents-icons/dist/learning-assistant.js";   // verb-spine + header (Learn)
import "@ui5/webcomponents-icons/dist/developer-settings.js";   // verb-spine + header (Build)
import "@ui5/webcomponents-icons/dist/chain-link.js";           // verb-spine + header (Integrate)
```

`settings`, `da`, `customer-and-contacts` are already imported and cover Operate / Extend with AI / Connect. After change (2), `action` and `discussion` are no longer referenced and don't need imports.

### 2. Align shellbar menu icons with tile icons

[hugo/layouts/partials/header.html](../../../hugo/layouts/partials/header.html) lines 20 and 24:

```diff
- <ui5-li icon="action" data-href="/build/">Build</ui5-li>
+ <ui5-li icon="developer-settings" data-href="/build/">Build</ui5-li>
...
- <ui5-li icon="discussion" data-href="/connect/">Connect</ui5-li>
+ <ui5-li icon="customer-and-contacts" data-href="/connect/">Connect</ui5-li>
```

After the change, both the verb tile and the shellbar menu item for Build/Connect use identical icons. No other references to `action` / `discussion` exist in `hugo/` or `hugo-apps/` (verified via grep).

### 3. Distinguish error from empty-state in EventsBand

[hugo-apps/src/homepage-bands/EventsBand.vue](../../../hugo-apps/src/homepage-bands/EventsBand.vue) — split the combined `v-else-if="error || !events.length"` block into two:

```diff
- <div v-else-if="error || !events.length" class="hb-events-band__empty">
-   <p class="hb-events-band__empty-msg">
-     {{ error ? 'Could not load upcoming events.' : 'No upcoming events.' }}
-   </p>
-   <a href="https://community.sap.com/t5/sap-events/ct-p/events" ...>View all SAP events &rarr;</a>
- </div>
+ <div v-else-if="error" class="hb-events-band__empty">
+   <p class="hb-events-band__empty-msg">Could not load upcoming events.</p>
+   <a href="https://community.sap.com/t5/sap-events/ct-p/events" ...>View all SAP events &rarr;</a>
+ </div>
+ <div v-else-if="!events.length" class="hb-events-band__empty">
+   <p class="hb-events-band__empty-msg">No upcoming events scheduled.</p>
+   <a href="https://community.sap.com/t5/sap-events/ct-p/events" ...>View all SAP events &rarr;</a>
+ </div>
```

The fallback link is preserved in both states (community.sap.com is a useful destination whether we failed or just have no data).

### 4. Broaden `check-icon-imports.ts` to catch Hugo `dict`-literal icon entries

[scripts/check-icon-imports.ts](../../../scripts/check-icon-imports.ts) — add a second regex alongside `ICON_RE`:

```ts
/**
 * Match Hugo `dict` literal entries of the form `"icon" "<name>"`. This is
 * the verb-spine pattern: hugo/layouts/partials/homepage/verb-spine.html
 * stores its six tile icons in a `slice (dict … "icon" "<name>" …)` block
 * (lines 7-12) and expands them via `<ui5-icon name="{{ $vIcon }}">` at
 * render time. The static guard runs against pre-expansion source, so the
 * literal names are only visible inside the dict.
 *
 * The pattern requires `"icon"` followed by whitespace and a quoted UI5
 * icon-shaped name. False-positive surface area was checked at design
 * time: `grep -rE '"icon"\s+"[a-z]' hugo/` returned only the six expected
 * verb-spine lines.
 */
const HUGO_DICT_ICON_RE = /"icon"\s+"([a-z][a-z0-9-]*)"/g;
```

Update `parseIconUsages()` to run both patterns and union their results. The block comment at the top of the script gains a line under "Scope (deliberate)":

```
//   - Hugo `dict "icon" "<name>"` literal in .html layouts (verb-spine pattern)
```

This catches all six verb-spine tile icons (`learning-assistant`, `developer-settings`, `chain-link`, `settings`, `da`, `customer-and-contacts`) on every build. Any future tile added with a forgotten import will fail postbuild instead of shipping broken.

> **Note on `<ui5-icon name="…">`:** An earlier draft proposed a regex anchored on `<ui5-icon name="…">`. That literal form does not currently appear anywhere in the tree (verb-spine uses the template-expansion form `name="{{ $vIcon }}"`). The Hugo-dict regex is what actually closes the bug class. Adding `<ui5-icon name="…">` matching too would be defensive but currently dead — deferred until a literal callsite appears.

### 5. Tests

**a. Guard regression test** — [test/unit/check-icon-imports.test.ts](../../../test/unit/check-icon-imports.test.ts) gains two cases:

- `passes when Hugo dict-style "icon" "name" has a matching import` — fixture writes a layout containing `(dict "key" "FOO" "icon" "bell")` and a bootstrap with `import "@ui5/webcomponents-icons/dist/bell.js";`, asserts exit 0.
- `fails when Hugo dict-style "icon" "name" has no matching import` — fixture writes only the layout, asserts exit 1 with the missing icon and file:line in stderr.

**b. EventsBand component test** — new file `hugo-apps/src/homepage-bands/EventsBand.test.ts` (adjacent to the component, matching the [advocate-profile/App.test.ts](../../../hugo-apps/src/advocate-profile/App.test.ts) convention; Vitest's unit glob `hugo-apps/src/**/*.test.{js,ts}` picks both adjacent and `__tests__/`-nested files). Uses `@vue/test-utils` + happy-dom + `globalThis.fetch` mocks (already in root devDeps). Covers:

- Loading skeleton renders 4 placeholder divs while `loading=true`.
- Fetch rejection → "Could not load upcoming events." text + fallback link.
- Fetch resolves with `[]` → "No upcoming events scheduled." text + fallback link.
- Fetch resolves with non-empty array → renders one `.hb-events-band__card` per event with `format` chip class wired correctly (`virtual` → `hb-chip--virtual`, etc.).

## Architecture / data flow

No new components, no new endpoints, no schema changes. Pure frontend + build-time-tooling refinement.

```
hugo/layouts/partials/header.html ─┐
hugo/layouts/partials/             ├─ static icon names ─┐
  homepage/verb-spine.html         ┘                     │
                                                         ├──> check-icon-imports.ts
hugo/assets/js/ui5-bootstrap.ts ─── icon imports ────────┘    (postbuild guard)
                                                              fails if a name
                                                              has no import

hugo-apps/src/homepage-bands/
  EventsBand.vue ──> /api/homepage/events ──> srv/homepage-service.js
                                              (returns [] when DB empty)
```

## Risks & mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Bundle-size impact from 3 added icons | Negligible | ~1-2 KB minified per icon; total << 10 KB. |
| Removing `action`/`discussion` from header silently breaks a reference elsewhere | Very low | Grep confirmed zero occurrences in `hugo/`, `hugo-apps/` outside the lines being changed. |
| Guard regex broadening introduces false positives | Low | Pattern `"icon"\s+"<name>"` requires the JSON-style key+value adjacency typical of Hugo `dict` calls. Sweep of `hugo/` at design time found zero matches outside verb-spine's 6 expected lines. Only matches well-formed UI5 names (`[a-z][a-z0-9-]*`). |
| EventsBand snapshot/visual tests fail on copy change | Low | No snapshot tests on EventsBand today. Smoke covers structural presence, not copy. |

## Verification plan

Locally before opening the PR:

```bash
npx tsx scripts/check-icon-imports.ts                # MUST exit 0
npm test -- --run check-icon-imports                  # passes new cases
npm test -- --run EventsBand                          # passes new cases
npm test                                              # full unit suite still green
```

Optional: `npm run build:all` to confirm the Hugo + Vite pipeline still builds.

After merge, the CI smoke run validates against the deployed approuter. Tom will eyeball the homepage once deployed to confirm icons render.

## Out-of-scope follow-ups

Tracked as separate GitHub issues; this PR's description will link them:

- [#700] Seed initial events for homepage Events band
- [#701] Configure YOUTUBE_API_KEY + Developer News playlist ID
- [#702] Verify HomepageShelves seed populated on deployed envs
- [#703] Probe community-lane RSS reachability from CF egress
- [#704] Configure notifications/alerts for shellbar bell
- [#705] Seed LegacyRedirects from AEM URL set
- [#706] Investigate why `postbuild:apps` icon guard didn't catch missing header icons
