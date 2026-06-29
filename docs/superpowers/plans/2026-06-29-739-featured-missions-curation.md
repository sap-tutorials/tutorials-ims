# Issue #739 — Featured Missions Curation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire `writeBrowseData()` in `scripts/fetch-tutorials.ts` to consume the `featured` array that `/build/catalog` already returns, with the existing regex-sieved catalog-order picker as the fallback. Move the "Featured Tasks" side-nav entry from the System group to the Content group.

**Architecture:** Extract the featured-mission picker into a pure helper function. The helper takes the catalog's `featured` array (filtered to type=mission) and the full `BrowseCardItem[]` list; returns the curated mission slugs if any exist, otherwise the regex-sieved catalog-order fallback. Add a unit test for the helper. Surface the catalog `featured` array through `scripts/parsers/cap.ts` (today it's silently dropped during JSON parsing). Then a one-line `navigation.json` edit moves the side-nav entry.

**Tech Stack:** TypeScript (scripts/), vitest, JSON config (navigation.json).

**Spec:** [`docs/superpowers/specs/2026-06-29-739-featured-missions-curation-design.md`](../specs/2026-06-29-739-featured-missions-curation-design.md)

---

## File Structure

### Modified files (3)

- `scripts/parsers/cap.ts` — extend `fetchBuildCatalog` return shape with `featured: BrowseFeaturedEntry[]`; extend `CapCacheData` interface to persist it in the cache. Default to `[]` when missing.
- `scripts/fetch-tutorials.ts` — extract the existing featured-picker (lines 1474-1478) into a pure helper `pickFeaturedMissions()`; wire the helper to consume `catalog.featured` with fallback. Thread `featured` through the writeBrowseData signature and the cap-cache wiring.
- `app/admin-shell/webapp/model/navigation.json` — remove `{ "key": "operations", "title": "Featured Tasks" }` from the System group's items; insert it into the Content group's items after `alerts`.

### Added files (1)

- `test/unit/scripts/featured-mission-picker.test.ts` — seven-case unit test for the new helper.

### NOT modified

- `db/schema.cds`, `srv/admin-service.cds`, `srv/admin-service.js`, `app/admin-annotations.cds`, `app/admin/operations/webapp/manifest.json`, `srv/lib/build-catalog.js`, `srv/lib/_classify-rebuild-mode.js`, `hugo/layouts/partials/homepage/tutorials-teaser.html`, `app/admin-shell/webapp/manifest.json`, `app/admin-shell/webapp/controller/Shell.controller.js` — all already wired correctly per spec §2.3.
- `test/unit/scripts/featured-mission-filter.test.ts` — keeps testing the `EVENT_MISSION_RE` regex sieve. The sieve still ships and is still used in the fallback path.

---

## Task 1: Extend `cap.ts` to surface the `featured` array

**Files:**
- Modify: `scripts/parsers/cap.ts` (lines ~10-78 — interface declarations + `fetchBuildCatalog` return shape + cache type + cache loader)

The catalog response from `/build/catalog` already contains `featured: [{type, slug, title, description}, ...]`. Today `fetchBuildCatalog` parses the JSON but silently drops `featured` because it's not in the return shape. We add it.

- [ ] **Step 1: Read the current state**

Run:
```bash
cd D:/projects/tutorials-poc/.claude/worktrees/739-featured-missions-curation
sed -n '1,100p' scripts/parsers/cap.ts
```

Expected: see `CapCacheData` interface (~line 11), `loadCapCache` (~line 20), `saveCapCache` (~line 32), `fetchBuildCatalog` (~line 44), and the inline-typed `data` shape inside `fetchBuildCatalog` (~line 60).

- [ ] **Step 2: Add the `BrowseFeaturedEntry` type export at the top of the file**

Insert just after the existing `import` lines (around line 4):

```ts
/**
 * Shape of one entry in /build/catalog's `featured` array. Matches the
 * server-side `resolveFeatured()` output in srv/lib/build-catalog.js.
 * Top-6 by FeaturedTasks.featuredOrder, resolved across mission/group/
 * tutorial taskTypes. Consumed by scripts/fetch-tutorials.ts to curate
 * the homepage hp-teaser band (issue #739).
 */
export interface BrowseFeaturedEntry {
  type: 'mission' | 'group' | 'tutorial'
  slug: string
  title: string
  description: string
}
```

- [ ] **Step 3: Extend `CapCacheData` to include `featured`**

Locate the existing `CapCacheData` interface (~lines 11-18). Add a new optional field after `tutorialMetas`:

```ts
interface CapCacheData {
  timestamp: number
  missions: Mission[]
  hierarchies: MissionHierarchy[]
  standaloneGroups?: StandaloneGroup[]     // optional — older caches won't have it
  categories?: CategoryMeta[]              // optional — older caches won't have it
  tutorialMetas?: CatalogTutorialMeta[]    // optional — older caches won't have it
  featured?: BrowseFeaturedEntry[]         // optional — pre-#739 caches won't have it
}
```

Then add a staleness guard to `loadCapCache` so pre-#739 caches force a refetch. Locate the existing guard for `standaloneGroups` (~line 25):

```ts
    // Treat caches missing the new field as stale to force refetch.
    if (!Array.isArray(data.standaloneGroups)) return null
```

Add a parallel guard for `featured` immediately after it:

```ts
    if (!Array.isArray(data.standaloneGroups)) return null
    if (!Array.isArray(data.featured)) return null
```

Without this guard, an in-TTL cache (<24h old) from before this PR would return `cached.featured === undefined`, the fallback path would silently fire for the next 24h, and the new picker wouldn't take effect until either the cache expired or someone deleted `.tutorial-cache/`. Mirrors the precedent set when `standaloneGroups` was added.

- [ ] **Step 4: Extend `saveCapCache` signature to accept `featured`**

Locate the existing `saveCapCache` function (~lines 32-42). Update the signature and the persisted object:

```ts
export function saveCapCache(
  missions: Mission[],
  hierarchies: MissionHierarchy[],
  standaloneGroups: StandaloneGroup[],
  categories: CategoryMeta[] = [],
  tutorialMetas: CatalogTutorialMeta[] = [],
  featured: BrowseFeaturedEntry[] = [],
): void {
  mkdirSync(dirname(CACHE_FILE), { recursive: true })
  const data: CapCacheData = { timestamp: Date.now(), missions, hierarchies, standaloneGroups, categories, tutorialMetas, featured }
  writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2), 'utf-8')
}
```

- [ ] **Step 5: Extend `fetchBuildCatalog` return shape and inline-typed response**

Locate `fetchBuildCatalog` (~lines 44-78). Two changes inside the function body:

**(a)** The function's declared return-type Promise: add `featured` to the inline object type. Find:

```ts
export async function fetchBuildCatalog(baseUrl: string): Promise<{
  missions: Mission[]
  hierarchies: MissionHierarchy[]
  standaloneGroups: StandaloneGroup[]
  categories: CategoryMeta[]
  tutorialMetas: CatalogTutorialMeta[]
}> {
```

Change to:

```ts
export async function fetchBuildCatalog(baseUrl: string): Promise<{
  missions: Mission[]
  hierarchies: MissionHierarchy[]
  standaloneGroups: StandaloneGroup[]
  categories: CategoryMeta[]
  tutorialMetas: CatalogTutorialMeta[]
  featured: BrowseFeaturedEntry[]
}> {
```

**(b)** The inline-typed `data` object inside the function and the final `return` statement. Find:

```ts
  const data = await res.json() as {
    missions: Mission[]
    hierarchies: MissionHierarchy[]
    standaloneGroups?: StandaloneGroup[]
    categories?: CategoryMeta[]
    tutorials?: Array<{ slug: string; categorySlugs?: string[] }>
  }
  const tutorialMetas: CatalogTutorialMeta[] = (data.tutorials ?? []).map(t => ({
    slug: t.slug,
    categorySlugs: t.categorySlugs ?? [],
  }))
  return {
    missions: data.missions,
    hierarchies: data.hierarchies,
    standaloneGroups: data.standaloneGroups ?? [],
    categories: data.categories ?? [],
    tutorialMetas,
  }
```

Change to (add `featured?: BrowseFeaturedEntry[]` to the inline type and `featured: data.featured ?? []` to the return):

```ts
  const data = await res.json() as {
    missions: Mission[]
    hierarchies: MissionHierarchy[]
    standaloneGroups?: StandaloneGroup[]
    categories?: CategoryMeta[]
    tutorials?: Array<{ slug: string; categorySlugs?: string[] }>
    featured?: BrowseFeaturedEntry[]
  }
  const tutorialMetas: CatalogTutorialMeta[] = (data.tutorials ?? []).map(t => ({
    slug: t.slug,
    categorySlugs: t.categorySlugs ?? [],
  }))
  return {
    missions: data.missions,
    hierarchies: data.hierarchies,
    standaloneGroups: data.standaloneGroups ?? [],
    categories: data.categories ?? [],
    tutorialMetas,
    featured: data.featured ?? [],
  }
```

- [ ] **Step 6: Confirm tsc compiles**

Run:
```bash
npx tsc --noEmit -p . 2>&1 | grep -i "scripts/parsers/cap.ts\|scripts/fetch-tutorials.ts" | head -20
```

Expected: zero errors related to `cap.ts`. There may be a `fetch-tutorials.ts` error about the new `featured` field not being consumed (Tasks 2-3 fix that). Other unrelated tsc warnings in the project are fine.

- [ ] **Step 7: Commit**

```bash
git add scripts/parsers/cap.ts
git -c core.autocrlf=false commit -m "feat(#739): surface /build/catalog featured array through cap.ts

The CAP endpoint already returns 'featured: [{type, slug, title,
description}, ...]' (top 6 by FeaturedTasks.featuredOrder), but
fetchBuildCatalog silently dropped it because it wasn't in the
return shape. This adds the BrowseFeaturedEntry type, threads
the array through fetchBuildCatalog + saveCapCache + the
CapCacheData interface, and defaults to [] when absent (older
srv versions / pre-#739 caches).

writeBrowseData() consumes this in Task 2."
```

---

## Task 2: Extract `pickFeaturedMissions()` helper + add unit test

**Files:**
- Modify: `scripts/fetch-tutorials.ts` (introduce the helper near the existing `isFeaturedMissionCandidate` declaration around line 1278)
- Create: `test/unit/scripts/featured-mission-picker.test.ts`

The helper is the heart of #739. Extracted as a pure function so it can be unit-tested without invoking the rest of `writeBrowseData()`.

- [ ] **Step 1: Write the failing test file**

Create `test/unit/scripts/featured-mission-picker.test.ts`:

```ts
// Unit tests for pickFeaturedMissions — the homepage-featured-missions picker
// that prefers explicit FeaturedTasks curation over the regex-sieved
// catalog-order fallback (issue #739).

import { describe, it, expect } from 'vitest'
import {
  pickFeaturedMissions,
  type BrowseCardItem,
  FEATURED_MAX,
} from '../../../scripts/fetch-tutorials.js'
import type { BrowseFeaturedEntry } from '../../../scripts/parsers/cap.js'

// Helper to build a synthetic BrowseCardItem with sensible defaults.
function mission(id: string, title: string): BrowseCardItem {
  return {
    type: 'mission',
    id,
    title,
    description: '',
    time: 0,
    level: 'beginner',
    tutorialCount: 0,
    primaryTag: '',
    displayTags: [],
    displayTagSlugs: [],
    href: `/missions/${id}`,
    stepCount: 0,
    categorySlugs: [],
  }
}

describe('pickFeaturedMissions (#739)', () => {
  it('case 1: curated set has mission entries — returns curated slugs in order', () => {
    const all: BrowseCardItem[] = [
      mission('cap-handlers', 'CAP Handlers'),
      mission('btp-onboard', 'BTP Onboarding'),
      mission('hana-cloud', 'HANA Cloud'),
    ]
    const featured: BrowseFeaturedEntry[] = [
      { type: 'mission', slug: 'hana-cloud',  title: '', description: '' },
      { type: 'mission', slug: 'cap-handlers', title: '', description: '' },
    ]
    expect(pickFeaturedMissions(featured, all)).toEqual(['hana-cloud', 'cap-handlers'])
  })

  it('case 2: curated set is empty — falls back to regex-sieved catalog-order top FEATURED_MAX', () => {
    const all: BrowseCardItem[] = [
      mission('cap-handlers', 'CAP Handlers'),
      mission('event-thing',  'Devtoberfest 2025'),    // sieved out by EVENT_MISSION_RE
      mission('btp-onboard',  'BTP Onboarding'),
    ]
    const featured: BrowseFeaturedEntry[] = []
    // Both non-event missions land in the result; sieve drops the Devtoberfest one.
    expect(pickFeaturedMissions(featured, all)).toEqual(['cap-handlers', 'btp-onboard'])
  })

  it('case 3: curated set has only TUTORIAL/GROUP entries — falls back', () => {
    const all: BrowseCardItem[] = [
      mission('cap-handlers', 'CAP Handlers'),
      mission('btp-onboard',  'BTP Onboarding'),
    ]
    const featured: BrowseFeaturedEntry[] = [
      { type: 'tutorial', slug: 'some-tutorial', title: '', description: '' },
      { type: 'group',    slug: 'some-group',    title: '', description: '' },
    ]
    // No missions in curated set → fallback fires.
    expect(pickFeaturedMissions(featured, all)).toEqual(['cap-handlers', 'btp-onboard'])
  })

  it('case 4: curated set has mixed types including missions — returns only mission slugs in order', () => {
    const all: BrowseCardItem[] = [
      mission('cap-handlers', 'CAP Handlers'),
      mission('hana-cloud',   'HANA Cloud'),
    ]
    const featured: BrowseFeaturedEntry[] = [
      { type: 'mission',  slug: 'hana-cloud',   title: '', description: '' },
      { type: 'tutorial', slug: 'some-tutorial', title: '', description: '' },
      { type: 'mission',  slug: 'cap-handlers', title: '', description: '' },
      { type: 'group',    slug: 'some-group',   title: '', description: '' },
    ]
    expect(pickFeaturedMissions(featured, all)).toEqual(['hana-cloud', 'cap-handlers'])
  })

  it('case 5: curated set has 3 missions — returns exactly those 3 slugs (no fallback fill)', () => {
    const all: BrowseCardItem[] = Array.from({ length: 15 }, (_, i) =>
      mission(`mission-${i}`, `Mission ${i}`),
    )
    const featured: BrowseFeaturedEntry[] = [
      { type: 'mission', slug: 'mission-0', title: '', description: '' },
      { type: 'mission', slug: 'mission-1', title: '', description: '' },
      { type: 'mission', slug: 'mission-2', title: '', description: '' },
    ]
    expect(pickFeaturedMissions(featured, all)).toEqual(['mission-0', 'mission-1', 'mission-2'])
  })

  it('case 6: curated set has more than FEATURED_MAX missions — returns first FEATURED_MAX in order', () => {
    const all: BrowseCardItem[] = Array.from({ length: 20 }, (_, i) =>
      mission(`mission-${i}`, `Mission ${i}`),
    )
    const featured: BrowseFeaturedEntry[] = Array.from({ length: 15 }, (_, i) => ({
      type: 'mission' as const,
      slug: `mission-${i}`,
      title: '',
      description: '',
    }))
    const result = pickFeaturedMissions(featured, all)
    expect(result).toHaveLength(FEATURED_MAX)
    expect(result[0]).toBe('mission-0')
    expect(result[FEATURED_MAX - 1]).toBe(`mission-${FEATURED_MAX - 1}`)
  })

  it('case 7: curated set references a slug not in all[] — orphan is filtered out', () => {
    const all: BrowseCardItem[] = [
      mission('cap-handlers', 'CAP Handlers'),
    ]
    const featured: BrowseFeaturedEntry[] = [
      { type: 'mission', slug: 'cap-handlers', title: '', description: '' },
      { type: 'mission', slug: 'orphaned-slug', title: '', description: '' },
    ]
    // Orphan dropped because it isn't in all[].
    expect(pickFeaturedMissions(featured, all)).toEqual(['cap-handlers'])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
npx vitest run test/unit/scripts/featured-mission-picker.test.ts 2>&1 | tail -15
```

Expected: ImportError / undefined-export error — `pickFeaturedMissions` doesn't exist yet, `BrowseCardItem` may not be exported, `FEATURED_MAX` may not be exported.

- [ ] **Step 3: Export `FEATURED_MAX` and the `BrowseCardItem` type from `fetch-tutorials.ts`**

Locate the existing declarations (around line 1262 for `FEATURED_MAX`, ~1283-1300 for the `BrowseCardItem` interface). Add `export` to both:

Find:
```ts
const FEATURED_MAX = 10
```
Change to:
```ts
export const FEATURED_MAX = 10
```

Find the `interface BrowseCardItem` declaration (around line 1283):
```ts
interface BrowseCardItem {
  type: 'mission' | 'group' | 'tutorial'
  id: string
  ...
}
```
Change `interface` to `export interface`:
```ts
export interface BrowseCardItem {
  type: 'mission' | 'group' | 'tutorial'
  id: string
  ...
}
```

- [ ] **Step 4: Add the `pickFeaturedMissions` helper**

Insert the helper IMMEDIATELY AFTER the existing `isFeaturedMissionCandidate` declaration (~line 1280, after `export function isFeaturedMissionCandidate(title: string): boolean { ... }`):

```ts

/**
 * Pick the homepage hp-teaser band's mission slugs (issue #739).
 *
 * Two-path picker:
 *   1. If `catalogFeatured` contains any type==='mission' entries, return
 *      their slugs in order (already sorted by FeaturedTasks.featuredOrder
 *      by the server-side query), trimmed to FEATURED_MAX. This is the
 *      "explicit curation wins" semantic — admins setting exactly 3 missions
 *      get exactly 3 cards on the homepage, NOT padded by the fallback.
 *   2. Otherwise (curated set empty or only TUTORIAL/GROUP entries), fall
 *      back to the catalog-order picker with the EVENT_MISSION_RE sieve
 *      applied (PR #738's behavior, preserved for pre-curation states).
 *
 * Defensively drops any curated slug that doesn't resolve to a card in
 * `all[]` — guards against the rare case where resolveFeatured() emitted
 * a slug that didn't survive buildAllCards()'s downstream filtering
 * (e.g. unpublished mission).
 *
 * Exported for unit testing.
 */
export function pickFeaturedMissions(
  catalogFeatured: BrowseFeaturedEntry[],
  all: BrowseCardItem[],
): string[] {
  const allMissionSlugs = new Set(
    all.filter(c => c.type === 'mission').map(c => c.id),
  )
  const curatedMissionSlugs = catalogFeatured
    .filter(f => f.type === 'mission')
    .map(f => f.slug)
    .filter(slug => allMissionSlugs.has(slug))

  if (curatedMissionSlugs.length > 0) {
    return curatedMissionSlugs.slice(0, FEATURED_MAX)
  }
  // No curation — fall back to the regex-sieved catalog-order top FEATURED_MAX.
  return all
    .filter(c => c.type === 'mission' && isFeaturedMissionCandidate(c.title))
    .slice(0, FEATURED_MAX)
    .map(c => c.id)
}
```

The helper needs the `BrowseFeaturedEntry` type imported. Find the existing import line at the top of `fetch-tutorials.ts`:

```ts
import { fetchBuildCatalog, fetchCoCompletions, loadCapCache, saveCapCache } from './parsers/cap.js'
```

Change to (add `type BrowseFeaturedEntry`):

```ts
import { fetchBuildCatalog, fetchCoCompletions, loadCapCache, saveCapCache, type BrowseFeaturedEntry } from './parsers/cap.js'
```

- [ ] **Step 5: Run the test to verify it passes**

Run:
```bash
npx vitest run test/unit/scripts/featured-mission-picker.test.ts 2>&1 | tail -10
```

Expected: all 7 cases pass.

If any case fails, the implementation is wrong — DO NOT relax the assertion; fix the helper.

- [ ] **Step 6: Run the existing filter test (regression check)**

Run:
```bash
npx vitest run test/unit/scripts/featured-mission-filter.test.ts 2>&1 | tail -8
```

Expected: still green. The fallback path still uses `EVENT_MISSION_RE` + `isFeaturedMissionCandidate()` — those weren't touched.

- [ ] **Step 7: Commit**

```bash
git add scripts/fetch-tutorials.ts test/unit/scripts/featured-mission-picker.test.ts
git -c core.autocrlf=false commit -m "feat(#739): add pickFeaturedMissions helper + unit test

Pure helper that prefers explicit FeaturedTasks curation (when
catalogFeatured contains mission entries) over the regex-sieved
catalog-order fallback. Trim to FEATURED_MAX; defensively drop
orphan slugs that don't resolve to an entry in all[].

Seven-case unit test covers: pure curated set, empty curated
fallback, only-non-mission-curation fallback, mixed types,
fewer than FEATURED_MAX (no fallback fill), more than FEATURED_MAX
(slice trims), orphan-slug defense.

Helper not yet called from writeBrowseData() — Task 3 wires it in."
```

---

## Task 3: Wire `pickFeaturedMissions()` into `writeBrowseData()`

**Files:**
- Modify: `scripts/fetch-tutorials.ts` — change the `writeBrowseData` signature to accept `catalogFeatured`, thread it from the caller (around line 1158), and replace the inline picker (lines 1474-1478) with a call to `pickFeaturedMissions`.

- [ ] **Step 1: Update `writeBrowseData` signature**

Locate the existing signature (around lines 1456-1463):

```ts
function writeBrowseData(
  tuts: TutorialNavEntry[],
  missions: Mission[],
  hierarchies: MissionHierarchy[],
  standaloneGroups: StandaloneGroup[],
  categories: CategoryMeta[],
  tutorialMetas: CatalogTutorialMeta[],
): void {
```

Change to:

```ts
function writeBrowseData(
  tuts: TutorialNavEntry[],
  missions: Mission[],
  hierarchies: MissionHierarchy[],
  standaloneGroups: StandaloneGroup[],
  categories: CategoryMeta[],
  tutorialMetas: CatalogTutorialMeta[],
  catalogFeatured: BrowseFeaturedEntry[],
): void {
```

- [ ] **Step 2: Replace the inline picker with a call to `pickFeaturedMissions`**

Locate the existing picker block (lines 1467-1478, inside `writeBrowseData`):

```ts
  // Featured: first FEATURED_MAX mission cards in catalog order, excluding
  // event-specific missions (Devtoberfest / App Space / TechEd YYYY) via
  // isFeaturedMissionCandidate(). See EVENT_MISSION_RE comment above for
  // rationale. Catalog ordering itself isn't editorial — it falls out of
  // GitHub repo discovery — so this filter is a sieve, not a curation.
  // Track replacement with proper Mission.featuredOrder admin column.
  const featured = all
    .filter(c => c.type === 'mission' && isFeaturedMissionCandidate(c.title))
    .slice(0, FEATURED_MAX)
    .map(c => c.id)
```

Replace with:

```ts
  // Featured: prefer admin-curated FeaturedTasks (top 10 missions ordered by
  // featuredOrder); fall back to the regex-sieved catalog-order picker
  // (PR #738) when no admin has curated any mission rows yet. See
  // pickFeaturedMissions for the full semantics (#739).
  const featured = pickFeaturedMissions(catalogFeatured, all)
```

- [ ] **Step 3: Update the call site to pass `catalog.featured`**

Locate the call site (around line 1158):

```ts
      writeBrowseData(navEntries, missions, hierarchies, standaloneGroups, categories, tutorialMetas)
```

We need to thread the catalog's `featured` array here. Look at the surrounding code (lines ~970-1000) to find where `catalog` is in scope. There are TWO branches: the cache-hit branch (`loadCapCache()` returns non-null) and the fresh-fetch branch (`fetchBuildCatalog()` returns the catalog object).

**Step 3a:** Add a `featured` variable to the same declaration block that has `missions`, `hierarchies`, etc. Locate (around line 970):

```ts
  let missions: Mission[] = []
  let hierarchies: MissionHierarchy[] = []
  let standaloneGroups: StandaloneGroup[] = []
  let categories: CategoryMeta[] = []
  let tutorialMetas: CatalogTutorialMeta[] = []
  let coCompletions: Map<string, Map<string, number>> = new Map()
```

(Exact lines may vary slightly — use `grep -n "let missions" scripts/fetch-tutorials.ts` to locate.)

Add a new line:

```ts
  let featured: BrowseFeaturedEntry[] = []
```

**Step 3b:** Populate `featured` from the cache-hit branch. Find the lines (around line 972-980 — the `if (cached)` branch):

```ts
  if (cached) {
    missions = cached.missions
    hierarchies = cached.hierarchies
    standaloneGroups = cached.standaloneGroups ?? []
    categories = cached.categories ?? []
    tutorialMetas = cached.tutorialMetas ?? []
    console.log(`  [cap] Using cached data ...`)
  } else {
```

Add a new line inside the `if (cached)` block:

```ts
    featured = cached.featured ?? []
```

**Step 3c:** Populate `featured` from the fresh-fetch branch. Find (around lines 984-990):

```ts
      const catalog = await fetchBuildCatalog(capBaseUrl)
      missions = catalog.missions
      hierarchies = catalog.hierarchies
      standaloneGroups = catalog.standaloneGroups
      categories = catalog.categories
      tutorialMetas = catalog.tutorialMetas
      saveCapCache(missions, hierarchies, standaloneGroups, categories, tutorialMetas)
```

Add `featured` from the catalog AND pass it into `saveCapCache`:

```ts
      const catalog = await fetchBuildCatalog(capBaseUrl)
      missions = catalog.missions
      hierarchies = catalog.hierarchies
      standaloneGroups = catalog.standaloneGroups
      categories = catalog.categories
      tutorialMetas = catalog.tutorialMetas
      featured = catalog.featured
      saveCapCache(missions, hierarchies, standaloneGroups, categories, tutorialMetas, featured)
```

**Step 3d:** Update the `writeBrowseData` call site to pass `featured`. Find:

```ts
      writeBrowseData(navEntries, missions, hierarchies, standaloneGroups, categories, tutorialMetas)
```

Change to:

```ts
      writeBrowseData(navEntries, missions, hierarchies, standaloneGroups, categories, tutorialMetas, featured)
```

- [ ] **Step 4: Run the picker test (regression check)**

Run:
```bash
npx vitest run test/unit/scripts/featured-mission-picker.test.ts test/unit/scripts/featured-mission-filter.test.ts 2>&1 | tail -8
```

Expected: 7 + existing tests pass. (Task 3 didn't change the helper or the sieve — but it touched the same file, so confirm nothing regressed.)

- [ ] **Step 5: TypeScript compilation check**

Run:
```bash
npx tsc --noEmit -p . 2>&1 | grep -i "scripts/fetch-tutorials.ts\|scripts/parsers/cap.ts" | head -20
```

Expected: zero errors in either file. (The `featured` parameter now flows correctly end-to-end.)

- [ ] **Step 6: Commit**

```bash
git add scripts/fetch-tutorials.ts
git -c core.autocrlf=false commit -m "feat(#739): writeBrowseData consumes catalog.featured

Thread the BrowseFeaturedEntry[] array from fetchBuildCatalog
through the cache + writeBrowseData signature into the new
pickFeaturedMissions helper. Both the cache-hit and fresh-fetch
branches populate the local 'featured' var; saveCapCache persists
it for the next cache-hit run.

The inline picker block in writeBrowseData is replaced with the
single-line helper call. EVENT_MISSION_RE / isFeaturedMissionCandidate
/ FEATURED_MAX stay exactly as they are — they power the fallback
branch inside pickFeaturedMissions.

Completes the build-pipeline half of #739; the side-nav move
follows in Task 4."
```

---

## Task 4: Move "Featured Tasks" side-nav entry to Content group

**Files:**
- Modify: `app/admin-shell/webapp/model/navigation.json`

- [ ] **Step 1: Read the file to locate the entry**

Run:
```bash
grep -n '"key": "operations"' app/admin-shell/webapp/model/navigation.json
```

Expected: one line showing the `operations` entry in the System group's items.

- [ ] **Step 2: View the context around the entry**

Run:
```bash
sed -n '60,80p' app/admin-shell/webapp/model/navigation.json
```

Expected: shows the System group with its items array. The `operations` entry should be present.

- [ ] **Step 3: View the Content group's current items**

Run:
```bash
sed -n '11,28p' app/admin-shell/webapp/model/navigation.json
```

Expected: shows the Content group with `events`, `missions`, `groups`, `tutorials`, `tags`, `categories`, `concepts`, `advocates`, `alerts`. (The homepage entry was already moved out by PR #766.)

- [ ] **Step 4: Edit the file with two surgical changes**

**(a)** Remove `{ "key": "operations", "title": "Featured Tasks" }` from the System group's items array. The exact text depends on whether it's at the start, middle, or end of the array — read the System group context first to see commas. Most likely shape:

Change:
```json
        { "key": "operations", "title": "Featured Tasks" },
        { "key": "pipelinelog", "title": "Pipeline Log" },
```

to:

```json
        { "key": "pipelinelog", "title": "Pipeline Log" },
```

(i.e., delete the operations line including its trailing comma + newline).

**(b)** Add `{ "key": "operations", "title": "Featured Tasks" }` to the Content group's items array, immediately AFTER the `alerts` entry. Change:

```json
        { "key": "alerts", "title": "Alerts" }
      ]
    },
```

to:

```json
        { "key": "alerts", "title": "Alerts" },
        { "key": "operations", "title": "Featured Tasks" }
      ]
    },
```

(Note: the `alerts` entry gains a trailing comma; `operations` is now the last entry without one.)

- [ ] **Step 5: Validate JSON**

Run:
```bash
node -e "JSON.parse(require('fs').readFileSync('app/admin-shell/webapp/model/navigation.json','utf8')); console.log('OK')"
```

Expected: `OK`.

- [ ] **Step 6: Spot-check the structural change**

Run:
```bash
node -e "
const n = JSON.parse(require('fs').readFileSync('app/admin-shell/webapp/model/navigation.json','utf8'));
const content = n.groups.find(g => g.key === 'content');
const system = n.groups.find(g => g.key === 'system');
console.log('Content group last 3 items:', content.items.slice(-3).map(i => i.key).join(','));
console.log('System group items:', system.items.map(i => i.key).join(','));
console.log('Content has operations?', content.items.some(i => i.key === 'operations'));
console.log('System has operations?', system.items.some(i => i.key === 'operations'));
"
```

Expected:
```
Content group last 3 items: advocates,alerts,operations
System group items: pipelinelog,joblog,...,privacy,privacyAudit  (no 'operations')
Content has operations? true
System has operations? false
```

- [ ] **Step 7: Commit**

```bash
git add app/admin-shell/webapp/model/navigation.json
git -c core.autocrlf=false commit -m "fix(#739): move Featured Tasks nav entry from System to Content

The 'Featured Tasks' admin tile (FeaturedTasks Fiori Elements list-
report-object-page) is editorial curation, not operations. Moving
it under Content alongside Events, Missions, Groups, Categories,
Concepts, Advocates, and Alerts matches its semantic role.

The underlying Fiori app at /admin-ui/#operations stays in place;
only the side-nav group membership changes. Shell.controller.js
NAV_KEY_TO_ROUTE/TITLE for 'operations' are unchanged (title
remains 'Featured Tasks')."
```

---

## Task 5: Verify the admin-shell build

**Files:** none (verification task)

- [ ] **Step 1: Run the admin-shell build**

Run:
```bash
npm run build:admin 2>&1 | tail -10
```

Expected: build succeeds.

- [ ] **Step 2: Verify the built navigation.json has the new structure**

Locate the built navigation.json (the dist path varies between flat and namespaced UI5 layouts — use `find` to discover it):

```bash
NAV_PATH=$(find app/admin-shell/dist -name navigation.json -not -path "*/node_modules/*" 2>/dev/null | head -1)
echo "Using: $NAV_PATH"
test -n "$NAV_PATH" || { echo "ERROR: built navigation.json not found"; exit 1; }

node -e "
const n = JSON.parse(require('fs').readFileSync('$NAV_PATH','utf8'));
const content = n.groups.find(g => g.key === 'content');
const system = n.groups.find(g => g.key === 'system');
console.log('Content last entry:', content.items[content.items.length - 1].key);
console.log('Operations under content?', content.items.some(i => i.key === 'operations'));
console.log('Operations still in system?', system.items.some(i => i.key === 'operations'));
"
```

Expected:
```
Content last entry: operations
Operations under content? true
Operations still in system? false
```

- [ ] **Step 3: No commit (verification only)**

If anything fails, fix the source and re-run. Otherwise proceed.

---

## Task 6: Open the PR

**Files:** none

- [ ] **Step 1: Push the branch**

```bash
git push -u origin 739-featured-missions-curation
```

- [ ] **Step 2: Write the PR body file**

```bash
cat > PR_BODY.md << 'PR_BODY_EOF'
Closes #739.

## What

Wires `writeBrowseData()` in `scripts/fetch-tutorials.ts` to consume the `featured` array that `/build/catalog` already returns. Admins who curate `FeaturedTasks` rows now see their explicit ordering on the homepage `hp-teaser` band; when nobody has curated anything, the existing regex-sieved catalog-order picker from PR #738 fires as the fallback.

Also moves the "Featured Tasks" side-nav entry from the System group to the Content group, where it semantically belongs (editorial curation, not operations).

## Why the small footprint

The issue body proposed adding a new `Missions.featuredOrder` field plus admin UI plus catalog wiring. Investigation surfaced that the equivalent infrastructure already exists end-to-end (`FeaturedTasks` polymorphic table, `AdminService` projection + `setFeaturedOrder` action, Fiori Elements list-report-object-page admin UI at `/admin-ui/#operations`, `/build/catalog` `featured` array, rebuild classifier wiring). The only missing piece was the build-pipeline consumer: `writeBrowseData()` ignored `catalog.featured` and rolled its own picker.

So this PR is the wiring change, not new infrastructure. ~50 lines of code, plus a 7-case unit test.

## Spec & plan

- Spec: [docs/superpowers/specs/2026-06-29-739-featured-missions-curation-design.md](docs/superpowers/specs/2026-06-29-739-featured-missions-curation-design.md)
- Plan: [docs/superpowers/plans/2026-06-29-739-featured-missions-curation.md](docs/superpowers/plans/2026-06-29-739-featured-missions-curation.md)

## How

1. `scripts/parsers/cap.ts` — surface the `featured` array from `/build/catalog` through `fetchBuildCatalog`'s return shape; persist it in `CapCacheData`; expose a `BrowseFeaturedEntry` type.
2. `scripts/fetch-tutorials.ts` — extract the picker into a pure `pickFeaturedMissions(catalogFeatured, all)` helper; thread `catalog.featured` through `writeBrowseData` to call the helper. The helper prefers curated mission slugs in order; falls back to the regex-sieved catalog-order top 10 when curation is empty or has no mission entries. Defensively drops orphan slugs that don't resolve to a card.
3. `app/admin-shell/webapp/model/navigation.json` — move `{ "key": "operations", "title": "Featured Tasks" }` from the System group to the Content group (after Alerts).

## "Explicit curation wins" semantic

If an admin curates exactly 3 missions, the homepage shows exactly 3 cards — no fallback padding. Mission-row absence (e.g. curated set has only TUTORIAL/GROUP entries) IS treated as "no mission curation, fall back." See `pickFeaturedMissions` and the unit-test enumeration for the full matrix.

## Tests

- New: `test/unit/scripts/featured-mission-picker.test.ts` — 7-case unit test (pure curated, empty curated → fallback, only non-mission curated → fallback, mixed types, fewer than max, more than max, orphan-slug defense).
- Existing: `test/unit/scripts/featured-mission-filter.test.ts` keeps testing `EVENT_MISSION_RE` / `isFeaturedMissionCandidate()` — the sieve still ships in the fallback path.

## Rollback

`git revert` + redeploy. No data migration, no schema change, no feature flag. `FeaturedTasks` is empty in PROD today, so the fallback fires identically to the current behavior — the transition is monotonic.

## Manual smoke after deploy

1. `/admin-ui/` — "Featured Tasks" now appears under **Content** (was under System).
2. Open it — Fiori Elements list-report over `FeaturedTasks`.
3. Create a row: `taskType = MISSION`, `taskLegacyId = <legacyId of a known mission>`, `featuredOrder = 1`. Save.
4. Wait ~1 min for the `catalog-only` rebuild (`/admin-ui/#pipelinelog`).
5. Reload `/` — the curated mission is now the first card in the Featured Missions band.
6. Set `featuredOrder = NULL` (or delete the row) — wait ~1 min, reload, observe fallback to regex-sieved catalog-order.
7. Create three rows: MISSION + TUTORIAL + GROUP at orders 1, 2, 3 — verify only the MISSION appears in the homepage band (TUTORIAL/GROUP filtered out by the mission-only picker).
PR_BODY_EOF
```

Verify:
```bash
ls -l PR_BODY.md && wc -l PR_BODY.md
```

Expected: non-empty file with ~45 lines.

- [ ] **Step 3: Create the PR**

```bash
gh pr create --base main --head 739-featured-missions-curation \
  --title "feat(#739): wire writeBrowseData to existing FeaturedTasks curation" \
  --body-file ./PR_BODY.md
```

- [ ] **Step 4: Remove the body file (do NOT commit it)**

```bash
rm PR_BODY.md
```

- [ ] **Step 5: Verify CI green**

Watch the standard CI run. If anything fails, address before merging.

---

## Task 7: Post-merge deploy + verify

After PR merge, deploy from `main` in the primary tree (per memory [[feedback_always_deploy_from_main_primary_tree.md]]). **This task only runs after Tom explicitly signals he wants the deploy** — per memory [[feedback_merge_confirmation_not_deploy_authorization.md]] and [[feedback_confirm_deploy_scope.md]], merging is not deploy authorization.

- [ ] **Step 1: Confirm deploy scope with Tom**

Ask: "Ready to deploy #739 to DEV? Scope is admin-shell (nav.json move) + srv-script (`scripts/fetch-tutorials.ts`, `scripts/parsers/cap.ts`) — no schema, no srv-runtime, no DB changes. Anything else queued I should bundle in?" Wait for explicit yes before continuing.

- [ ] **Step 2: Switch to primary tree, pull main**

```bash
cd D:/projects/tutorials-poc
git checkout main
git pull --ff-only origin main
```

- [ ] **Step 3: Verify CF target**

```bash
cf target
```

Expected: DEV space. If wrong, surface and STOP.

- [ ] **Step 4: Resolve mtaext placeholders BEFORE `cf deploy`**

Per CLAUDE.md's "Local manual deploy" instruction and memory [[feedback_mtaext_envsubst_empty_quote_required.md]], `cf deploy -e dev.mtaext` does NOT interpolate `${VAR}` references. We must `envsubst` first:

```bash
cd D:/projects/tutorials-poc
# Source the four secrets from your local env (must be exported beforehand).
# Empty values MUST be quoted as "''" to avoid YAML-null parsing.
test -n "$CONTENT_API_KEY" || { echo "ERROR: CONTENT_API_KEY not set"; exit 1; }
test -n "$REBUILD_API_KEY" || { echo "ERROR: REBUILD_API_KEY not set"; exit 1; }
test -n "$APPROUTER_URL"   || { echo "ERROR: APPROUTER_URL not set"; exit 1; }
test -n "$GITHUB_DISPATCH_TOKEN" || { echo "ERROR: GITHUB_DISPATCH_TOKEN not set"; exit 1; }

envsubst '$CONTENT_API_KEY $REBUILD_API_KEY $APPROUTER_URL $GITHUB_DISPATCH_TOKEN' \
  < deploy/dev.mtaext > deploy/dev.resolved.mtaext

# Verify no placeholder survived:
grep -E '\$\{?[A-Z_]+\}?' deploy/dev.resolved.mtaext && \
  { echo "ERROR: unresolved placeholder in dev.resolved.mtaext"; exit 1; } || \
  echo "OK: all placeholders resolved"
```

- [ ] **Step 5: Build + deploy**

```bash
cd D:/projects/tutorials-poc
npm run build:all
cd .deploy && mbt build && cf deploy mta_archives/*.mtar -e ../deploy/dev.resolved.mtaext -f
```

Note `-e ../deploy/dev.resolved.mtaext` (NOT `dev.mtaext`) — the resolved file is what `cf deploy` needs.

- [ ] **Step 6: Probe the deployed admin shell + homepage**

```bash
curl -s https://tutorial-system-dev-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com/admin-ui/ -o /dev/null -w "admin-ui status=%{http_code}\n"
curl -s https://tutorial-system-dev-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com/ -o /dev/null -w "homepage status=%{http_code}\n"
```

Expected: both return 200 or 302 (XSUAA redirect for admin).

- [ ] **Step 7: Manual smoke per PR body**

Walk Tom through the 7-item manual smoke. Confirm before closing.

---

## Notes / hazards

- **The two `FEATURED_*` constants are intentional** — `FEATURED_LIMIT = 6` in `srv/lib/build-catalog.js` (server-side query cap) vs. `FEATURED_MAX = 10` in `fetch-tutorials.ts` (client-side defensive trim). The picker's `.slice(0, FEATURED_MAX)` on the curated branch is unreachable at runtime today (because `LIMIT < MAX`) but kept as a safety net per spec §1.5. DO NOT reconcile them.
- **The fallback path is the same code that shipped in #738** — it's still tested by `test/unit/scripts/featured-mission-filter.test.ts`. New picker test covers the curated-vs-fallback branching; the sieve test covers the sieve.
- **`PROD FeaturedTasks` is empty today** — first deploy of this PR causes zero homepage change. Admins discover the moved nav entry, curate, see the change. The transition is monotonic.
- **CRLF on Windows:** all commits use `git -c core.autocrlf=false commit` per memory [[feedback_crlf_regression_on_windows]].
- **Work in the worktree; deploy from primary tree.** Tasks 1-6 run in `D:/projects/tutorials-poc/.claude/worktrees/739-featured-missions-curation`; Task 7 runs in `D:/projects/tutorials-poc` against `main`.
- **No backend code change.** If you find yourself adding code to `srv/admin-service.js` or `srv/lib/build-catalog.js`, stop — that's scope creep. The server already does what we need.
