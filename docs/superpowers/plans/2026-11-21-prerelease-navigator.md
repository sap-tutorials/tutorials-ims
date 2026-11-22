# Pre-release Navigator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `Tutorial.PreRelease` role-holders a scope-gated navigator to browse/filter/search ROLE_GATED tutorials, instead of needing a direct link per tutorial.

**Architecture:** A live gated nav feed on `srv-api` (ROLE_GATED-filtered, served behind the existing `{gated:true}` seam), a QA-style build-time `prerelease` Hugo channel for the navigator shell (client-side search, reusing the existing island), and a prerequisite fix to the pre-existing public `semantic_search` ROLE_GATED leak. No schema change, no new XSUAA scope, no new CAP app.

**Tech Stack:** CAP Node.js (`@sap/cds`), Express handlers in `packages/content/`, Hugo + Vue 3 islands, SAP approuter (`xs-app.json`), XSUAA, SQLite (unit tests) / HANA (hybrid/prod).

**Spec:** `docs/superpowers/specs/2026-11-21-prerelease-navigator-design.md`

## Global Constraints

- **Base + target branch: `origin/DEV`** (never `main`). PRs target DEV.
- **No schema change** — `visibility` enum + `Tutorials.visibility` already exist on DEV.
- **No `xs-security.json` change** — scope `$XSAPPNAME.Tutorial.PreRelease`, role-template `TutorialPreRelease`, role-collection `"Tutorials PreRelease"` already exist (#3099). No `cf update-service` needed.
- **Gated trust = server-side mount**, never a client-settable header (matches #3099 `{gated:true}` at `srv/server.js:850`).
- **Gated responses must not enter a public/shared cache** — `Cache-Control: private, no-store`, never written to the slug-keyed in-process cache.
- **Channel selection is build-time** (`site.Params.<channel>`), mirroring QA — not a runtime switch.
- **CQN `.where({slug:{in:[...]}})` over large slug sets blows HANA's packet cap** — reuse the unbounded-fetch + Node-filter pattern already in `navHandlerFallback`.
- Unit tests run on in-memory SQLite (`npm test -- <file>`); full suite is hook-blocked locally (CI runs it).

## Review Focus

- **Standalone (mission-less) ROLE_GATED tutorial** must appear in the gated navigator — the feed must NOT derive from the mission-scoped `NavigatorCatalog`. (Task 2 test.)
- **A LISTED tutorial must NEVER appear in the gated feed**, and a ROLE_GATED tutorial must never appear in the public `__nav__`/fallback. (Task 2 test.)
- **Public anonymous `semantic_search` must not return any ROLE_GATED slug** — on both HANA and SQLite branches. (Task 1 test.)
- **Gated nav feed response is `private, no-store`** and absent from the shared cache (no public-hit leak). (Task 2 test.)
- **An unauthenticated request to `/tutorials-prerelease/` and `/tutorials-prerelease/_nav.json` is refused by the approuter scope** (403), not served. (Task 5 — integration/e2e; approuter scope not unit-testable.)

---

### Task 1: Fix public `semantic_search` ROLE_GATED leak

Independent, must land (prerequisite). The public anonymous semantic tutorial corpus filters only on `status` + ContentCurrent presence; ROLE_GATED tutorials leak to anyone.

**Files:**
- Modify: `srv/lib/semantic-search.js` (tutorial corpus query, ~lines 168-196 — both the HANA raw-SQL branch and the SQLite CQL branch)
- Test: `srv/__tests__/lib/semantic-search-visibility.test.js` (create)

**Interfaces:**
- Produces: no new export; the existing semantic tutorial-search entrypoint now excludes ROLE_GATED on the public path.

- [ ] **Step 1: Write the failing test**

Seed two tutorials with embeddings: one `visibility='LISTED'`, one `visibility='ROLE_GATED'`, both `status='ACTIVE'` and both present in `ContentCurrent`. Call the semantic tutorial search path (the function invoked by the `semantic_search` action; import it directly from `semantic-search.js`). Assert the LISTED slug may be returned and the ROLE_GATED slug is **never** in the result set.

```js
test('public semantic search excludes ROLE_GATED tutorials', async () => {
  // seed LISTED + ROLE_GATED tutorials, both ACTIVE + in ContentCurrent, with embeddings
  const results = await searchTutorials(db, queryVecForBoth, { topK: 10 });
  const slugs = results.map(r => r.slug);
  expect(slugs).not.toContain('pre-release-secret');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- srv/__tests__/lib/semantic-search-visibility.test.js`
Expected: FAIL — ROLE_GATED slug present in results.

- [ ] **Step 3: Add the visibility predicate to both branches in `srv/lib/semantic-search.js`**

HANA branch: add to the SQL `WHERE` alongside the existing status gate — `AND (t."VISIBILITY" IS NULL OR t."VISIBILITY" <> 'ROLE_GATED')`. SQLite branch: add to the `.where(...)` on the `Tutorials` index fetch — `status (null/ACTIVE) and (visibility is null or visibility <> 'ROLE_GATED')`. Keep the existing `filterServableSlugs` call unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- srv/__tests__/lib/semantic-search-visibility.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add srv/lib/semantic-search.js srv/__tests__/lib/semantic-search-visibility.test.js
git commit -m "fix(search): exclude ROLE_GATED from public semantic_search (#3168, #3099 leak)"
```

---

### Task 2: Live gated nav feed handler

**Files:**
- Modify: `packages/content/content-store.js` (add `preReleaseNavHandler`; extract the slug-set→tutorial-nav assembly from `navHandlerFallback` ~lines 1765-1900 into a shared helper; export the new handler via `_defaults` + the module export block ~line 2327/2355)
- Modify: `srv/server.js` (mount near line 850, beside the existing `/content/tutorials-prerelease/*slug` gated serve mount)
- Test: `srv/__tests__/lib/prerelease-nav.test.js` (create)

**Interfaces:**
- Consumes: Task 1 unaffected.
- Produces: `preReleaseNavHandler(req, res)` — Express handler returning `{ version, count, tutorials }` where each tutorial is `{ slug, title, time, level, stepCount, displayTags, ... }` (identical shape to `navHandlerFallback`). Mounted at CAP `GET /content/tutorials-prerelease/_nav`.

- [ ] **Step 1: Write the failing test**

Seed three tutorials in `ContentCurrent` + `Tutorials`: `listed-a` (LISTED), `gated-standalone` (ROLE_GATED, **not** in any published mission), `gated-b` (ROLE_GATED). Invoke `preReleaseNavHandler` with a mock req/res. Assert:
- `tutorials` contains `gated-standalone` and `gated-b` (standalone ROLE_GATED IS listed — Review Focus);
- `tutorials` does NOT contain `listed-a`;
- the response `Cache-Control` header is `private, no-store`;
- each returned item has `slug`, `title`, `time`, `level`, `stepCount`, `displayTags`.

Also assert the inverse on the public path: call the existing `navHandler`/fallback over the same seed and confirm neither ROLE_GATED slug appears.

```js
test('gated nav feed returns only ROLE_GATED incl. standalone, no-store', async () => {
  const res = mockRes();
  await preReleaseNavHandler(mockReq(), res);
  const slugs = res.body.tutorials.map(t => t.slug);
  expect(slugs).toEqual(expect.arrayContaining(['gated-standalone', 'gated-b']));
  expect(slugs).not.toContain('listed-a');
  expect(res.headers['Cache-Control']).toBe('private, no-store');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- srv/__tests__/lib/prerelease-nav.test.js`
Expected: FAIL — `preReleaseNavHandler` not defined.

- [ ] **Step 3: Extract the assembly helper and implement `preReleaseNavHandler`**

Refactor `navHandlerFallback` so the slug-set→tutorial-nav-object assembly (the `allTutRows` fetch, step counts, display tags, and the final `{ slug, title, time, level, stepCount, displayTags }` mapping) is a shared helper `buildNavTutorials(slugSet, { visibilityFilter })` that filters `allTutRows` by `status !== 'INACTIVE'` and, when `visibilityFilter === 'ROLE_GATED'`, keeps only `t.visibility === 'ROLE_GATED'` (else keeps `visibility` LISTED-or-null and excludes ROLE_GATED — this **hardens** the cold-start fallback path, which has no visibility filter today; the normal public path serves the pre-baked `__nav__` blob that already excludes ROLE_GATED at build time, so this is defense-in-depth, not a change to the hot path). `preReleaseNavHandler` enumerates `ContentCurrent` slugs (reusing the fallback's ContentCurrent read), calls `buildNavTutorials(slugSet, { visibilityFilter: 'ROLE_GATED' })`, sets `Cache-Control: private, no-store`, and returns `{ version, count, tutorials }`. Do NOT read or write the shared slug-keyed `cache`. Export `preReleaseNavHandler`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- srv/__tests__/lib/prerelease-nav.test.js`
Expected: PASS.

- [ ] **Step 5: Mount the handler in `srv/server.js`**

Near line 850 (the existing gated serve mount), add: `app.get('/content/tutorials-prerelease/_nav', (req, res) => preReleaseNavHandler(req, res));` and add `preReleaseNavHandler` to the import from `./lib/content-store.js`.

- [ ] **Step 6: Run the broader content-store nav tests to confirm no public regression**

Run: `npm test -- srv/__tests__/lib/` (nav/content-store scope)
Expected: PASS — public `navHandler` still LISTED-only.

- [ ] **Step 7: Commit**

```bash
git add packages/content/content-store.js srv/server.js srv/__tests__/lib/prerelease-nav.test.js
git commit -m "feat(prerelease): live gated nav feed for ROLE_GATED tutorials (#3168)"
```

---

### Task 3: `prerelease` build channel (fetch + config + scripts)

Mirror the QA channel plumbing. Build-time, no runtime switch.

**Files:**
- Modify: `scripts/fetch-tutorials.ts` (extend `Channel` union + `--channel` validation line ~79-96; add `prerelease` cache/content/nav/static dir cases; filter the cataloged set to `visibility='ROLE_GATED'` for the `prerelease` channel, reading visibility off `/build/catalog`)
- Create: `hugo.prerelease.toml` (copy `hugo.qa.toml`; `dataDir = "data-prerelease"`, `params.prerelease = true`, prefix/baseURL for `/tutorials-prerelease/`)
- Create: `scripts/sync-island-manifest-prerelease.cjs` (copy `scripts/sync-island-manifest-qa.cjs`, retargeted to the prerelease data/public dirs) — or parameterize the QA one if trivial
- Modify: `package.json` scripts: add `fetch-tutorials:prerelease`, `build:prerelease`, `prerelease:full` (mirror `fetch-tutorials:qa`/`build:qa`/`qa:full`); wire `build:prerelease` into `build:all`
- Modify: `scripts/verify-qa-build.ts` → generalize or add `verify-prerelease-build` target for `hugo/public-prerelease`
- Test: `scripts/__tests__/fetch-tutorials-channel.test.ts` (create or extend existing channel test)

**Interfaces:**
- Consumes: `/build/catalog` payload (already carries `visibility` per tutorial).
- Produces: `hugo/data-prerelease/` (nav/browse data, ROLE_GATED only), `hugo/public-prerelease/` (built site incl. `index.html`), and the channel accepted by `--channel prerelease`.

- [ ] **Step 1: Write the failing test**

Assert `parseChannel(['--channel','prerelease'])` returns `'prerelease'` (currently throws `Unknown channel`), and that the prerelease dir helpers (`getQaCacheDir`/`getHugoContentDir`/`getNavJsonDir` or their generalized forms) return `*-prerelease`/`static-prerelease` paths for the prerelease channel.

```ts
test('prerelease channel parses and maps to prerelease dirs', () => {
  expect(parseChannel(['--channel','prerelease'])).toBe('prerelease')
  expect(getHugoContentDir('prerelease')).toMatch(/prerelease/)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- scripts/__tests__/fetch-tutorials-channel.test.ts`
Expected: FAIL — `Unknown channel: prerelease`.

- [ ] **Step 3: Extend the channel union + dir helpers + visibility filter**

`Channel = 'prod' | 'qa' | 'prerelease'`; accept it in `parseChannel`; add `prerelease` cases to the cache/content/nav/static dir helpers (`data-prerelease`, `static-prerelease`, `public-prerelease`). In the catalog→content step, when `channel === 'prerelease'` keep only tutorials whose catalog `visibility === 'ROLE_GATED'` (prod keeps LISTED, qa keeps its contribution set). Reuse the QA degraded-cache guard pattern if it applies.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- scripts/__tests__/fetch-tutorials-channel.test.ts`
Expected: PASS.

- [ ] **Step 5: Create `hugo.prerelease.toml`, the manifest-sync script, and the `package.json` scripts**

Copy `hugo.qa.toml` → `hugo.prerelease.toml` (set `dataDir`, `params.prerelease`, baseURL/prefix). Add scripts mirroring QA. Wire `build:prerelease` into `build:all` beside `build:qa`.

- [ ] **Step 6: Build the channel end-to-end (smoke)**

Run: `scripts/quiet-run.sh npm run fetch-tutorials:prerelease && scripts/quiet-run.sh npm run build:prerelease`
Expected: exit 0; `hugo/public-prerelease/tutorials-prerelease/index.html` (or the configured shell path) exists. (Requires `CAP_BASE_URL` pointing at a backend with a seeded ROLE_GATED tutorial, or an empty-but-valid build.)

- [ ] **Step 7: Commit**

```bash
git add scripts/fetch-tutorials.ts hugo.prerelease.toml scripts/sync-island-manifest-prerelease.cjs package.json scripts/verify-*.ts scripts/__tests__/fetch-tutorials-channel.test.ts
git commit -m "feat(prerelease): QA-style prerelease build channel (#3168)"
```

---

### Task 4: Navigator template `prerelease` branch

**Files:**
- Modify: `hugo/layouts/tutorial-navigator/list.html` (add `prerelease` to the channel conditions: the `{{ if not site.Params.qa }}` discovery-section gate at line 30/179, and the island data-attr line at line 41)
- Test: manual/visual via the Task 3 build output (template logic has no unit harness; covered by the Task 6 e2e).

**Interfaces:**
- Consumes: `site.Params.prerelease` (set by `hugo.prerelease.toml`), Task 2's `_nav.json` at `/tutorials-prerelease/_nav.json`.
- Produces: a navigator shell that mounts the island with `data-nav-base="/tutorials-prerelease"`, `data-href-base="/tutorials-prerelease"`, `data-client-search="true"`, and no `data-search-base` (client search).

- [ ] **Step 1: Extend the discovery-section gate**

Change `{{ if not site.Params.qa }}` (lines ~30, ~179) to also suppress the homepage/discovery sections for prerelease: `{{ if and (not site.Params.qa) (not site.Params.prerelease) }}`.

- [ ] **Step 2: Extend the island data-attr line (line ~41)**

Add a prerelease branch mirroring the QA one: when `site.Params.prerelease`, emit `data-nav-base="/tutorials-prerelease" data-href-base="/tutorials-prerelease" data-client-search="true"` and a "Pre-release" heading/badge. (No `data-search-base` — client search, confirmed: `TutorialNavigator.vue:27` + `useSearch.ts:18-21`.) Also update the `$hrefBase` SSR assignment (line ~198) to set `/tutorials-prerelease` when prerelease.

- [ ] **Step 3: Rebuild and eyeball the shell**

Run: `scripts/quiet-run.sh npm run build:prerelease`
Expected: the built `index.html` contains the island mount node with the prerelease data-attrs and omits the discovery sections.

- [ ] **Step 4: Commit**

```bash
git add hugo/layouts/tutorial-navigator/list.html
git commit -m "feat(prerelease): navigator template prerelease channel branch (#3168)"
```

---

### Task 5: Approuter routes (scope-gated surface)

**Files:**
- Modify: `approuter/xs-app.json` (add the prerelease route block BEFORE the existing `^/tutorials-prerelease/(.*)$` slug catch-all; mirror the QA static/index/asset/nav routes but `scope: "$XSAPPNAME.Tutorial.PreRelease"`)
- Modify: `.deploy/xs-app.json` if a synced copy exists (follow the #3099 `.deploy` sync convention — verify)

**Interfaces:**
- Consumes: static shell from Task 3/4 (built into the prerelease static dir), live nav feed from Task 2 (`/content/tutorials-prerelease/_nav`).
- Produces: scope-gated routes: `/tutorials-prerelease/` (index shell), `/tutorials-prerelease/<assets>`, `/tutorials-prerelease/_nav.json`; existing slug route unchanged and LAST.

- [ ] **Step 1: Add the route block (specific-before-catch-all ordering)**

Insert, before the slug route (and matching how QA maps `/qa/*` in the static dir — confirm the static path for prerelease, e.g. `/prerelease/index.html`):
```jsonc
{ "source": "^/tutorials-prerelease/?$", "target": "/prerelease/index.html",
  "localDir": "static", "authenticationType": "xsuaa", "scope": "$XSAPPNAME.Tutorial.PreRelease" },
{ "source": "^/tutorials-prerelease/((?:css|js|img|fonts|vendor)/.*)$", "target": "/$1",
  "localDir": "static", "authenticationType": "xsuaa", "scope": "$XSAPPNAME.Tutorial.PreRelease" },
{ "source": "^/tutorials-prerelease/_nav\\.json$", "target": "/content/tutorials-prerelease/_nav",
  "destination": "srv-api", "authenticationType": "xsuaa", "scope": "$XSAPPNAME.Tutorial.PreRelease" }
```
Leave the existing `^/tutorials-prerelease/(.*)$` → `/content/tutorials-prerelease/$1` slug route as the LAST of the group.

- [ ] **Step 2: Validate JSON**

Run: `jq . approuter/xs-app.json > /dev/null && echo OK`
Expected: `OK` (no parse error).

- [ ] **Step 3: Sync `.deploy` copy if the convention requires it**

Verify whether `.deploy/xs-app.json` is a tracked synced copy (as `.deploy/xs-security.json` was in #3099, commit `e44fe7176`). If so, apply the same edit there.

- [ ] **Step 4: Commit**

```bash
git add approuter/xs-app.json .deploy/xs-app.json
git commit -m "feat(prerelease): scope-gated navigator approuter routes (#3168)"
```

---

### Task 6: e2e + deploy-path wiring

**Files:**
- Create: `test/e2e/prerelease-navigator.spec.ts` (Playwright; self-skips without `SMOKE_BASE_URL` + `SMOKE_TECH_USER`/`PASSWORD`, per the repo e2e convention)
- Modify: deploy/rebuild wiring if `build:prerelease` isn't already carried by `build:all` + the MTA packaging of the static shell (verify Task 3 Step 5 covered `build:all`; confirm the MTA ships `public-prerelease`/the static shell)

**Interfaces:**
- Consumes: the deployed gated surface.

- [ ] **Step 1: Write the e2e spec**

With an authenticated `Tutorial.PreRelease` role-holder session: load `/tutorials-prerelease/`, assert the navigator island renders with ≥1 card for a seeded ROLE_GATED tutorial, filter/search client-side narrows the list, and clicking a card navigates to `/tutorials-prerelease/:slug` and renders `<main>`+`<h1>` (served tutorials render those, NOT `<article>` — per repo e2e note). Self-skip when the smoke env vars are absent.

- [ ] **Step 2: Confirm deploy packaging**

Verify `build:all` runs `build:prerelease` and the MTA approuter builder ships the prerelease static shell + assets (same mechanism as QA's `static-qa`). Document the baked-artifact wipe caution (rebuild-tarball / local-deploy-skip) in the PR description and, if a runbook touches QA channels, add a prerelease line.

- [ ] **Step 3: Commit**

```bash
git add test/e2e/prerelease-navigator.spec.ts
git commit -m "test(prerelease): e2e navigator smoke + deploy-path note (#3168)"
```

---

## Notes for the executor

- **Known DEV bug to avoid reintroducing:** server-side `$search` KG-rerank 500s on HANA (broken simple-CASE). This plan uses **client-side** search (no server `$search` for prerelease), so it's avoided — do not add a server search service.
- After all tasks: run the scoped unit suites that were touched (`npm test -- srv/__tests__/lib/ scripts/__tests__/`) and open a PR to **DEV** (`gh pr create --base DEV`). Do not merge to `main`.
