# Browsable QA Index with Search — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the already-built QA home page (`/tutorials-qa/`) reachable and functional as a browsable index with live search over QA-published content.

**Architecture:** Config-driven reuse of the shared `#tutorial-navigator` Vue island. The island gains three injectable endpoint bases (`searchBase`, `navBase`, `hrefBase`) read from mount `data-*` attributes; defaults reproduce prod behavior byte-for-byte. The QA Hugo build injects QA bases and emits a channel-aware `browse.json` for the initial grid. A new approuter route serves the QA home at the channel root.

**Tech Stack:** Vue 3 (Composition API, `<script setup>`), TypeScript, Vitest, Hugo (Go templates), SAP AppRouter (`xs-app.json`), Node/tsx build scripts.

## Global Constraints

- **Prod byte-identical invariant:** with default bases (no `data-*` attrs), every emitted URL and card href MUST equal today's exact strings (`/search/SearchableItems`, `/search/getFacets(...)`, `/tutorials/_nav.json`, `href: /tutorials/<slug>`). This is the load-bearing safety property — assert it explicitly in tests.
- **Scope:** search + flat grid only. No missions/groups/for-you rails. Do NOT repoint `/build/navigator` or `/build/my-progress` (out-of-scope / user-global).
- **QA auth:** the QA channel is XSUAA + `$XSAPPNAME.Tutorial.Author` gated. New routes carry that scope.
- **Route order is load-bearing:** `^/tutorials-qa/?$` MUST precede the catch-all `^/tutorials-qa/(.*)$` in `approuter/xs-app.json`.
- **Test runner:** hugo-apps unit tests run under Vitest via `npm run test:apps` (or `npx vitest run <file>` from `hugo-apps/`). Do NOT introduce a `@sap/cds` import into hugo-apps setup.
- **Commit cadence:** commit after each task's tests pass. Branch: `worktree-qa-index-search`.
- **`site.Params.qa`** is already `true` under `hugo.qa.toml` and used elsewhere in `tutorial-navigator/list.html` — reuse it, do not invent a new flag.

---

### Task 1: Injectable `searchBase` + `hrefBase` in `useSearch.ts`

Adds base parameters to the two URL builders and the SearchableItems fetch, defaulting to today's prod strings.

**Files:**
- Modify: `hugo-apps/src/navigator/useSearch.ts` (`buildFacetsUrl` :71-83, `mapToCardItem` :16-36, `executeSearch` fetches :180-183, `useSearch` options :128-129)
- Test: `hugo-apps/src/navigator/useSearch.test.ts`

**Interfaces:**
- Produces:
  - `buildFacetsUrl(term: string, taskTypes: string[], experience: string[], searchBase?: string): string` — `searchBase` defaults to `'/search'`.
  - `mapToCardItem(item: SearchableItem, tutorialsBySlug?: Map<string, TutorialEntry>, hrefBase?: string): CardItem` — `hrefBase` defaults to `'/tutorials'`.
  - `UseSearchOptions` gains `searchBase?: string` and `hrefBase?: string`.

- [ ] **Step 1: Write the failing test**

Add to `hugo-apps/src/navigator/useSearch.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { buildFacetsUrl, mapToCardItem } from './useSearch'
import type { SearchableItem } from '@shared/types'

describe('endpoint base injection', () => {
  const sampleItem = {
    ID: 't1', title: 'CAP Basics', description: 'd',
    taskType: 'TUTORIAL', slug: 'cap-basics',
    primaryTag: 'cap', experienceTag: 'beginner', averageTimeToComplete: 10,
  } as SearchableItem

  it('buildFacetsUrl defaults to the prod /search base (byte-identical)', () => {
    const url = buildFacetsUrl('abap', [], [])
    expect(url.startsWith('/search/getFacets(')).toBe(true)
  })

  it('buildFacetsUrl honors a custom searchBase', () => {
    const url = buildFacetsUrl('abap', [], [], '/qa-search')
    expect(url.startsWith('/qa-search/getFacets(')).toBe(true)
  })

  it('mapToCardItem defaults to the prod /tutorials href', () => {
    expect(mapToCardItem(sampleItem).href).toBe('/tutorials/cap-basics')
  })

  it('mapToCardItem honors a custom hrefBase', () => {
    expect(mapToCardItem(sampleItem, undefined, '/tutorials-qa').href).toBe('/tutorials-qa/cap-basics')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `hugo-apps/`): `npx vitest run src/navigator/useSearch.test.ts -t "endpoint base injection"`
Expected: FAIL — `buildFacetsUrl` ignores the 4th arg (still `/search/`), `mapToCardItem` ignores the 3rd arg.

- [ ] **Step 3: Write minimal implementation**

In `useSearch.ts`, change `buildFacetsUrl` signature + return (line ~71, ~82):

```ts
export function buildFacetsUrl(term: string, taskTypes: string[], experience: string[], searchBase = '/search'): string {
  const parts: string[] = ['search=@s']
  const query: string[] = [`@s=${encodeODataValue(`'${escOData(term)}'`)}`]
  if (taskTypes.length) {
    parts.push('taskTypes=@t')
    query.push(`@t=${encodeODataValue(JSON.stringify(taskTypes.map(t => t.toUpperCase())))}`)
  }
  if (experience.length) {
    parts.push('experience=@e')
    query.push(`@e=${encodeODataValue(JSON.stringify(experience))}`)
  }
  return `${searchBase}/getFacets(${parts.join(',')})?${query.join('&')}`
}
```

Change `mapToCardItem` signature + href (line ~16, ~33):

```ts
export function mapToCardItem(item: SearchableItem, tutorialsBySlug?: Map<string, TutorialEntry>, hrefBase = '/tutorials'): CardItem {
  // ...unchanged body...
    href: item.slug ? `${hrefBase}/${item.slug}` : '',
  // ...
}
```

Add to `UseSearchOptions` (line ~6-14):

```ts
  searchBase?: string
  hrefBase?: string
```

In `useSearch`, destructure them with defaults (line ~129) and use inside `executeSearch` (lines ~180-183, ~194):

```ts
  const { searchTerm, filterTypes, filterLevels, filterProducts, filterIsNew, filterNoLicense, tutorials,
          searchBase = '/search', hrefBase = '/tutorials' } = options
```

```ts
      const [itemsRes, facetsRes] = await Promise.all([
        fetch(`${searchBase}/SearchableItems?${qs.join('&')}`),
        fetch(buildFacetsUrl(term, filterTypes.value, filterLevels.value, searchBase)),
      ])
```

```ts
      const cards = (itemsData.value ?? []).map((it: SearchableItem) =>
        mapToCardItem(it, tutorialsBySlug.value, hrefBase)
      )
```

- [ ] **Step 4: Run tests to verify they pass**

Run (from `hugo-apps/`): `npx vitest run src/navigator/useSearch.test.ts`
Expected: PASS (new cases + all pre-existing `useSearch` cases — the byte-identical defaults keep them green).

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/navigator/useSearch.ts hugo-apps/src/navigator/useSearch.test.ts
git commit -m "feat(navigator): injectable searchBase/hrefBase in useSearch (prod default unchanged)"
```

---

### Task 2: Forward bases through `useNavigatorFilters`

The `.vue` talks to `useSearch` via this composable; it must pass the bases through and expose `navBase`.

**Files:**
- Modify: `hugo-apps/src/shared/composables/useNavigatorFilters.ts` (`UseNavigatorFiltersOptions` :27-33, `useSearch({...})` call :314-322, return object)
- Test: `hugo-apps/src/shared/composables/useNavigatorFilters.test.ts`

**Interfaces:**
- Consumes: `useSearch` options `searchBase`/`hrefBase` (Task 1).
- Produces:
  - `UseNavigatorFiltersOptions` gains `searchBase?: string`, `hrefBase?: string`, `navBase?: string`.
  - The composable's return object includes `navBase: string` (defaults `'/tutorials'`), for the `.vue` to build its `_nav.json` URL.

- [ ] **Step 1: Write the failing test**

Add to `hugo-apps/src/shared/composables/useNavigatorFilters.test.ts`:

```ts
import { ref } from 'vue'
import { useNavigatorFilters } from './useNavigatorFilters'

describe('endpoint base forwarding', () => {
  it('defaults navBase to /tutorials when not supplied', () => {
    const r = useNavigatorFilters({ allCards: ref([]) })
    expect(r.navBase).toBe('/tutorials')
  })

  it('exposes a supplied navBase', () => {
    const r = useNavigatorFilters({ allCards: ref([]), navBase: '/tutorials-qa' })
    expect(r.navBase).toBe('/tutorials-qa')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `hugo-apps/`): `npx vitest run src/shared/composables/useNavigatorFilters.test.ts -t "endpoint base forwarding"`
Expected: FAIL — `r.navBase` is `undefined` (not in return object yet).

- [ ] **Step 3: Write minimal implementation**

Extend the options interface (line ~27):

```ts
export interface UseNavigatorFiltersOptions {
  allCards: Ref<CardItem[]>
  tutorials?: Ref<TutorialEntry[]>
  enableSort?: boolean
  syncURL?: boolean
  pageSize?: number
  searchBase?: string
  hrefBase?: string
  navBase?: string
}
```

Destructure with defaults where the function opens (line ~244, alongside existing `opts` reads):

```ts
export function useNavigatorFilters(opts: UseNavigatorFiltersOptions) {
  const { searchBase = '/search', hrefBase = '/tutorials', navBase = '/tutorials' } = opts
```

Pass into the `useSearch` call (line ~314):

```ts
  } = useSearch({
    searchTerm: searchQuery,
    filterTypes: computed(() => filters.types.map(t => t.toUpperCase())),
    filterLevels: computed(() => filters.levels),
    filterProducts: computed(() => filters.products),
    filterIsNew: computed(() => filters.isNew),
    filterNoLicense: computed(() => filters.noLicense),
    tutorials,
    searchBase,
    hrefBase,
  })
```

Add `navBase` to the composable's return object (the final `return { ... }`):

```ts
    navBase,
```

- [ ] **Step 4: Run tests to verify they pass**

Run (from `hugo-apps/`): `npx vitest run src/shared/composables/useNavigatorFilters.test.ts`
Expected: PASS (new cases + pre-existing).

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/shared/composables/useNavigatorFilters.ts hugo-apps/src/shared/composables/useNavigatorFilters.test.ts
git commit -m "feat(navigator): forward searchBase/hrefBase/navBase through useNavigatorFilters"
```

---

### Task 3: Read `data-*` attrs + repoint `_nav.json` in `TutorialNavigator.vue`

Wire the mount's data-attributes into the composable and repoint the `_nav.json` fetch.

**Files:**
- Modify: `hugo-apps/src/navigator/TutorialNavigator.vue` (`<script setup>` head ~:18, `useNavigatorFilters({...})` :185-189, `onMounted` fetch :235)
- Test: `hugo-apps/src/navigator/__tests__/navigator-regression.test.ts`

**Interfaces:**
- Consumes: `useNavigatorFilters` options + returned `navBase` (Task 2).
- Produces: island reads `#tutorial-navigator` `dataset.searchBase|navBase|hrefBase`; `_nav.json` fetched from `${navBase}/_nav.json`.

- [ ] **Step 1: Write the failing test**

Add to `hugo-apps/src/navigator/__tests__/navigator-regression.test.ts` a case asserting the mount's `data-nav-base` repoints the `_nav.json` fetch. Follow the file's existing mount+stub-fetch harness (it already stubs `/tutorials/_nav.json`, `/build/navigator`, `/build/my-progress`, `/search/SearchableItems`). Add:

```ts
it('fetches _nav.json from the QA nav base when data-nav-base is set', async () => {
  const el = document.getElementById('tutorial-navigator')!
  el.dataset.searchBase = '/qa-search'
  el.dataset.navBase = '/tutorials-qa'
  el.dataset.hrefBase = '/tutorials-qa'

  const fetched: string[] = []
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    fetched.push(url)
    return Promise.resolve({ ok: true, json: async () => ({ tutorials: [] }) })
  }))

  mount(TutorialNavigator, { attachTo: el })
  await flushPromises()

  expect(fetched.some(u => u.startsWith('/tutorials-qa/_nav.json'))).toBe(true)
  expect(fetched.some(u => u === '/tutorials/_nav.json')).toBe(false)
})
```

(Match the file's actual import names for `mount`/`flushPromises`/`vi` — reuse whatever the surrounding tests use.)

- [ ] **Step 2: Run test to verify it fails**

Run (from `hugo-apps/`): `npx vitest run src/navigator/__tests__/navigator-regression.test.ts -t "QA nav base"`
Expected: FAIL — island still fetches the hardcoded `/tutorials/_nav.json`.

- [ ] **Step 3: Write minimal implementation**

Near the top of `<script setup>` (after the `ref` declarations, ~line 21), read the mount dataset:

```ts
// QA channel repoints these via data-* on the #tutorial-navigator mount.
// Defaults reproduce prod behavior exactly (see spec: prod byte-identical invariant).
const navEl = typeof document !== 'undefined' ? document.getElementById('tutorial-navigator') : null
const searchBase = navEl?.dataset.searchBase || '/search'
const navBase = navEl?.dataset.navBase || '/tutorials'
const hrefBase = navEl?.dataset.hrefBase || '/tutorials'
```

Pass into `useNavigatorFilters` (line ~185):

```ts
} = useNavigatorFilters({
  allCards,
  tutorials,
  enableSort: true,
  searchBase,
  hrefBase,
  navBase,
})
```

Repoint the `_nav.json` fetch in `onMounted` (line ~235):

```ts
    fetch(`${navBase}/_nav.json`),
```

- [ ] **Step 4: Run tests to verify they pass**

Run (from `hugo-apps/`): `npx vitest run src/navigator/__tests__/navigator-regression.test.ts`
Expected: PASS (new case + all pre-existing regression cases — default path still hits `/tutorials/_nav.json`, `/search/...`).

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/navigator/TutorialNavigator.vue hugo-apps/src/navigator/__tests__/navigator-regression.test.ts
git commit -m "feat(navigator): read data-* bases and repoint _nav.json for QA"
```

---

### Task 4: Channel-aware `browse.json` in `fetch-tutorials.ts`

Emit `hugo/data-qa/browse.json` on the QA run so the QA home's initial grid is populated.

**Files:**
- Modify: `scripts/fetch-tutorials.ts` (`BROWSE_DATA_FILE` const :1341, `writeBrowseData` :1579-1616, the caller gate ~:1199-1208)
- Test: `scripts/__tests__/fetch-tutorials-browse-channel.test.ts` (new; if `scripts/__tests__/` doesn't exist, colocate as `scripts/fetch-tutorials-browse-channel.test.ts` next to sibling script tests — check where existing `scripts/*.test.ts` live first)

**Interfaces:**
- Consumes: existing `Channel` type + `HUGO_DATA_DIR`.
- Produces: `browseDataFile(channel: Channel): string` — returns `hugo/data/browse.json` for `'prod'`, `hugo/data-qa/browse.json` for `'qa'`. Exported for test.

- [ ] **Step 1: Write the failing test**

Create the test (adjust import path to the real relative location):

```ts
import { describe, it, expect } from 'vitest'
import { browseDataFile } from '../fetch-tutorials'

describe('browseDataFile channel awareness', () => {
  it('writes prod browse.json under hugo/data', () => {
    expect(browseDataFile('prod').replace(/\\/g, '/')).toMatch(/hugo\/data\/browse\.json$/)
  })
  it('writes qa browse.json under hugo/data-qa', () => {
    expect(browseDataFile('qa').replace(/\\/g, '/')).toMatch(/hugo\/data-qa\/browse\.json$/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run (from repo root): `npx vitest run scripts/__tests__/fetch-tutorials-browse-channel.test.ts`
Expected: FAIL — `browseDataFile` is not exported / does not exist.

- [ ] **Step 3: Write minimal implementation**

In `fetch-tutorials.ts`, replace the hardcoded const (line ~1341) with a channel-aware helper. `HUGO_DATA_DIR` currently points at `hugo/data`; derive the qa sibling:

```ts
// Channel-aware browse.json target. Prod → hugo/data/browse.json (Hugo default
// dataDir); QA → hugo/data-qa/browse.json (hugo.qa.toml sets dataDir="data-qa").
export function browseDataFile(channel: Channel): string {
  const dir = join(__dirname, '..', 'hugo', channel === 'qa' ? 'data-qa' : 'data')
  return join(dir, 'browse.json')
}
```

Leave the existing `HUGO_DATA_DIR` const in place. Grep `grep -n BROWSE_DATA_FILE scripts/fetch-tutorials.ts` — if only `writeBrowseData` uses `BROWSE_DATA_FILE` (line 1615), remove that const; otherwise leave it.

Update `writeBrowseData` to take the channel and use the helper. Its current body ends (lines ~1614-1616) with `mkdirSync(HUGO_DATA_DIR, ...)` + `writeFileSync(BROWSE_DATA_FILE, ...)`; replace those two lines:

```ts
function writeBrowseData(
  navEntries: /* existing params unchanged */,
  channel: Channel,
) {
  // ...existing body building `data`, `all`, `featured`, `recent`...
  const outFile = browseDataFile(channel)
  mkdirSync(dirname(outFile), { recursive: true })   // data-qa/ may not exist yet
  writeFileSync(outFile, JSON.stringify(data, null, 2), 'utf-8')
  console.log(`  [browse] wrote ${all.length} cards (${featured.length} featured, ${recent.length} recent) → ${outFile}`)
}
```

Pass `channel` at the call site (line ~1205); it's already in scope in `main` as `channel`:

```ts
      writeBrowseData(navEntries, missions, hierarchies, standaloneGroups, categories, tutorialMetas, featured, channel)
```

Ensure `mkdirSync`, `dirname` are imported (they likely already are; add to the existing `node:fs` / `node:path` imports if not).

- [ ] **Step 4: Run tests to verify they pass**

Run (from repo root): `npx vitest run scripts/__tests__/fetch-tutorials-browse-channel.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/fetch-tutorials.ts scripts/__tests__/fetch-tutorials-browse-channel.test.ts
git commit -m "feat(build): channel-aware browse.json (qa → hugo/data-qa)"
```

---

### Task 5: QA template `data-*` attrs in `tutorial-navigator/list.html`

Emit the QA endpoint bases onto the mount div, gated by the existing `site.Params.qa`.

**Files:**
- Modify: `hugo/layouts/tutorial-navigator/list.html` (mount div `:33`)
- Test: manual QA-build assertion (Task 6 wires the automated guard); this task's verification is a grep of built output.

**Interfaces:**
- Consumes: `site.Params.qa` (already `true` under `hugo.qa.toml`).
- Produces: `#tutorial-navigator` carries `data-search-base`, `data-nav-base`, `data-href-base` only on QA builds.

- [ ] **Step 1: Edit the mount div**

Change line ~33 from:

```go-html-template
    <div id="tutorial-navigator">
```

to:

```go-html-template
    <div id="tutorial-navigator"{{ if site.Params.qa }} data-search-base="/qa-search" data-nav-base="/tutorials-qa" data-href-base="/tutorials-qa"{{ end }}>
```

- [ ] **Step 2: Build QA + verify attrs present**

Run (from repo root): `npm run fetch-tutorials:qa && npm run build:qa`
Then: `grep -o 'id=tutorial-navigator[^>]*' hugo/public-qa/index.html`
Expected: output includes `data-search-base=/qa-search data-nav-base=/tutorials-qa data-href-base=/tutorials-qa`.

- [ ] **Step 3: Verify prod build is unaffected**

Run (from repo root): `npm run fetch-tutorials && npm run dev &` (or a prod Hugo build), then:
`grep -o 'id=tutorial-navigator[^>]*' hugo/public/index.html || grep -ro 'id=tutorial-navigator[^>]*' hugo/public/tutorial-navigator/index.html`
Expected: NO `data-search-base` attribute (prod mount unchanged).

- [ ] **Step 4: Verify QA #browse-data is populated**

Run: `grep -o '"all":\[[^]]' hugo/public-qa/index.html | head -c 40`
Expected: non-empty array start (`"all":[{`) — confirms Task 4's `data-qa/browse.json` fed the grid.

- [ ] **Step 5: Commit**

```bash
git add hugo/layouts/tutorial-navigator/list.html
git commit -m "feat(qa): emit data-* endpoint bases on navigator mount for QA channel"
```

---

### Task 6: Root approuter route + route-order guard

Route `/tutorials-qa/` (and `/tutorials-qa`) to the static QA index, before the catch-all.

**Files:**
- Modify: `approuter/xs-app.json` (QA route block; insert before `^/tutorials-qa/(.*)$`)
- Test: `test/unit/approuter/xs-app-graph-routes.test.js`

**Interfaces:**
- Consumes: nothing from prior tasks (pure config + test).
- Produces: reachable `GET /tutorials-qa/` → static `/qa/index.html`, XSUAA + `Tutorial.Author`.

- [ ] **Step 1: Write the failing test**

Add to `test/unit/approuter/xs-app-graph-routes.test.js` (match the file's existing load of `approuter/xs-app.json`):

```js
it('serves the QA index root before the QA catch-all', () => {
  const routes = xsApp.routes
  const rootIdx = routes.findIndex(r => r.source === '^/tutorials-qa/?$')
  const catchAllIdx = routes.findIndex(r => r.source === '^/tutorials-qa/(.*)$')
  expect(rootIdx).toBeGreaterThanOrEqual(0)
  expect(catchAllIdx).toBeGreaterThanOrEqual(0)
  expect(rootIdx).toBeLessThan(catchAllIdx)

  const root = routes[rootIdx]
  expect(root.localDir).toBe('static')
  expect(root.target).toBe('/qa/index.html')
  expect(root.authenticationType).toBe('xsuaa')
  expect(root.scope).toBe('$XSAPPNAME.Tutorial.Author')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run (from repo root): `npx vitest run test/unit/approuter/xs-app-graph-routes.test.js -t "QA index root"`
Expected: FAIL — no such route yet (`rootIdx === -1`).

- [ ] **Step 3: Add the route**

In `approuter/xs-app.json`, insert this object **immediately before** the `^/tutorials-qa/(.*)$` route (and before the `^/tutorials-qa/_nav\.json$` route is fine too — most-specific already precede the catch-all; place the root route just above the catch-all):

```json
    {
      "source": "^/tutorials-qa/?$",
      "target": "/qa/index.html",
      "localDir": "static",
      "authenticationType": "xsuaa",
      "scope": "$XSAPPNAME.Tutorial.Author"
    },
```

- [ ] **Step 4: Run tests to verify they pass**

Run (from repo root):
```bash
npx vitest run test/unit/approuter/xs-app-graph-routes.test.js
npx tsx scripts/check-xs-app-mta.ts
```
Expected: route test PASS; `check-xs-app-mta.ts` reports no drift (the new route is static-served from `hugo/public-qa` copied into `static/qa/` — already covered by the QA build copy in `mta.yaml`).

- [ ] **Step 5: Commit**

```bash
git add approuter/xs-app.json test/unit/approuter/xs-app-graph-routes.test.js
git commit -m "feat(approuter): route /tutorials-qa/ root to static QA index (before catch-all)"
```

---

### Task 7: QA-build smoke assertion in `verify-qa-build.ts`

Guard that the QA home ships with a populated grid and the QA data-attrs.

**Files:**
- Modify: `scripts/verify-qa-build.ts`
- Test: this script IS the test; run it against a QA build.

**Interfaces:**
- Consumes: built `hugo/public-qa/index.html` (Tasks 4 + 5).
- Produces: `verify-qa-build.ts` exits non-zero if the QA index is missing `data-search-base` or has an empty `#browse-data`.

- [ ] **Step 1: Add the assertions**

In `scripts/verify-qa-build.ts`, after the existing checks, read `<publicQaDir>/index.html` and assert:

```ts
const indexHtml = readFileSync(join(publicQaDir, 'index.html'), 'utf-8')

if (!/id=["']?tutorial-navigator["']?[^>]*data-search-base=["']?\/qa-search/.test(indexHtml)) {
  fail('QA index.html: #tutorial-navigator is missing data-search-base="/qa-search"')
}

const browseMatch = indexHtml.match(/<script id=["']?browse-data["']?[^>]*>(.*?)<\/script>/s)
const browseJson = browseMatch ? JSON.parse(browseMatch[1]) : { all: [] }
if (!Array.isArray(browseJson.all) || browseJson.all.length === 0) {
  fail('QA index.html: #browse-data grid is empty — data-qa/browse.json was not emitted')
}
```

(Use the file's existing `fail()` / error-collection idiom and its `publicQaDir` argument — do not invent a new failure mechanism.)

- [ ] **Step 2: Run it against a fresh QA build**

Run (from repo root): `npm run fetch-tutorials:qa && npm run build:qa`
(`build:qa` already invokes `tsx scripts/verify-qa-build.ts hugo/public-qa` as its second half.)
Expected: exits 0; logs the new checks passing.

- [ ] **Step 3: Negative check (optional, manual)**

Temporarily rename `hugo/data-qa/browse.json`, re-run `npm run build:qa`.
Expected: `verify-qa-build.ts` exits non-zero with the "grid is empty" message. Restore the file.

- [ ] **Step 4: Commit**

```bash
git add scripts/verify-qa-build.ts
git commit -m "test(qa): verify-qa-build asserts populated grid + QA data-attrs"
```

---

## Final verification (after all tasks)

- [ ] Full hugo-apps unit suite: `cd hugo-apps && npm test` — all green (prod byte-identical invariant holds).
- [ ] `npx tsx scripts/check-xs-app-mta.ts` — no drift.
- [ ] `npm run fetch-tutorials:qa && npm run build:qa` — succeeds, `verify-qa-build.ts` passes.
- [ ] Open draft PR; note in the description that this requires a **+QA-scope deploy** (fetch-tutorials:qa + build:qa must run before `mbt build`).

## Self-Review Notes

- **Spec coverage:** Task 1 = component 1; Task 2 = component 2; Task 3 = component 3; Task 4 = component 4; Task 6 = component 5 (route); Task 5 = component 6 (template attrs); Task 7 = the `verify-qa-build` test row. `navBase`/`_nav.json` repoint (post-approval discovery) covered by Tasks 2+3. Error handling (empty browse.json → existing empty-state; `/qa-search` fail → existing `searchError`) needs no new code — noted, no task required.
- **Left-on-prod endpoints** (`/build/navigator`, `/build/my-progress`) are deliberately untouched per the repoint decision — no task, by design.
