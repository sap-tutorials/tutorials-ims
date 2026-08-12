# Context-aware group/mission tutorial navigation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a tutorial's Next/Previous buttons (and breadcrumb) correct for the specific group the reader entered from, so a tutorial reused across multiple groups no longer navigates *out* of its group.

**Architecture:** Group/mission SSR pages tag each tutorial link with `?from=<groupSlug>`. A small client island on tutorial pages reads `?from=`, looks up the correct per-group `prev`/`next` from the existing `/build/navigator` feed, and rewrites the nav pills + next-steps card (carrying `?from=` forward). A build-time change makes the *baked* default deterministic (canonical owner = lowest `(missionLegacyId, groupLegacyId)`), so direct/search/bookmark entry and the breadcrumb get a stable, sensible default even without `?from=`.

**Tech Stack:** TypeScript (build scripts + Vite islands), Hugo templates, CAP Node.js SSR (`srv/lib/catalog-renderer.js`), Vitest (unit + happy-dom + e2e/playwright-core).

**Design spec:** `docs/superpowers/specs/2026-08-12-group-tutorial-nav-context-aware-design.md`

## Global Constraints

- **Scope of THIS plan: Phases A–D** (deterministic build default, `?from=` emission, runtime nav island, context-aware breadcrumb). Phase E (context-aware right-rail side-nav) is a documented follow-up at the end — do **not** implement it here.
- **Silent-failure everywhere in client islands** — a missing `?from=`, an unmatched navigator row, or a fetch error must leave the baked links intact and never throw / never break the page. Mirror `hugo-apps/src/tutorial-breadcrumbs/main.ts`.
- **`?from=` values are HTML-escaped** in SSR (`escapeHtml`) and URL-encoded in the island (`encodeURIComponent`). The approuter `/tutorials/*` route already accepts a query string (verified: 200 with and without `?from=`).
- **Islands are content-hashed** — a new Vite entry auto-hashes; `hugo/data/island_manifest.json` is (re)built by `scripts/build-island-manifest.cjs`, called explicitly in `build:all` (NOT via a lifecycle hook — global `ignore-scripts=true`).
- **hugo-apps tests run from repo root:** `npx vitest run --project unit <path>` (never `npx vitest` inside `hugo-apps/`). DOM tests declare `// @vitest-environment happy-dom` at the top of the file. The `@shared` alias resolves to `hugo-apps/src/shared`.
- **Windows/CRLF:** author new files with LF endings.
- **Deploy:** this is a build + frontend + SSR change → ships via a FULL local deploy (`npm run build:all` → `mbt build` → `cf deploy -e ../deploy/<env>.mtaext`), not a content-only rebuild (island manifest + SSR renderer change). MTA version bump = **patch** (`.deploy/mta.yaml`).
- **PR, not direct merge** to `main`.
- No new `srv/lib/*` file is introduced (only `catalog-renderer.js` is edited), so the `srv-qa` cp-list is unaffected.

---

### Task 1: Pure canonical-owner nav resolver

**Files:**
- Create: `scripts/parsers/nav-owner.ts`
- Test: `scripts/parsers/__tests__/nav-owner.test.ts`

**Interfaces:**
- Produces: `computeCanonicalNav(containers: NavContainer[], presentSlugs: Set<string>): Map<string, NavAssignment>` and `rankContainers(containers: NavContainer[]): NavContainer[]`, plus the `NavContainer`, `NavStamp`, `NavAssignment` types (consumed by Task 2).

- [ ] **Step 1: Write the failing test**

```ts
// scripts/parsers/__tests__/nav-owner.test.ts
import { describe, it, expect } from 'vitest';
import { computeCanonicalNav, rankContainers, type NavContainer } from '../nav-owner';

const setup: NavContainer = {
  kind: 'mission', missionLegacyId: 15069, groupLegacyId: 15066,
  slugs: ['trial-1', 'trial-2', 'trial-3', 'trial-4'],
  stamp: { missionId: 15069, missionTitle: 'Jump Start', missionSlug: 'jump-start',
           groupId: 15066, groupTitle: 'Set Up', groupSlug: 'set-up' },
};
const teched: NavContainer = {
  kind: 'mission', missionLegacyId: 24491, groupLegacyId: 937,
  slugs: ['trial-2', 'trial-3', 'advanced-analytics'],
  stamp: { missionId: 24491, missionTitle: 'TechEd', missionSlug: 'teched',
           groupId: 937, groupTitle: 'Data & Analytics', groupSlug: 'data-and-analytics-937-1' },
};
const present = new Set(['trial-1', 'trial-2', 'trial-3', 'trial-4', 'advanced-analytics']);

describe('computeCanonicalNav', () => {
  it('picks the lowest-mission-legacyId owner regardless of group id or input order', () => {
    // teched.groupLegacyId (937) < setup.groupLegacyId (15066), so group-id
    // ranking would wrongly pick teched. Mission-id ranking must pick setup.
    const a = computeCanonicalNav([teched, setup], present);
    const t3 = a.get('trial-3');
    expect(t3?.groupSlug).toBe('set-up');
    expect(t3?.prev).toBe('trial-2');
    expect(t3?.next).toBe('trial-4');    // NOT advanced-analytics
    expect(t3?.missionSlug).toBe('jump-start');
  });

  it('is order-independent', () => {
    const a1 = computeCanonicalNav([teched, setup], present);
    const a2 = computeCanonicalNav([setup, teched], present);
    expect(a2.get('trial-3')).toEqual(a1.get('trial-3'));
  });

  it('nulls prev/next when the neighbour is not a present page', () => {
    const g: NavContainer = { kind: 'standalone', missionLegacyId: null, groupLegacyId: 5,
      slugs: ['only', 'ghost'], stamp: { groupId: 5, groupTitle: 'G', groupSlug: 'g' } };
    const a = computeCanonicalNav([g], new Set(['only']));   // 'ghost' absent
    expect(a.get('only')).toMatchObject({ prev: null, next: null, groupSlug: 'g' });
  });

  it('standalone (null mission) ranks after mission-nested homes', () => {
    const standalone: NavContainer = { kind: 'standalone', missionLegacyId: null, groupLegacyId: 1,
      slugs: ['trial-3'], stamp: { groupId: 1, groupTitle: 'S', groupSlug: 'standalone' } };
    const a = computeCanonicalNav([standalone, setup], present);
    expect(a.get('trial-3')?.groupSlug).toBe('set-up');   // mission home wins
  });

  it('rankContainers orders by [missionLegacyId ?? MAX, groupLegacyId, firstSlug]', () => {
    const ranked = rankContainers([teched, setup]);
    expect(ranked[0]).toBe(setup);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run --project unit scripts/parsers/__tests__/nav-owner.test.ts`
Expected: FAIL — cannot resolve `../nav-owner`.

- [ ] **Step 3: Implement `scripts/parsers/nav-owner.ts`**

```ts
// scripts/parsers/nav-owner.ts
//
// Selects ONE canonical owner container per tutorial slug and computes that
// slug's baked frontmatter navigation (prev/next + mission/group context).
//
// A tutorial can belong to many groups/missions, but baked Hugo frontmatter
// carries only one prev/next. We pick a deterministic owner = the container
// with the lowest (missionLegacyId, groupLegacyId) rank (the original authoring
// home). Runtime `?from=` overrides this per entry-group; this is the default
// for direct/search/bookmark entry + breadcrumb/side-nav.

export interface NavStamp {
  missionId?: number;
  missionTitle?: string;
  missionSlug?: string;
  missionAltGroups?: unknown;   // AltGroup[] passthrough; opaque here
  groupId?: number;
  groupTitle?: string;
  groupSlug?: string;
}

export interface NavContainer {
  kind: 'mission' | 'standalone';
  missionLegacyId: number | null;   // null for standalone groups
  groupLegacyId: number;
  slugs: string[];                  // ordered tutorial slugs in this container
  stamp: NavStamp;                  // mission/group fields to write for members
}

export interface NavAssignment extends NavStamp {
  prev: string | null;
  next: string | null;
}

const MAX = Number.MAX_SAFE_INTEGER;

export function rankContainers(containers: NavContainer[]): NavContainer[] {
  return [...containers].sort((a, b) => {
    const am = a.missionLegacyId ?? MAX;
    const bm = b.missionLegacyId ?? MAX;
    if (am !== bm) return am - bm;
    if (a.groupLegacyId !== b.groupLegacyId) return a.groupLegacyId - b.groupLegacyId;
    return (a.slugs[0] ?? '').localeCompare(b.slugs[0] ?? '');
  });
}

// presentSlugs = slugs that exist as real Hugo tutorial pages. A neighbour not
// present cannot be linked (mirrors the old navBySlug.has() guard) → null.
export function computeCanonicalNav(
  containers: NavContainer[],
  presentSlugs: Set<string>,
): Map<string, NavAssignment> {
  const assigned = new Map<string, NavAssignment>();
  for (const c of rankContainers(containers)) {
    for (let i = 0; i < c.slugs.length; i++) {
      const slug = c.slugs[i];
      if (!presentSlugs.has(slug)) continue;   // not a real page
      if (assigned.has(slug)) continue;        // lower-rank owner already won
      const prevSlug = i > 0 ? c.slugs[i - 1] : null;
      const nextSlug = i < c.slugs.length - 1 ? c.slugs[i + 1] : null;
      assigned.set(slug, {
        prev: prevSlug && presentSlugs.has(prevSlug) ? prevSlug : null,
        next: nextSlug && presentSlugs.has(nextSlug) ? nextSlug : null,
        ...c.stamp,
      });
    }
  }
  return assigned;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run --project unit scripts/parsers/__tests__/nav-owner.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/parsers/nav-owner.ts scripts/parsers/__tests__/nav-owner.test.ts
git commit -m "feat(nav): pure canonical-owner resolver for baked tutorial prev/next"
```

---

### Task 2: Wire canonical owner into fetch-tutorials.ts

**Files:**
- Modify: `scripts/fetch-tutorials.ts` (Phase 4, ~lines 1112-1245)
- Test: existing `scripts/__tests__/*` suite (regression) + `scripts/parsers/__tests__/nav-owner.test.ts` (unit coverage from Task 1)

**Interfaces:**
- Consumes: `computeCanonicalNav`, `NavContainer` from `scripts/parsers/nav-owner.ts` (Task 1).

**Context:** Today both loops mutate the shared per-slug `nav` object inline (last-writer-wins). We keep the loops' *metadata* work (`missionsMeta`, `allGroupRefs`, `groupRef.tutorials`, `matchedTutorials`/`unmatchedTutorials`) but move all `nav.prev/next/missionId/missionTitle/missionSlug/missionAltGroups/groupId/groupTitle/groupSlug` writes into a single owner-scoped pass after both loops.

- [ ] **Step 1: Add the import** (top of `scripts/fetch-tutorials.ts`, with the other `./parsers/*` imports)

```ts
import { computeCanonicalNav, type NavContainer } from './parsers/nav-owner'
```

- [ ] **Step 2: Declare the container accumulator** (just before `for (const mission of missions) {`, ~line 1118)

```ts
const navContainers: NavContainer[] = []
```

- [ ] **Step 3: In the mission per-tutorial loop, remove the inline nav stamping and collect a container.**

Delete these lines inside `for (let i = 0; i < group.tutorialSlugs.length; i++)` (~1163-1178):

```ts
        nav.missionId = mission.imsId
        nav.missionTitle = mission.title
        nav.missionSlug = mission.slug
        if (collectedAltGroups.length) {
          nav.missionAltGroups = collectedAltGroups
        }
        if (!isFlat) {
          nav.groupId = group.imsId
          nav.groupTitle = group.title
          nav.groupSlug = group.slug
        }

        const prevSlug = i > 0 ? group.tutorialSlugs[i - 1] : null
        const nextSlug = i < group.tutorialSlugs.length - 1 ? group.tutorialSlugs[i + 1] : null
        if (prevSlug && navBySlug.has(prevSlug)) nav.prev = prevSlug
        if (nextSlug && navBySlug.has(nextSlug)) nav.next = nextSlug
```

Keep the lines above them (`matchedTutorials++`, `groupRef.tutorials.push(tSlug)`). The loop body now only counts + collects `groupRef.tutorials`. Then, right after that inner `for` loop closes (after `}`, before `missionGroups.push(groupRef)` ~line 1181), add:

```ts
      navContainers.push({
        kind: 'mission',
        missionLegacyId: mission.imsId,
        groupLegacyId: group.imsId,
        slugs: group.tutorialSlugs,
        stamp: {
          missionId: mission.imsId,
          missionTitle: mission.title,
          missionSlug: mission.slug,
          ...(collectedAltGroups.length ? { missionAltGroups: collectedAltGroups } : {}),
          ...(isFlat ? {} : { groupId: group.imsId, groupTitle: group.title, groupSlug: group.slug }),
        },
      })
```

- [ ] **Step 4: In the standalone-group loop, remove inline stamping and collect a container.**

Delete these lines inside `for (let i = 0; i < sg.tutorialSlugs.length; i++)` (~1219-1226):

```ts
      nav.groupId = sg.imsId
      nav.groupTitle = sg.title
      nav.groupSlug = sg.slug

      const prevSlug = i > 0 ? sg.tutorialSlugs[i - 1] : null
      const nextSlug = i < sg.tutorialSlugs.length - 1 ? sg.tutorialSlugs[i + 1] : null
      if (prevSlug && navBySlug.has(prevSlug)) nav.prev = prevSlug
      if (nextSlug && navBySlug.has(nextSlug)) nav.next = nextSlug
```

Keep `matchedTutorials++` and `groupRef.tutorials.push(tSlug)`. After the inner `for` closes (before `allGroupRefs.push(groupRef)` ~line 1229), add:

```ts
    navContainers.push({
      kind: 'standalone',
      missionLegacyId: null,
      groupLegacyId: sg.imsId,
      slugs: sg.tutorialSlugs,
      stamp: { groupId: sg.imsId, groupTitle: sg.title, groupSlug: sg.slug },
    })
```

- [ ] **Step 5: Apply canonical assignments after both loops** (immediately after the standalone loop closes, BEFORE `const recommendations = computeRecommendations(...)` ~line 1232):

```ts
  const navAssignments = computeCanonicalNav(navContainers, new Set(navBySlug.keys()))
  for (const [slug, a] of navAssignments) {
    const nav = navBySlug.get(slug)
    if (!nav) continue
    nav.prev = a.prev
    nav.next = a.next
    if (a.missionId !== undefined) {
      nav.missionId = a.missionId
      nav.missionTitle = a.missionTitle
      nav.missionSlug = a.missionSlug
    }
    if (a.missionAltGroups !== undefined) nav.missionAltGroups = a.missionAltGroups as typeof nav.missionAltGroups
    if (a.groupId !== undefined) {
      nav.groupId = a.groupId
      nav.groupTitle = a.groupTitle
      nav.groupSlug = a.groupSlug
    }
  }
```

- [ ] **Step 6: Run the build-script test suite to catch regressions**

Run: `npx vitest run --project unit scripts/__tests__ scripts/parsers/__tests__`
Expected: PASS. If any existing test encoded the old last-writer-wins behaviour (e.g. asserting a shared tutorial's `next` equals the LAST group's neighbour), update it to assert the canonical (lowest-mission) owner's neighbour and note why in the test. Do not weaken unrelated assertions.

- [ ] **Step 7: Commit**

```bash
git add scripts/fetch-tutorials.ts scripts/__tests__
git commit -m "fix(nav): bake prev/next from canonical owner, not last-writer-wins (#group-nav)"
```

---

### Task 3: Emit `?from=<groupSlug>` on group + mission SSR links

**Files:**
- Modify: `srv/lib/catalog-renderer.js` (`renderGroupBody` ~L80,L92; `renderMissionBody` ~L131)
- Test: `srv/lib/__tests__/catalog-renderer-from-param.test.js`

**Interfaces:**
- Produces: group/mission tutorial links of the form `/tutorials/<slug>?from=<groupSlug>` where `<groupSlug>` equals the `/build/navigator` `tutorialMappings.groupSlug` for that container (consumed by Tasks 5 & 6 at runtime).

- [ ] **Step 1: Write the failing test**

```js
// srv/lib/__tests__/catalog-renderer-from-param.test.js
import { describe, it, expect } from 'vitest';
import { renderGroupBody, renderMissionBody } from '../catalog-renderer.js';

describe('catalog-renderer ?from= emission', () => {
  it('group cards append ?from=<group.slug> to every tutorial link', () => {
    const ctx = {
      group: { slug: 'set-up', title: 'Set Up', description: '' },
      tutorials: [
        { slug: 'trial-1', title: 'T1', level: 'beginner', time: 5, stepCount: 3, createdAt: '2020-01-01' },
        { slug: 'trial-2', title: 'T2', level: 'beginner', time: 5, stepCount: 3, createdAt: '2020-01-01' },
      ],
      tutorialCount: 2, totalTime: 10, level: 'beginner',
    };
    const html = renderGroupBody(ctx, { now: new Date('2020-02-01') });
    expect(html).toContain('href="/tutorials/trial-1?from=set-up"');
    expect(html).toContain('href="/tutorials/trial-2?from=set-up"');
    // both the title link and the Start button carry it
    expect((html.match(/\?from=set-up/g) || []).length).toBeGreaterThanOrEqual(4);
  });

  it('mission cards append ?from=<g.slug> per group', () => {
    const ctx = {
      mission: { slug: 'jump-start', title: 'Jump Start', description: '' },
      groups: [{ slug: 'set-up', title: 'Set Up', isSynthetic: false, tutorials: [
        { slug: 'trial-1', title: 'T1', level: 'beginner', time: 5, stepCount: 3 },
      ] }],
      groupCount: 1, tutorialCount: 1, totalTime: 5, level: 'beginner',
    };
    const html = renderMissionBody(ctx);
    expect(html).toContain('href="/tutorials/trial-1?from=set-up"');
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run --project unit srv/lib/__tests__/catalog-renderer-from-param.test.js`
Expected: FAIL — links lack `?from=`.

- [ ] **Step 3: Edit `renderGroupBody`.** Change the two tutorial hrefs (currently `href="/tutorials/${escapeHtml(t.slug)}"`):

```js
            <h3><a href="/tutorials/${escapeHtml(t.slug)}?from=${escapeHtml(group.slug)}">${escapeHtml(t.title)}</a></h3>
```
```js
            <a href="/tutorials/${escapeHtml(t.slug)}?from=${escapeHtml(group.slug)}" class="start-btn">Start Tutorial &rarr;</a>
```

- [ ] **Step 4: Edit `renderMissionBody`.** Change the tutorial link (~L131):

```js
                <a href="/tutorials/${escapeHtml(t.slug)}?from=${escapeHtml(g.slug)}" class="tutorial-link">${escapeHtml(t.title)}</a>
```

(Leave the `/tutorials/group-${g.slug}` links unchanged — those are group-page links, not tutorial entry points.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run --project unit srv/lib/__tests__/catalog-renderer-from-param.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add srv/lib/catalog-renderer.js srv/lib/__tests__/catalog-renderer-from-param.test.js
git commit -m "feat(nav): emit ?from=<groupSlug> on group/mission SSR tutorial links"
```

---

### Task 4: Shared `/build/navigator` lookup module

**Files:**
- Create: `hugo-apps/src/shared/group-nav-context.ts`
- Test: `hugo-apps/src/shared/group-nav-context.test.ts`

**Interfaces:**
- Produces: `resolveGroupNav(slug, fromGroupSlug): Promise<NavMappingRow | null>`, `readFromParam(search): string | null`, `_resetCacheForTest()`, and the `NavMappingRow` type (consumed by Tasks 5 & 6).

- [ ] **Step 1: Write the failing test**

```ts
// hugo-apps/src/shared/group-nav-context.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveGroupNav, readFromParam, _resetCacheForTest } from './group-nav-context';

const rows = [
  { slug: 't3', missionId: 15069, missionTitle: 'Jump Start', missionSlug: 'jump-start',
    groupId: 15066, groupTitle: 'Set Up', groupSlug: 'set-up', prev: 't2', next: 't4' },
  { slug: 't3', missionId: 24491, missionTitle: 'TechEd', missionSlug: 'teched',
    groupId: 937, groupTitle: 'D&A', groupSlug: 'data-and-analytics-937-1', prev: 't2', next: 'adv' },
];

beforeEach(() => { _resetCacheForTest(); });
afterEach(() => { vi.restoreAllMocks(); });

function stubFetch(ok = true, body: unknown = { tutorialMappings: rows }) {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok, status: ok ? 200 : 500, json: async () => body })));
}

describe('group-nav-context', () => {
  it('readFromParam extracts a non-empty from', () => {
    expect(readFromParam('?from=set-up')).toBe('set-up');
    expect(readFromParam('?x=1')).toBeNull();
    expect(readFromParam('?from=')).toBeNull();
  });

  it('resolves the row matching (slug, groupSlug)', async () => {
    stubFetch();
    const r = await resolveGroupNav('t3', 'set-up');
    expect(r?.next).toBe('t4');
    expect(r?.missionSlug).toBe('jump-start');
  });

  it('returns null when no row matches the from group', async () => {
    stubFetch();
    expect(await resolveGroupNav('t3', 'nope')).toBeNull();
  });

  it('returns null on fetch failure (silent)', async () => {
    stubFetch(false);
    expect(await resolveGroupNav('t3', 'set-up')).toBeNull();
  });

  it('fetches /build/navigator only once (cache)', async () => {
    stubFetch();
    await resolveGroupNav('t3', 'set-up');
    await resolveGroupNav('t3', 'data-and-analytics-937-1');
    expect((globalThis.fetch as any).mock.calls.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run --project unit hugo-apps/src/shared/group-nav-context.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the module**

```ts
// hugo-apps/src/shared/group-nav-context.ts
//
// Fetches /build/navigator once and resolves the tutorialMappings row for a
// (slug, fromGroupSlug) pair. Shared by tutorial-group-nav (Next/Prev rewrite)
// and tutorial-breadcrumbs (context-aware breadcrumb). Silent-failure: null.

export interface NavMappingRow {
  slug: string;
  missionId: number;
  missionTitle: string;
  missionSlug: string;
  groupId: number;
  groupTitle: string;
  groupSlug: string;
  prev: string | null;
  next: string | null;
}

let cache: Promise<NavMappingRow[]> | null = null;

export function _resetCacheForTest(): void { cache = null; }

function loadMappings(): Promise<NavMappingRow[]> {
  if (!cache) {
    cache = (async () => {
      const res = await fetch('/build/navigator', {
        credentials: 'omit',
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`navigator ${res.status}`);
      const body = await res.json();
      return Array.isArray(body?.tutorialMappings) ? (body.tutorialMappings as NavMappingRow[]) : [];
    })().catch(() => {
      cache = null;   // allow a later retry
      return [] as NavMappingRow[];
    });
  }
  return cache;
}

export function readFromParam(search: string): string | null {
  try {
    const v = new URLSearchParams(search).get('from');
    return v && v.trim() ? v : null;
  } catch {
    return null;
  }
}

export async function resolveGroupNav(slug: string, fromGroupSlug: string): Promise<NavMappingRow | null> {
  if (!slug || !fromGroupSlug) return null;
  const rows = await loadMappings();
  return rows.find((r) => r.slug === slug && r.groupSlug === fromGroupSlug) ?? null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run --project unit hugo-apps/src/shared/group-nav-context.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/shared/group-nav-context.ts hugo-apps/src/shared/group-nav-context.test.ts
git commit -m "feat(nav): shared /build/navigator (slug,group) lookup module"
```

---

### Task 5: tutorial-group-nav island (rewrite Next/Prev + next-steps)

**Files:**
- Create: `hugo-apps/src/tutorial-group-nav/main.ts`
- Test: `hugo-apps/src/tutorial-group-nav/main.test.ts`
- Modify: `hugo-apps/vite.config.ts` (add entry)
- Modify: `hugo/layouts/_default/baseof.html` (load island on tutorial pages)

**Interfaces:**
- Consumes: `readFromParam`, `resolveGroupNav` from `@shared/group-nav-context` (Task 4).

**Context:** `.tutorial-nav-bottom` (a `<div>`) always renders, but the Prev (`a.nav-pill:not(.nav-pill--primary)`) and Next (`a.nav-pill--primary`) pills are conditional on baked `.Params.prev/next`. The island must therefore **create** a pill when the entry group needs one the baked default omitted, **rewrite** it when present, and **remove** it when the entry group has none. The next-steps card (`a.next-steps-card`) is best-effort: rewrite/hide only (its whole section is conditional and not always present).

- [ ] **Step 1: Write the failing test**

```ts
// @vitest-environment happy-dom
// hugo-apps/src/tutorial-group-nav/main.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { _resetCacheForTest } from '@shared/group-nav-context';

const rows = [
  { slug: 't3', missionId: 15069, missionTitle: 'Jump Start', missionSlug: 'jump-start',
    groupId: 15066, groupTitle: 'Set Up', groupSlug: 'set-up', prev: 't2', next: 't4' },
];

function stubFetch(body: unknown = { tutorialMappings: rows }) {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => body })));
}

function setPage(slug: string, search: string, navBottomHtml: string) {
  document.documentElement.dataset.pageKind = 'tutorial';
  document.documentElement.dataset.pageSlug = slug;
  history.replaceState({}, '', `/tutorials/${slug}${search}`);
  document.body.innerHTML = `<div class="tutorial-nav-bottom">${navBottomHtml}<div class="nav-spacer"></div></div>`;
}

async function runIsland() {
  vi.resetModules();
  await import('./main');
  await new Promise((r) => setTimeout(r, 0)); // let the async run() settle
}

beforeEach(() => { _resetCacheForTest(); document.body.innerHTML = ''; delete document.documentElement.dataset.pageKind; });
afterEach(() => { vi.restoreAllMocks(); });

describe('tutorial-group-nav island', () => {
  it('rewrites Next/Prev to the from-group neighbours, carrying ?from= forward', async () => {
    stubFetch();
    setPage('t3', '?from=set-up',
      '<a href="/tutorials/adv" class="nav-pill nav-pill--primary">Next</a>');
    await runIsland();
    const next = document.querySelector('a.nav-pill--primary') as HTMLAnchorElement;
    expect(next.getAttribute('href')).toBe('/tutorials/t4?from=set-up');
    // Prev pill was absent in HTML but the from-group has a prev → created
    const prev = document.querySelector('a.nav-pill:not(.nav-pill--primary)') as HTMLAnchorElement;
    expect(prev.getAttribute('href')).toBe('/tutorials/t2?from=set-up');
  });

  it('no ?from= → no-op (baked link untouched)', async () => {
    stubFetch();
    setPage('t3', '',
      '<a href="/tutorials/adv" class="nav-pill nav-pill--primary">Next</a>');
    await runIsland();
    expect((document.querySelector('a.nav-pill--primary') as HTMLAnchorElement).getAttribute('href'))
      .toBe('/tutorials/adv');
  });

  it('removes the Next pill when the from-group has no next', async () => {
    stubFetch({ tutorialMappings: [{ ...rows[0], slug: 't4', prev: 't3', next: null }] });
    setPage('t4', '?from=set-up',
      '<a href="/tutorials/x" class="nav-pill nav-pill--primary">Next</a>');
    await runIsland();
    expect(document.querySelector('a.nav-pill--primary')).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run --project unit hugo-apps/src/tutorial-group-nav/main.test.ts`
Expected: FAIL — `./main` not found.

- [ ] **Step 3: Implement the island**

```ts
// hugo-apps/src/tutorial-group-nav/main.ts
//
// Rewrites a tutorial page's Next/Prev pills + Next-Steps card to the neighbours
// of the group the reader entered from (?from=<groupSlug>), using /build/navigator.
// Carries ?from= forward so the chain stays in-group. No ?from= / no matching
// row / fetch error → silent no-op (baked links stand).
import { readFromParam, resolveGroupNav } from '@shared/group-nav-context';

function href(slug: string, from: string): string {
  return `/tutorials/${slug}?from=${encodeURIComponent(from)}`;
}

function ensurePill(
  bottom: HTMLElement,
  which: 'prev' | 'next',
  target: string | null,
  from: string,
): void {
  const selector = which === 'next'
    ? 'a.nav-pill--primary'
    : 'a.nav-pill:not(.nav-pill--primary)';
  let a = bottom.querySelector<HTMLAnchorElement>(selector);
  if (!target) { a?.remove(); return; }
  if (!a) {
    a = document.createElement('a');
    a.className = which === 'next' ? 'nav-pill nav-pill--primary' : 'nav-pill';
    a.innerHTML = which === 'next' ? 'Next &rarr;' : '&larr; Previous';
    if (which === 'next') bottom.appendChild(a);
    else bottom.insertBefore(a, bottom.firstChild); // before the nav-spacer
  }
  a.setAttribute('href', href(target, from));
}

async function run(): Promise<void> {
  const html = document.documentElement;
  if (html.dataset.pageKind !== 'tutorial') return;
  const slug = html.dataset.pageSlug;
  if (!slug) return;
  const from = readFromParam(location.search);
  if (!from) return;
  try {
    const row = await resolveGroupNav(slug, from);
    if (!row) return;
    const bottom = document.querySelector<HTMLElement>('.tutorial-nav-bottom');
    if (bottom) {
      ensurePill(bottom, 'prev', row.prev, from);
      ensurePill(bottom, 'next', row.next, from);
    }
    const card = document.querySelector<HTMLAnchorElement>('a.next-steps-card');
    if (card) {
      if (!row.next) card.remove();
      else card.setAttribute('href', href(row.next, from));
    }
  } catch {
    // silent — baked links are the fallback
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { void run(); });
} else {
  void run();
}

export {};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run --project unit hugo-apps/src/tutorial-group-nav/main.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Register the Vite entry.** In `hugo-apps/vite.config.ts`, add to `rollupOptions.input` (next to `'tutorial-breadcrumbs'`):

```ts
        'tutorial-group-nav': resolve(__dirname, 'src/tutorial-group-nav/main.ts'),
```

- [ ] **Step 6: Load the island on tutorial pages.** In `hugo/layouts/_default/baseof.html`, right after the `tutorial-breadcrumbs` line (~L62), add:

```html
  {{ if eq .Type "tutorials" }}{{ if not site.Params.qa }}<script type="module" src="{{ partial "island-src.html" "tutorial-group-nav" }}" defer></script>{{ end }}{{ end }}
```

- [ ] **Step 7: Verify the Vite build emits the new entry**

Run: `cd hugo-apps && npx vite build && cd ..`
Expected: build succeeds and emits `hugo/static/js/tutorial-group-nav-<hash>.js`. (In a full deploy, `npm run build:island-manifest` maps the hash for `island-src.html`; the partial falls back to `/js/tutorial-group-nav.js` in `hugo server` dev.)

- [ ] **Step 8: Commit**

```bash
git add hugo-apps/src/tutorial-group-nav/ hugo-apps/vite.config.ts hugo/layouts/_default/baseof.html
git commit -m "feat(nav): tutorial-group-nav island rewrites Next/Prev by entry group"
```

---

### Task 6: Context-aware breadcrumb

**Files:**
- Modify: `hugo-apps/src/tutorial-breadcrumbs/main.ts`
- Test: `hugo-apps/src/tutorial-breadcrumbs/main.test.ts`

**Interfaces:**
- Consumes: `readFromParam`, `resolveGroupNav` from `@shared/group-nav-context` (Task 4).

**Context:** When `?from=` is present, resolve mission/group title+slug from the matching navigator row instead of the first-group-only `/build/breadcrumb-context`. Absent `?from=` → current behaviour unchanged.

- [ ] **Step 1: Write the failing test**

```ts
// @vitest-environment happy-dom
// hugo-apps/src/tutorial-breadcrumbs/main.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { _resetCacheForTest } from '@shared/group-nav-context';

const navRows = [{ slug: 't3', missionId: 15069, missionTitle: 'Jump Start', missionSlug: 'jump-start',
  groupId: 15066, groupTitle: 'Set Up', groupSlug: 'set-up', prev: 't2', next: 't4' }];

function setPage(search: string) {
  document.documentElement.dataset.pageKind = 'tutorial';
  document.documentElement.dataset.pageSlug = 't3';
  history.replaceState({}, '', `/tutorials/t3${search}`);
  document.body.innerHTML = `
    <li data-bc-role="mission"><a data-bc-role-link href="/tutorials/mission-x">X</a></li>
    <li data-bc-role="group"><a data-bc-role-link href="/tutorials/group-x">X</a></li>`;
}
async function runIsland() { vi.resetModules(); await import('./main'); await new Promise(r => setTimeout(r, 0)); }

beforeEach(() => { _resetCacheForTest(); document.body.innerHTML = ''; delete document.documentElement.dataset.pageKind; });
afterEach(() => { vi.restoreAllMocks(); });

describe('tutorial-breadcrumbs context-aware', () => {
  it('with ?from= uses the navigator row for that group', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('/build/navigator')) return { ok: true, status: 200, json: async () => ({ tutorialMappings: navRows }) };
      throw new Error('should not hit breadcrumb-context when ?from= resolves');
    }));
    setPage('?from=set-up');
    await runIsland();
    const g = document.querySelector('li[data-bc-role="group"] a') as HTMLAnchorElement;
    expect(g.textContent).toBe('Set Up');
    expect(g.getAttribute('href')).toBe('/tutorials/group-set-up');
    const m = document.querySelector('li[data-bc-role="mission"] a') as HTMLAnchorElement;
    expect(m.getAttribute('href')).toBe('/tutorials/mission-jump-start');
  });

  it('without ?from= falls back to /build/breadcrumb-context', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('/build/breadcrumb-context'))
        return { ok: true, status: 200, json: async () => ({ missionTitle: 'BC M', missionSlug: 'bc-m', groupTitle: 'BC G', groupSlug: 'bc-g' }) };
      return { ok: false, status: 404, json: async () => ({}) };
    }));
    setPage('');
    await runIsland();
    expect((document.querySelector('li[data-bc-role="group"] a') as HTMLAnchorElement).textContent).toBe('BC G');
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run --project unit hugo-apps/src/tutorial-breadcrumbs/main.test.ts`
Expected: FAIL — the `?from=` branch does not exist yet.

- [ ] **Step 3: Edit `hugo-apps/src/tutorial-breadcrumbs/main.ts`.** Add the import at top:

```ts
import { readFromParam, resolveGroupNav } from '@shared/group-nav-context';
```

Replace the body of `refreshBreadcrumbs()` (keep `refreshBreadcrumbRole` as-is) with:

```ts
async function refreshBreadcrumbs(): Promise<void> {
  const html = document.documentElement;
  if (html.dataset.pageKind !== 'tutorial') return;
  const slug = html.dataset.pageSlug;
  if (!slug) return;

  const from = readFromParam(location.search);
  if (from) {
    try {
      const row = await resolveGroupNav(slug, from);
      if (row) {
        refreshBreadcrumbRole('mission', row.missionTitle, row.missionSlug);
        refreshBreadcrumbRole('group', row.groupTitle, row.groupSlug);
        return;
      }
    } catch {
      // fall through to breadcrumb-context
    }
  }

  try {
    const res = await fetch(`/build/breadcrumb-context?tutorial=${encodeURIComponent(slug)}`, {
      credentials: 'omit',
      headers: { 'Accept': 'application/json' },
    });
    if (!res.ok) return;
    const ctx: BreadcrumbContext = await res.json();
    refreshBreadcrumbRole('mission', ctx.missionTitle, ctx.missionSlug);
    refreshBreadcrumbRole('group', ctx.groupTitle, ctx.groupSlug);
  } catch {
    // Silent — static breadcrumb text is the fallback.
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run --project unit hugo-apps/src/tutorial-breadcrumbs/main.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/tutorial-breadcrumbs/main.ts hugo-apps/src/tutorial-breadcrumbs/main.test.ts
git commit -m "feat(nav): context-aware breadcrumb honours ?from= entry group"
```

---

### Task 7: E2E coverage (post-deploy)

**Files:**
- Create: `test/e2e/group-nav-ordering.test.js`

**Context:** Per the e2e-coverage nudge for user-facing UI changes. Self-skips without `PLAYWRIGHT_BASE_URL`/`SMOKE_BASE_URL`; runs post-deploy against a deployed approuter. Uses the known PROD group `set-up-your-sap-hana-cloud-sap-hana-database-and-understand-the-basics` (`trial-3` → `trial-4`).

- [ ] **Step 1: Write the spec**

```js
// e2e: group tutorial navigation stays in-group (#group-nav ordering).
// Entering the 3rd tutorial from the group page must Next → the 4th tutorial
// in the SAME group, not out to another mission's group.
// Self-skips without PLAYWRIGHT_BASE_URL/SMOKE_BASE_URL (repo e2e convention, #1338).
// Run post-deploy only: npx vitest run --project e2e test/e2e/group-nav-ordering.test.js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasBaseUrl } from './e2e.config.js';
import { launchBrowser, newPage } from './_browser.js';

const GROUP = 'set-up-your-sap-hana-cloud-sap-hana-database-and-understand-the-basics';
const THIRD = 'hana-cloud-mission-trial-3';
const FOURTH = 'hana-cloud-mission-trial-4';

describe.skipIf(!hasBaseUrl())('e2e: group nav stays in-group', () => {
  let browser;
  beforeAll(async () => { browser = await launchBrowser(); });
  afterAll(async () => { await browser?.close(); });

  it('group page tags tutorial links with ?from=<group>', async () => {
    const { context, page } = await newPage(browser, { authenticated: false });
    try {
      const res = await page.goto(`/tutorials/group-${GROUP}`, { waitUntil: 'domcontentloaded' });
      expect(res.status()).toBe(200);
      await page.locator('main').first().waitFor({ state: 'visible', timeout: 15_000 });
      const href = await page.locator(`a[href*="/tutorials/${THIRD}"]`).first().getAttribute('href');
      expect(href, 'group link must carry ?from=').toContain(`?from=${GROUP}`);
    } finally { await context.close(); }
  });

  it('Next on the 3rd tutorial (entered from the group) lands on the 4th in-group', async () => {
    const { context, page } = await newPage(browser, { authenticated: false });
    try {
      const res = await page.goto(`/tutorials/${THIRD}?from=${GROUP}`, { waitUntil: 'domcontentloaded' });
      expect(res.status()).toBe(200);
      await page.locator('main').first().waitFor({ state: 'visible', timeout: 15_000 });
      // Island rewrites the baked Next; poll until the href points in-group.
      await expect
        .poll(async () => page.locator('.tutorial-nav-bottom a.nav-pill--primary').getAttribute('href'),
          { timeout: 20_000 })
        .toContain(`/tutorials/${FOURTH}`);
    } finally { await context.close(); }
  });
});
```

- [ ] **Step 2: Sanity-run locally (expected skip)**

Run: `npx vitest run --project e2e test/e2e/group-nav-ordering.test.js`
Expected: SKIPPED (no `PLAYWRIGHT_BASE_URL`), proving the guard works and the file parses.

- [ ] **Step 3: Commit**

```bash
git add test/e2e/group-nav-ordering.test.js
git commit -m "test(e2e): group Next/Prev stays in-group via ?from="
```

---

## Final verification

- [ ] Run the full unit tier: `npx vitest run --project unit` — confirm green (baseline any pre-existing failures first).
- [ ] Build islands: `cd hugo-apps && npx vite build && cd ..` — confirm `tutorial-group-nav-<hash>.js` emitted.
- [ ] Open a PR to `main` (do not direct-merge). Deploy is a FULL `npm run build:all` → `mbt build` → `cf deploy -e ../deploy/<env>.mtaext` (island manifest + SSR change).
- [ ] Post-deploy: `SMOKE_BASE_URL=<env> npx vitest run --project e2e test/e2e/group-nav-ordering.test.js`.

---

## Phase E (follow-up, NOT in this plan): context-aware right-rail side-nav

Making `mission-side-nav` reflect the `?from=` group's mission requires client-side re-rendering of the whole `<ui5-side-navigation>` tree from `/build/navigator` — the server `$groups` is usually empty (mission pages are SSR-only, so `site.GetPage "/tutorials/mission-<slug>"` returns nil) and the current island only paints progress + persists expansion. Because Task 2 makes the baked `missionId`/`missionSlug` the canonical/original mission, the side-nav is already correct for direct visits and for readers entering from the canonical group; only entry from a *non-canonical* mission (e.g. a TechEd app-space reuse) shows the wrong mission tree. Given the size and independence, Phase E should be scoped as its own spec + plan once A–D ship and are verified on DEV.
