# Issue #744 — Fold `/explore/` into Hugo (shellbar + theme support)

- **Status:** Approved (2026-06-29), pending spec-reviewer pass
- **Issue:** [#744](https://github.com/sap-tutorials/tutorials-ims/issues/744)
- **Predecessor PRs:** [#726](https://github.com/sap-tutorials/tutorials-ims/pull/726) (KG public reader), [#737](https://github.com/sap-tutorials/tutorials-ims/pull/737) (manifest path fix), [#743](https://github.com/sap-tutorials/tutorials-ims/pull/743) (SPARQL Accept header)
- **Related spec:** [`2026-06-27-446-knowledge-graph-phase3-design.md`](./2026-06-27-446-knowledge-graph-phase3-design.md) (the spec that introduced the standalone `/explore/` template this proposal replaces)

## Summary

The `/explore/` Knowledge Graph page is currently served by a standalone HTML template (`srv/templates/explore.html`) rendered by an Express handler in srv. The standalone template has no SAP Developer Center shellbar (the top nav with search, theme toggle, Joule, hamburger menu, avatar) and no light/dark theme support, so the page looks visibly broken next to every other surface on developers.sap.com.

This spec folds `/explore/` into the Hugo build pipeline. Hugo's `baseof.html` chrome supplies the shellbar, theme bootstrap, head/footer, joule panel, and alerts popover for free. The existing Vue/Sigma SPA in `app/explore/` continues to live as its own Vite project (preserving its 150KB gzip bundle budget and Sigma/graphology deps) and gets embedded as an island inside the Hugo page. The current SSR-inlined-graph-payload path is dropped in favor of a client-side `fetch('/graph/explore-data')` — the Vue app already has that fallback wired up.

## Scope

### In scope

- Replace `srv/templates/explore.html` + `srv/lib/explore-route.js` + `srv/lib/build-explore-html.js` with a Hugo content page + layout.
- Move the build-time manifest target from `gen/srv/srv/lib/explore-bundle-manifest.json` to `hugo/data/explore_bundle.json`.
- Remove the Express handler registration at `srv/server.js:192` and the import on line 10.
- Remove the approuter route `^/explore/?$` → `srv-api` from `approuter/xs-app.json`; default static-serving picks up `approuter/static/explore/index.html` instead.
- Update the four unit tests that pin the old SSR path; add one new unit test that pins the new build-sequencing requirement.
- Tighten the existing smoke assertion on `/explore` to verify shellbar markup is present.
- Update both `mta.yaml` (DEV/test) and `.deploy/mta.yaml` (the standalone-approuter variant).

### Out of scope

- Graph data correctness — fixed independently in [PR #743](https://github.com/sap-tutorials/tutorials-ims/pull/743) (`Accept: application/sparql-results+json` on `SYS_SPARQL_EXECUTE`).
- Porting `app/explore/` into `hugo-apps/` (option A2 from brainstorming). Deferred. The 150KB explore-bundle budget, Sigma+graphology+ForceAtlas2 deps, and the structural separation argue for keeping `app/explore/` as its own Vite project. Revisit if and when we have a second large island that wants the same boundary.
- A 308 redirect from the old SSR handler (option C2 from brainstorming). The route is the same URL (`/explore/`); only the source changes. There is no external bookmark or doc that hits a different path.
- A feature flag for the chrome rollout. Worst-case rollback is `git revert` + redeploy.

## Approach

The Developer Advocates page is the precedent: a Hugo content page (`hugo/content/developer-advocates/_index.md`) + layout (`hugo/layouts/developer-advocates/list.html`) that mounts a Vue island via `<main id="advocates-mount">` and a `<script type="module">` tag. We follow the same shape for `/explore/`, with one twist — the Vue island lives in `app/explore/` (its own Vite project), not in `hugo-apps/` (the shared Vite project for small islands). Hugo learns the Vite output hash by reading a JSON manifest emitted at build time.

The current architecture's only reason to be SSR-rendered was to inline `~4685 nodes + 31459 edges` of graph JSON for first-paint hydration. That trade-off is a false economy: the JSON is several MB, so SSR-inlining makes TTFB *worse*, not better — the user sits on a blank page until HANA returns the SPARQL bulk query, then gets everything at once. Client-fetching gives them shellbar + spinner in <100ms while data loads. The Vue app's `useGraphData()` composable already prefers the inline payload if present and falls back to `fetch('/graph/explore-data')` otherwise; we just delete the inline-payload branch.

## 1. Architecture

### 1.1 Build pipeline

```text
app/explore/ Vite build
  → app/explore/dist/index.html      (Vite's index.html with hashed names)
  → app/explore/dist/main-<hash>.js
  → app/explore/dist/assets/index-<hash>.css

scripts/build-explore-manifest.ts (target changed)
  → parses app/explore/dist/index.html for hash + css
  → writes hugo/data/explore_bundle.json: { "hash": "2LYsyS3F", "css": "index-AbCdEf.css" }

npm run build:all → Hugo build
  → reads hugo/data/explore_bundle.json (via site.Data.explore_bundle)
  → reads hugo/content/explore/_index.md
  → renders via hugo/layouts/explore/single.html
  → emits hugo/public/explore/index.html (full chrome + bundle <script> tag)

mbt build
  → cp -r hugo/public/. approuter/static/
  → cp -r app/explore/dist/. approuter/static/explore-ui/    (unchanged)
```

### 1.2 Request path

```text
Browser GET /explore/
  → Approuter static-serves approuter/static/explore/index.html
    (default localDir: static route; no explicit route entry)
  → HTML has shellbar, theme bootstrap, head, footer, joule, alerts, plus
    <div id="explore-app"></div>
    <link rel="stylesheet" href="/explore-ui/assets/index-<hash>.css">
    <script type="module" src="/explore-ui/main-<hash>.js">
  → Browser fetches /explore-ui/main-<hash>.js (static-served by approuter)
  → Vue app mounts to #explore-app, useGraphData() fetches /graph/explore-data
    → Approuter routes /graph/explore-data → srv-api (existing route, unchanged)
    → srv builds payload via buildExplorePayload(db) (existing handler, unchanged)
  → Vue renders Sigma graph
```

### 1.3 Theme inheritance

Hugo's `head.html` runs a pre-paint script that reads `localStorage.theme` and sets `data-theme="dark"` synchronously before paint. The shellbar's theme-toggle button writes back to `localStorage`. The Vue app's existing CSS uses CSS custom properties (sap-theme-vars), so it inherits the theme automatically — no changes inside `app/explore/src/` for theming beyond verifying the existing variables resolve under both themes.

## 2. Components

### 2.1 Removed

| File | Reason |
|---|---|
| `srv/lib/explore-route.js` | SSR handler; no longer needed |
| `srv/templates/explore.html` | Standalone template; replaced by Hugo layout |
| `srv/lib/build-explore-html.js` | Template renderer; renderer is now Hugo |
| `srv/lib/explore-bundle-manifest.json` | Build artifact; manifest now lives in Hugo |
| `test/unit/srv/explore-route.test.js` | Tests deleted handler |
| `test/unit/srv/build-explore-html.test.ts` | Tests deleted renderer |
| `test/unit/scripts/check-explore-manifest-mta.test.ts` | Pinned the old `gen/srv/lib/` path; obsolete |

### 2.2 Added

| File | Purpose |
|---|---|
| `hugo/content/explore/_index.md` | Hugo content page with frontmatter (`type: explore`, `layout: single`, title, description, slug). |
| `hugo/layouts/explore/single.html` | Hugo template; mounts `<div id="explore-app"></div>`, emits `<link>` + `<script>` from `site.Data.explore_bundle`, with `{{ with }}{{ else }}` error fallback. |
| `hugo/data/explore_bundle.json` | Build-time manifest. Shape: `{ "hash": "<vite-hash>", "css": "index-<hash>.css" }`. Produced by `scripts/build-explore-manifest.ts`; consumed by Hugo. |
| `test/unit/scripts/check-explore-manifest-hugo.test.ts` | Asserts both mta.yaml files contain the manifest-emit step targeting `hugo/data/explore_bundle.json` and that it runs *before* the Hugo build step in the same module's before-all. |
| `test/unit/hugo/explore-layout.test.ts` | Text-grep test on `hugo/layouts/explore/single.html`: references `site.Data.explore_bundle`, mounts `#explore-app`, has the `{{ else }}` error fallback. |

### 2.3 Changed

| File | Change |
|---|---|
| `scripts/build-explore-manifest.ts` | Default output path moves from `srv/lib/explore-bundle-manifest.json` to `hugo/data/explore_bundle.json`. CLI args unchanged; both mta.yaml files pass the new path explicitly. |
| `srv/server.js` | Remove the `import { exploreHandler } from './lib/explore-route.js'` line and the `app.get('/explore/', exploreHandler)` registration. |
| `app/explore/src/main.ts` | `.mount('#app')` → `.mount('#explore-app')`. The rename avoids any potential collision with `<div id="app">` markup in Hugo's chrome. |
| `app/explore/src/composables/useGraphData.ts` | Delete the `window.__INITIAL_GRAPH__` window-global branch; the function unconditionally fetches `/graph/explore-data` on mount. Reduces the composable from ~30 lines to ~20. |
| `approuter/xs-app.json` | Remove the `^/explore/?$` → `destination: srv-api` entry. The `^/explore-ui/(.*)$` static route stays. The default static-serving catch-all picks up `/explore/`. |
| `mta.yaml` | Move the `build-explore-manifest` step from the srv module's before-all (running after `cds build`, emitting into `gen/srv/srv/lib/`) to the approuter module's before-all (running after the explore Vite build, before Hugo). |
| `.deploy/mta.yaml` | Same as `mta.yaml`. The standalone-approuter variant lives here and needs the symmetric change. |
| `test/unit/scripts/build-explore-manifest.test.ts` | Update existing assertions: new default path is `hugo/data/explore_bundle.json`; JSON shape unchanged. |
| `test/smoke/public-endpoints.test.js` | Existing 200-status assertion stays; add `expect(text).toContain('app-shellbar')` and `expect(text).toContain('data-theme')` so a future regression that re-introduces the standalone template is caught at deploy time. |

## 3. Build sequencing

### 3.1 Old order (in `mta.yaml` srv before-all)

```text
1. npm ci
2. cds build --production
3. npx tsx scripts/build-explore-manifest.ts \
     app/explore/dist gen/srv/srv/lib/explore-bundle-manifest.json
4. (manifest packs into srv MTAR via gen/srv/srv/ convention)
```

### 3.2 New order (in `mta.yaml` approuter before-all)

```text
1. npm ci
2. npm run build:explore                                (produces app/explore/dist/)
3. npx tsx scripts/build-explore-manifest.ts \
     app/explore/dist hugo/data/explore_bundle.json
4. npm run build:all                                    (fetch-tutorials + hugo + apps; Hugo reads hugo/data/explore_bundle.json)
5. mbt copy of hugo/public into approuter/static/       (existing)
6. mkdir + cp app/explore/dist into approuter/static/explore-ui/  (existing, unchanged)
```

`npm run build:all` already orchestrates fetch + hugo-apps + Hugo. We add a freshness guard inside `build:all` (or as a script step that runs first): if `hugo/data/explore_bundle.json` doesn't exist by the time `build:all` invokes Hugo, fail loudly and name the script that produces it.

### 3.3 Local dev impact

Same as today — `npm run build:all` is what fresh-shell builds always run before `mbt build`. The only difference is the manifest step needs to run inside that orchestrator (or as a documented prereq) before Hugo. We add it to the `build:all` script and to the `npm run build:explore` documentation so a developer who runs only `npm run build:explore` + `hugo` (skipping `build:all`) gets a helpful error from the Hugo template's `{{ else }}` branch.

### 3.4 CF runtime impact

- Removes `srv/lib/explore-bundle-manifest.json` from the deployed srv MTAR (`gen/srv/srv/lib/` slice).
- Removes the disk read in `srv/lib/explore-route.js` from process boot.
- Removes one Express route registration from srv startup.
- The srv module is slightly smaller and starts slightly faster. No new disk reads on the approuter side — Hugo bakes the manifest values into the rendered HTML at build time.

## 4. Error handling

### 4.1 Manifest missing at Hugo build time

If `hugo/data/explore_bundle.json` doesn't exist when Hugo runs:

- **Belt:** `npm run build:all` orchestrator checks for the file right before invoking Hugo. Fails loudly if missing — names both the missing file and the script that produces it.
- **Braces:** Hugo template uses `{{ with site.Data.explore_bundle }} ... {{ else }} <div class="explore-build-error">Explore bundle missing — run `npm run build:explore` first.</div> {{ end }}` so the page renders a visible build-error message instead of broken `<script src="/explore-ui/main-.js">` tags.

### 4.2 Graph data fetch fails at runtime

Today's `useGraphData()` already handles this: its `error` ref shows a "Failed to load graph" message inline. Behavior unchanged. Net improvement: the shellbar + theme + chrome are still painted regardless of `/graph/explore-data` returning 500. Today, that 500 leaves the user on a totally blank page; post-change, they get chrome with an inline error message and can navigate away via the shellbar.

### 4.3 JS bundle 404 at runtime

Today this leaves the user on a totally blank page. Post-change, the shellbar still paints; the user sees chrome with an empty page body and the inline `<div class="explore-build-error">` (if the Hugo template's `{{ with }}` resolved to empty). Acceptable degradation — visible chrome lets them navigate away.

### 4.4 Approuter route precedence after delete

The current `^/explore/?$` route in `approuter/xs-app.json` sends `/explore` to srv-api. After deletion, `/explore/` must match the default `localDir: static` route serving `approuter/static/explore/index.html`. Implementation step: grep `xs-app.json` for any earlier route that could intercept `/explore` (none expected, but verify). The `^/explore-ui/(.*)$` route stays explicit; it predates the catch-all and serves a different path namespace.

### 4.5 Vue mount-target collision

The rename `#app` → `#explore-app` matters because Hugo's chrome may include `<div id="app">` somewhere (the joule panel renders into its own mount; the shellbar is `<ui5-shellbar id="app-shellbar">` — close but not a collision; nothing else is known). Implementation step: grep all Hugo partials for `id="app"` before locking in the new ID.

## 5. Testing

### 5.1 Unit tests

**Deleted** (tests for code that's gone):

- `test/unit/srv/explore-route.test.js`
- `test/unit/srv/build-explore-html.test.ts`
- `test/unit/scripts/check-explore-manifest-mta.test.ts`

**Updated:**

- `test/unit/scripts/build-explore-manifest.test.ts` — new default output path is `hugo/data/explore_bundle.json`; JSON shape unchanged (`{hash, css}`).

**Added:**

- `test/unit/scripts/check-explore-manifest-hugo.test.ts` — asserts that both `mta.yaml` and `.deploy/mta.yaml` contain the `build-explore-manifest` step, that its output path is `hugo/data/explore_bundle.json`, and that the step appears before the Hugo build step in the same module's before-all. Catches the symmetric out-of-order failure mode.
- `test/unit/hugo/explore-layout.test.ts` — text-grep test on `hugo/layouts/explore/single.html`. Asserts: references `site.Data.explore_bundle`, mounts `#explore-app` not `#app`, has the `{{ else }}` error fallback. No Hugo runtime needed.

### 5.2 Smoke tests

- `test/smoke/public-endpoints.test.js` already hits `/explore` and asserts 200. Tighten: also assert response body contains `app-shellbar` and `data-theme` to catch a regression where someone re-introduces the standalone template.

### 5.3 Hybrid tests

No change. `/graph/explore-data` already has hybrid coverage from PR #743's work. Page chrome is static, not DB-dependent.

### 5.4 Manual smoke after deploy

1. Load `/explore/` — shellbar paints immediately, "Loading graph…" or empty Sigma canvas for ~1s, then graph renders.
2. Click theme-toggle in shellbar — page flips to dark mode, graph canvas inherits dark background via CSS vars.
3. Open hamburger menu → "Knowledge Graph" → reloads to `/explore` (the existing nav entry; verifies the new page is discoverable through normal navigation).
4. Hard-refresh while in dark mode — no light-mode flash (the pre-paint script handles it).
5. Block `/graph/explore-data` in DevTools and reload — page chrome stays painted; explore body shows the existing "Failed to load graph" message.

## 6. Migration / rollout

Single PR. No data migration. No feature flag. Worst-case rollback is `git revert` + redeploy.

The route is the same URL (`/explore/`); the source changes from srv-rendered HTML to approuter-static HTML. No bookmark or external link breaks. Approuter route precedence is source-order, so the `^/explore/?$` → `srv-api` entry must be removed in the same change that introduces the Hugo page; otherwise approuter sends `/explore` to srv, which 404s because the handler is gone.

## 7. References

- Issue [#744](https://github.com/sap-tutorials/tutorials-ims/issues/744)
- Predecessor PR [#726](https://github.com/sap-tutorials/tutorials-ims/pull/726) — KG public reader (introduced the standalone template)
- Predecessor PR [#737](https://github.com/sap-tutorials/tutorials-ims/pull/737) — fixed the manifest path bug in the old architecture
- Predecessor PR [#743](https://github.com/sap-tutorials/tutorials-ims/pull/743) — fixed the SPARQL Accept header (the "empty graph" symptom)
- Phase 3 spec [`2026-06-27-446-knowledge-graph-phase3-design.md`](./2026-06-27-446-knowledge-graph-phase3-design.md) — the spec that introduced the `/explore/` SSR template this proposal replaces
- Memory [[feedback_cap_gen_srv_srv_path_for_runtime_files]] — context for why the old manifest target was `gen/srv/srv/lib/`
- Memory [[feedback_handcurated_registration_lists_are_a_bug_pattern]] — the new build-sequencing test (Section 5.1) is in the same architectural family
