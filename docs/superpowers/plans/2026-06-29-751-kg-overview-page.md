# Knowledge Graph Overview Page — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a public Hugo page at `/explore/about/` that explains the SAP Developer Knowledge Graph — what's in it, how it's built, what powers it, and where developers see it — backed by a small live-stats endpoint and one Vue 3 island for the hero counter.

**Architecture:** Two PRs, sequenced. **PR 1** adds the unauthenticated `GET /build/kg-stats` endpoint and a new `kg-stats-counter` Vue island; neither is yet referenced from any page (zero user-visible change). **PR 2** adds the Hugo page, the architecture SVG, real surface screenshots, the CSS partial, and the cross-link on `/explore/`. Both PRs land on `main` independently; PR 2 depends on PR 1 being merged so the live counter has an endpoint to fetch.

**Tech Stack:**
- Backend: SAP CAP (Node.js), `cds.ql`, in-process LRU cache. Express bridge route registered in [srv/server.js](../../../srv/server.js) under the existing `/build/*` family.
- Frontend: Hugo static site (PostCSS + Vue 3 islands). Theme-aware via `data-theme` on `<html>`.
- Tests: Vitest. Unit (`test/unit/`, in-memory SQLite via `cds.test('serve')`), hybrid (`test/hybrid/`, real HANA via `cds bind --exec`), smoke (`test/smoke/`, HTTP against deployed).

**Spec:** [docs/superpowers/specs/2026-06-29-751-kg-overview-page-design.md](../specs/2026-06-29-751-kg-overview-page-design.md).
**Issue:** [#751](https://github.com/sap-tutorials/tutorials-ims/issues/751).
**Worktree:** `D:\projects\tutorials-poc\.claude\worktrees\751-kg-overview-page-spec` on branch `751-kg-overview-page-spec`. Spec and plan commits already live here; both PRs branch from this state.

---

## Prerequisites — read these before starting

1. **Project CLAUDE.md** at `D:/projects/tutorials-poc/CLAUDE.md` — has the canonical command list (`cds watch`, `cds bind --exec`, `npm test`, `npm run build:all`, etc.) and a Gotchas section that flags Windows-specific pitfalls.
2. **Spec document** referenced above. Re-read §Backend additions and §Frontend additions before each PR.
3. **Existing canonical patterns to mimic** (do NOT re-invent these):
   - [srv/routes/advocates-public.js](../../../srv/routes/advocates-public.js) — `/api/advocates` handler. Source of the 60s + SWR `Cache-Control` pattern, the ETag pattern, and the `log = cds.log('namespace')` pattern.
   - [srv/lib/build-catalog.js](../../../srv/lib/build-catalog.js) — the registered `/build/catalog` handler. Source of the destructuring-from-`cds.entities` pattern (`const { Missions, Groups, Tutorials, ... } = cds.entities('com.sap.developers.ims')`).
   - [test/unit/build-tag-labels.test.js](../../../test/unit/build-tag-labels.test.js) — canonical `cds.test('serve', '--in-memory')` + `project.axios.get('/build/...')` pattern. **All PR 1 unit tests should look like this — do NOT mock fetch; spin up the in-memory CAP server.**
   - [hugo-apps/src/nav-dropdown/main.ts](../../../hugo-apps/src/nav-dropdown/main.ts) — minimal Vue island shape (mount onto `getElementById`, `createApp`, done).
4. **Test runners:**
   - Unit: `npm test -- <pattern>` (Vitest workspace `unit`).
   - Hybrid: requires `cf login` to DEV space first; then `npm run test:hybrid -- <pattern>`.
   - Smoke: requires `SMOKE_BASE_URL` + `SMOKE_SRV_URL` env vars; `npm run test:smoke -- <pattern>`.
5. **Do NOT run `npm run publish-content` from this worktree.** That's a separate workflow; see memory entry `feedback_never_run_publish_content_from_workstation`.

---

## File structure (locked at plan time)

### PR 1 — Backend + Island

**Create:**
- `srv/routes/kg-stats.js` — express bridge handler. One default-exported function `kgStatsHandler(req, res)` + a module-local in-memory cache. ~80 lines.
- `test/unit/build-kg-stats.test.js` — five unit tests per spec §Testing. Uses `cds.test('serve', '--in-memory')`. ~120 lines.
- `test/hybrid/kg-stats-endpoint.test.js` — one HANA-real test. ~40 lines.
- `test/smoke/kg-stats.smoke.test.js` — one smoke test. ~25 lines.
- `hugo-apps/src/kg-stats-counter/App.vue` — three-counter component with skeleton, count-up animation, prefers-reduced-motion handling.
- `hugo-apps/src/kg-stats-counter/main.ts` — mount onto `#kg-stats-counter`.
- `hugo-apps/src/kg-stats-counter/__tests__/App.spec.ts` — four Vue unit tests per spec §Testing.

**Modify:**
- `srv/server.js` — add 2 lines: import `kgStatsHandler`, register `app.get('/build/kg-stats', kgStatsHandler)` next to the other `/build/*` registrations.
- `hugo-apps/vite.config.ts` — add 1 line: `'kg-stats-counter': resolve(__dirname, 'src/kg-stats-counter/main.ts'),` to `rollupOptions.input`.

### PR 2 — Page assembly

**Create:**
- `hugo/content/explore/about/_index.md` — frontmatter stub.
- `hugo/layouts/explore/about.html` — page template, six sections.
- `hugo/assets/css/pages/_kg-overview.postcss` — page styles, theme-aware CSS vars for the diagram.
- `hugo/static/img/knowledge-graph/architecture.svg` — hand-authored SVG with CSS vars.
- `hugo/static/img/knowledge-graph/surfaces/sidebar.png` (or `.webp`) — real screenshot.
- `hugo/static/img/knowledge-graph/surfaces/explore.png`
- `hugo/static/img/knowledge-graph/surfaces/concepts.png`
- `hugo/static/img/knowledge-graph/surfaces/joule.png`
- `test/smoke/explore-about.smoke.test.js` — two smoke tests per spec §Testing.

**Modify:**
- `hugo/layouts/explore/single.html` — add "About this graph →" link to the explore page chrome. Single-line change.
- `hugo/assets/css/main.postcss` — `@import './pages/kg-overview';` (one line).
- `hugo/static/js/joule.js` — extend the existing `?joule=open` block at line 742 to also read a `?joule_prompt=...` query parameter and send it as the first message after auto-open. ~10 lines.

---

# PR 1 — `feat(#751): /build/kg-stats endpoint + live counter island`

## Task 1.0 — Branch off main for PR 1

This worktree is currently on `751-kg-overview-page-spec` (which has the spec + plan commits). Each PR is a separate branch off this state so they can be reviewed independently.

**Files:** none yet.

- [ ] **Step 1: Create the PR 1 branch from current HEAD**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/751-kg-overview-page-spec
git checkout -b 751-pr1-kg-stats-endpoint-island
```

- [ ] **Step 2: Confirm clean state**

```bash
git status
```

Expected: `On branch 751-pr1-kg-stats-endpoint-island. nothing to commit, working tree clean.`

---

## Task 1.1 — Write the failing unit tests for `/build/kg-stats`

TDD-first: write the tests against the expected behavior; they should all fail because `srv/routes/kg-stats.js` doesn't exist yet.

**Files:**
- Create: `test/unit/build-kg-stats.test.js`

- [ ] **Step 1: Write the test file**

```js
// test/unit/build-kg-stats.test.js
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

describe('GET /build/kg-stats', () => {
  beforeEach(async () => {
    const { Tutorials, Concepts, ConceptEdges, Missions, Groups } =
      cds.entities('com.sap.developers.ims');
    // Wipe everything the handler reads.
    await DELETE.from(ConceptEdges);
    await DELETE.from(Concepts);
    await DELETE.from(Tutorials);
    await DELETE.from(Missions);
    await DELETE.from(Groups);

    // Seed: 3 tutorials, 2 published concepts (1 draft excluded), 4 edges, 2 missions, 1 group.
    await INSERT.into(Tutorials).entries([
      { ID: '00000000-0000-0000-0000-000000000t01', slug: 'one',   title: 'One' },
      { ID: '00000000-0000-0000-0000-000000000t02', slug: 'two',   title: 'Two' },
      { ID: '00000000-0000-0000-0000-000000000t03', slug: 'three', title: 'Three' },
    ]);
    await INSERT.into(Concepts).entries([
      // Concepts.status is ACTIVE | MERGED | VETOED (per db/knowledge-graph.cds:28).
      // The public-published gate is `status='ACTIVE' AND publishedAt IS NOT NULL`.
      { ID: '00000000-0000-0000-0000-000000000c01', slug: 'cap',    name: 'CAP',    status: 'ACTIVE', publishedAt: '2026-06-28T03:17:42.000Z' },
      { ID: '00000000-0000-0000-0000-000000000c02', slug: 'sapui5', name: 'SAPUI5', status: 'ACTIVE', publishedAt: '2026-06-27T03:17:42.000Z' },
      { ID: '00000000-0000-0000-0000-000000000c03', slug: 'unpub',  name: 'Unpub',  status: 'ACTIVE', publishedAt: null }, // not yet published — excluded
      { ID: '00000000-0000-0000-0000-000000000c04', slug: 'merged', name: 'Merged', status: 'MERGED', publishedAt: '2026-06-28T03:17:42.000Z' }, // merged — excluded
    ]);
    await INSERT.into(ConceptEdges).entries([
      // ConceptEdges.predicate (per db/knowledge-graph.cds:77), status='ACTIVE' default.
      // extractedAt is on the edge (NOT on Concepts) — that's the source for MAX in the handler.
      { ID: '00000000-0000-0000-0000-000000000e01', source_ID: '00000000-0000-0000-0000-000000000c01', target_ID: '00000000-0000-0000-0000-000000000c02', predicate: 'relatedTo', status: 'ACTIVE', extractedAt: '2026-06-28T03:17:42.000Z' },
      { ID: '00000000-0000-0000-0000-000000000e02', source_ID: '00000000-0000-0000-0000-000000000c02', target_ID: '00000000-0000-0000-0000-000000000c01', predicate: 'requires',  status: 'ACTIVE', extractedAt: '2026-06-27T03:17:42.000Z' },
      { ID: '00000000-0000-0000-0000-000000000e03', source_ID: '00000000-0000-0000-0000-000000000c01', target_ID: '00000000-0000-0000-0000-000000000c01', predicate: 'teaches',   status: 'ACTIVE', extractedAt: '2026-06-26T03:17:42.000Z' },
      { ID: '00000000-0000-0000-0000-000000000e04', source_ID: '00000000-0000-0000-0000-000000000c02', target_ID: '00000000-0000-0000-0000-000000000c02', predicate: 'teaches',   status: 'VETOED', extractedAt: '2026-06-25T03:17:42.000Z' }, // vetoed — excluded
    ]);
    await INSERT.into(Missions).entries([
      // Missions extends TaskBase (db/schema.cds:21) — required field is `title`, not `name`.
      { ID: '00000000-0000-0000-0000-000000000m01', slug: 'm1', title: 'Mission 1', published: true, missionType: 'SEQUENTIAL' },
      { ID: '00000000-0000-0000-0000-000000000m02', slug: 'm2', title: 'Mission 2', published: true, missionType: 'SET' },
    ]);
    await INSERT.into(Groups).entries([
      // Groups also extends TaskBase — required field is `title`.
      { ID: '00000000-0000-0000-0000-000000000g01', slug: 'g1', title: 'Group 1' },
    ]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the expected JSON shape with correct counts', async () => {
    const { data, headers, status } = await project.axios.get('/build/kg-stats');
    expect(status).toBe(200);
    expect(data).toEqual({
      tutorials: 3,
      concepts: 2,          // ACTIVE + publishedAt NOT NULL (excludes 'unpub' AND 'merged')
      relationships: 3,     // ACTIVE only (excludes the VETOED edge)
      missionsAndGroups: 3, // 2 missions + 1 group
      lastExtractedAt: '2026-06-28T03:17:42.000Z', // MAX over ACTIVE ConceptEdges.extractedAt
      generatedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    expect(headers['cache-control']).toMatch(/public/);
    expect(headers['cache-control']).toMatch(/max-age=60/);
    expect(headers['cache-control']).toMatch(/stale-while-revalidate=300/);
  });

  it('serves the second call within 60s from cache (no DB hit)', async () => {
    const db = await cds.connect.to('db');
    const runSpy = vi.spyOn(db, 'run');
    // First call — populates cache.
    await project.axios.get('/build/kg-stats');
    const firstCallCount = runSpy.mock.calls.length;
    expect(firstCallCount).toBeGreaterThan(0);
    // Second call within 60s should be served from cache.
    await project.axios.get('/build/kg-stats');
    expect(runSpy.mock.calls.length).toBe(firstCallCount);
    runSpy.mockRestore();
  });

  it('refreshes the cache after the 60s TTL expires', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await project.axios.get('/build/kg-stats');
    vi.advanceTimersByTime(61_000);
    const db = await cds.connect.to('db');
    const runSpy = vi.spyOn(db, 'run');
    await project.axios.get('/build/kg-stats');
    expect(runSpy.mock.calls.length).toBeGreaterThan(0);
    runSpy.mockRestore();
  });

  it('returns the last-good payload with 200 if the DB throws after a successful prior call', async () => {
    // First call seeds the last-good payload.
    const ok = await project.axios.get('/build/kg-stats');
    expect(ok.status).toBe(200);
    const lastGood = ok.data;

    // Force a fresh fetch (advance past TTL) and break the DB.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.advanceTimersByTime(61_000);
    const db = await cds.connect.to('db');
    const runSpy = vi.spyOn(db, 'run').mockRejectedValue(new Error('boom'));

    const degraded = await project.axios.get('/build/kg-stats');
    expect(degraded.status).toBe(200);
    expect(degraded.data.tutorials).toBe(lastGood.tutorials);
    expect(degraded.data.concepts).toBe(lastGood.concepts);
    runSpy.mockRestore();
  });

  it('returns 503 if no last-good payload exists and the DB throws', async () => {
    const db = await cds.connect.to('db');
    const runSpy = vi.spyOn(db, 'run').mockRejectedValue(new Error('boom'));
    // axios validateStatus default rejects 5xx; we have to allow it.
    const res = await project.axios.get('/build/kg-stats', { validateStatus: () => true });
    expect(res.status).toBe(503);
    runSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run the test file — confirm all fail with "Cannot find module"**

```bash
npm test -- test/unit/build-kg-stats.test.js
```

Expected: 5 failures, each citing `Cannot find module '../../srv/routes/kg-stats.js'` or `app.get is not registered`. Confirms the tests target the right gap.

- [ ] **Step 3: Commit the failing test**

```bash
git add test/unit/build-kg-stats.test.js
git commit -m "test(#751): failing unit tests for GET /build/kg-stats"
```

---

## Task 1.2 — Implement the handler to pass the tests

**Files:**
- Create: `srv/routes/kg-stats.js`
- Modify: `srv/server.js` (registration)

- [ ] **Step 1: Write the handler**

```js
// srv/routes/kg-stats.js
// Public unauthenticated endpoint for the knowledge-graph stats counter
// rendered in the hero of /explore/about/. Spec: docs/superpowers/specs/2026-06-29-751-kg-overview-page-design.md.

import cds from '@sap/cds';

const log = cds.log('kg-stats');

const TTL_MS = 60_000;

// Module-local cache. `lastGood` survives DB hiccups; `current` is what the
// 60s TTL serves.
let current = null;          // { payload, expiresAt }
let lastGood = null;         // payload from the most recent successful call

async function computePayload() {
  const db = await cds.connect.to('db');
  const { Tutorials, Concepts, ConceptEdges, Missions, Groups } =
    cds.entities('com.sap.developers.ims');

  // Four COUNT queries + one MAX. Run in parallel — they're independent.
  // Concepts: status='ACTIVE' AND publishedAt IS NOT NULL is the documented
  // public-published gate (db/knowledge-graph.cds:36-39).
  // ConceptEdges: only ACTIVE edges count; VETOED edges are admin-suppressed.
  // lastExtractedAt comes from ConceptEdges.extractedAt — Concepts itself
  // has firstSeenAt/lastSeenAt/publishedAt but NOT extractedAt.
  const [tutCount, conCount, edgeCount, misCount, grpCount, maxExtracted] =
    await Promise.all([
      db.run(SELECT.from(Tutorials).columns('count(*) as n')),
      db.run(
        SELECT.from(Concepts)
          .where({ status: 'ACTIVE', publishedAt: { '!=': null } })
          .columns('count(*) as n')
      ),
      db.run(
        SELECT.from(ConceptEdges)
          .where({ status: 'ACTIVE' })
          .columns('count(*) as n')
      ),
      db.run(SELECT.from(Missions).columns('count(*) as n')),
      db.run(SELECT.from(Groups).columns('count(*) as n')),
      db.run(
        SELECT.from(ConceptEdges)
          .where({ status: 'ACTIVE' })
          .columns('max(extractedAt) as t')
      ),
    ]);

  return {
    tutorials: tutCount[0]?.n ?? 0,
    concepts: conCount[0]?.n ?? 0,
    relationships: edgeCount[0]?.n ?? 0,
    missionsAndGroups: (misCount[0]?.n ?? 0) + (grpCount[0]?.n ?? 0),
    lastExtractedAt: maxExtracted[0]?.t ?? null,
    generatedAt: new Date().toISOString(),
  };
}

export async function kgStatsHandler(req, res) {
  const now = Date.now();
  if (current && current.expiresAt > now) {
    res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
    res.json(current.payload);
    return;
  }

  try {
    const payload = await computePayload();
    current = { payload, expiresAt: now + TTL_MS };
    lastGood = payload;
    res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
    res.json(payload);
  } catch (err) {
    log.error('kg-stats compute failed', err.message);
    if (lastGood) {
      // Graceful degradation: return previous good payload with same caching.
      res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
      res.json(lastGood);
      return;
    }
    res.status(503).json({ error: 'kg_stats_unavailable' });
  }
}

// Exported for tests only — lets the test reset state between cases if needed.
export function _resetKgStatsCache() {
  current = null;
  lastGood = null;
}
```

- [ ] **Step 2: Register the route in `srv/server.js`**

Find the block where the other `/build/*` routes are registered (around line 186). Add this line **next to** `app.get('/build/catalog', buildCatalogHandler);`:

```js
import { kgStatsHandler } from './routes/kg-stats.js';
// ... (in the cds.on('bootstrap') handler, in the /build/* cluster:)
app.get('/build/kg-stats', kgStatsHandler);
```

- [ ] **Step 3: Run the unit tests — confirm all pass**

```bash
npm test -- test/unit/build-kg-stats.test.js
```

Expected: 5 tests pass.

- [ ] **Step 4: Commit the implementation**

```bash
git add srv/routes/kg-stats.js srv/server.js
git commit -m "feat(#751): GET /build/kg-stats endpoint with 60s TTL + graceful fallback"
```

---

## Task 1.3 — Hybrid test against real HANA

The hybrid test catches CAP-vs-SQLite divergences that the unit tests miss (boolean encoding, NULL semantics in `COUNT`, type coercion).

**Files:**
- Create: `test/hybrid/kg-stats-endpoint.test.js`

- [ ] **Step 1: Write the hybrid test**

```js
// test/hybrid/kg-stats-endpoint.test.js
import { describe, it, expect } from 'vitest';
import './_guard.js'; // write-safety guard that other hybrid tests already use
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.');

describe('GET /build/kg-stats against real HANA', () => {
  it('returns positive integer counts and a valid lastExtractedAt', async () => {
    const start = Date.now();
    const { data, status } = await project.axios.get('/build/kg-stats');
    const elapsed = Date.now() - start;

    expect(status).toBe(200);
    expect(typeof data.tutorials).toBe('number');
    expect(data.tutorials).toBeGreaterThanOrEqual(0);
    expect(typeof data.concepts).toBe('number');
    expect(data.concepts).toBeGreaterThanOrEqual(0);
    expect(typeof data.relationships).toBe('number');
    expect(data.relationships).toBeGreaterThanOrEqual(0);
    expect(typeof data.missionsAndGroups).toBe('number');
    expect(data.missionsAndGroups).toBeGreaterThanOrEqual(0);

    // lastExtractedAt is null OR an ISO timestamp.
    if (data.lastExtractedAt !== null) {
      expect(new Date(data.lastExtractedAt).toString()).not.toBe('Invalid Date');
    }
    expect(new Date(data.generatedAt).toString()).not.toBe('Invalid Date');

    // Loose latency check: should be well under 200ms locally with cached HANA conns.
    expect(elapsed).toBeLessThan(2000);
  });
});
```

- [ ] **Step 2: Run the hybrid test**

```bash
# Make sure cf login is current first.
cf target  # confirm pointed at DEV space
npx cds bind --exec -- npx vitest run test/hybrid/kg-stats-endpoint.test.js
```

(Use `npx cds bind --exec` to inject the HDI service binding; the `npm run test:hybrid` script wraps this for the full suite, but for a single test the targeted form is clearer.)

Expected: 1 test passes against real HANA in the DEV space.

- [ ] **Step 3: Commit the hybrid test**

```bash
git add test/hybrid/kg-stats-endpoint.test.js
git commit -m "test(#751): hybrid test for /build/kg-stats against real HANA"
```

---

## Task 1.4 — Smoke test

**Files:**
- Create: `test/smoke/kg-stats.smoke.test.js`

- [ ] **Step 1: Write the smoke test**

```js
// test/smoke/kg-stats.smoke.test.js
import { describe, it, expect } from 'vitest';

const SRV_URL = process.env.SMOKE_SRV_URL;
if (!SRV_URL) {
  throw new Error('SMOKE_SRV_URL not set — set it to the deployed srv URL before running smoke tests');
}

describe('smoke: GET /build/kg-stats', () => {
  it('returns 200 with the expected shape', async () => {
    const res = await fetch(`${SRV_URL}/build/kg-stats`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const body = await res.json();
    expect(typeof body.tutorials).toBe('number');
    expect(typeof body.concepts).toBe('number');
    expect(typeof body.relationships).toBe('number');
    expect(typeof body.missionsAndGroups).toBe('number');
    expect(body.tutorials).toBeGreaterThanOrEqual(0);
  });
});
```

- [ ] **Step 2: Run (after PR 1 deploys; locally just confirm the file parses)**

```bash
# Without a deployed URL, the test will throw at startup. That's expected pre-deploy.
# Sanity-check syntax:
node --check test/smoke/kg-stats.smoke.test.js
```

Expected: no output (syntax OK).

- [ ] **Step 3: Commit**

```bash
git add test/smoke/kg-stats.smoke.test.js
git commit -m "test(#751): smoke test for /build/kg-stats"
```

---

## Task 1.5 — Failing Vue island unit tests

Same TDD shape on the frontend side.

**Files:**
- Create: `hugo-apps/src/kg-stats-counter/__tests__/App.spec.ts`

- [ ] **Step 1: Write the failing Vue tests**

```ts
// hugo-apps/src/kg-stats-counter/__tests__/App.spec.ts
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import App from '../App.vue';

function mockFetch(payload: unknown, init?: { status?: number; ok?: boolean }) {
  const status = init?.status ?? 200;
  const ok = init?.ok ?? status < 400;
  return vi.fn().mockResolvedValue({
    ok,
    status,
    json: async () => payload,
  });
}

describe('KgStatsCounter', () => {
  beforeEach(() => {
    // Reduced motion off by default.
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
    });
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it('renders the skeleton on mount before fetch resolves', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {}))); // never resolves
    const wrapper = mount(App);
    expect(wrapper.find('[data-testid="kg-stats-skeleton"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="kg-stats-counters"]').exists()).toBe(false);
  });

  it('renders final counts after fetch resolves', async () => {
    vi.stubGlobal('fetch', mockFetch({
      tutorials: 1432, concepts: 312, relationships: 2847,
      missionsAndGroups: 96, lastExtractedAt: '2026-06-28T03:17:42Z',
      generatedAt: '2026-06-29T18:04:11Z',
    }));
    const wrapper = mount(App);
    await flushPromises();
    expect(wrapper.find('[data-testid="kg-stats-skeleton"]').exists()).toBe(false);
    expect(wrapper.text()).toContain('1,432');
    expect(wrapper.text()).toContain('312');
    expect(wrapper.text()).toContain('2,847');
  });

  it('renders the static fallback on 5xx', async () => {
    vi.stubGlobal('fetch', mockFetch({ error: 'kg_stats_unavailable' }, { status: 503, ok: false }));
    const wrapper = mount(App);
    await flushPromises();
    expect(wrapper.find('[data-testid="kg-stats-fallback"]').exists()).toBe(true);
  });

  it('skips the count-up animation when prefers-reduced-motion is set', async () => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
    });
    vi.stubGlobal('fetch', mockFetch({
      tutorials: 100, concepts: 50, relationships: 200,
      missionsAndGroups: 10, lastExtractedAt: null, generatedAt: new Date().toISOString(),
    }));
    const wrapper = mount(App);
    await flushPromises();
    // The final value should be present immediately (no count-up).
    expect(wrapper.text()).toContain('100');
    expect(wrapper.text()).toContain('50');
    expect(wrapper.text()).toContain('200');
  });
});
```

- [ ] **Step 2: Confirm the tests fail with "Cannot find module ../App.vue"**

```bash
npx vitest run hugo-apps/src/kg-stats-counter/__tests__/App.spec.ts
```

Expected: All 4 fail, citing the missing `App.vue` import.

- [ ] **Step 3: Commit**

```bash
git add hugo-apps/src/kg-stats-counter/__tests__/App.spec.ts
git commit -m "test(#751): failing Vue tests for kg-stats-counter island"
```

---

## Task 1.6 — Implement the Vue island

**Files:**
- Create: `hugo-apps/src/kg-stats-counter/App.vue`
- Create: `hugo-apps/src/kg-stats-counter/main.ts`
- Modify: `hugo-apps/vite.config.ts` (add input entry)

- [ ] **Step 1: Write `App.vue`**

```vue
<!-- hugo-apps/src/kg-stats-counter/App.vue -->
<script setup lang="ts">
import { ref, onMounted } from 'vue';

interface KgStats {
  tutorials: number;
  concepts: number;
  relationships: number;
  missionsAndGroups: number;
  lastExtractedAt: string | null;
  generatedAt: string;
}

const state = ref<'loading' | 'ready' | 'error'>('loading');
const stats = ref<KgStats | null>(null);
// Displayed values (drive the count-up animation).
const displayTutorials = ref(0);
const displayConcepts = ref(0);
const displayRelationships = ref(0);

function format(n: number): string {
  return new Intl.NumberFormat('en-US').format(n);
}

function animateTo(target: number, setter: (v: number) => void, durationMs: number) {
  const start = performance.now();
  const startValue = 0;
  function frame(now: number) {
    const elapsed = now - start;
    const t = Math.min(1, elapsed / durationMs);
    // Ease-out cubic.
    const eased = 1 - Math.pow(1 - t, 3);
    setter(Math.round(startValue + (target - startValue) * eased));
    if (t < 1) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

onMounted(async () => {
  const prefersReducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  try {
    const res = await fetch('/build/kg-stats');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as KgStats;
    stats.value = data;
    state.value = 'ready';
    if (prefersReducedMotion) {
      displayTutorials.value = data.tutorials;
      displayConcepts.value = data.concepts;
      displayRelationships.value = data.relationships;
    } else {
      animateTo(data.tutorials,    v => (displayTutorials.value    = v), 600);
      animateTo(data.concepts,     v => (displayConcepts.value     = v), 600);
      animateTo(data.relationships,v => (displayRelationships.value= v), 600);
    }
  } catch {
    state.value = 'error';
  }
});
</script>

<template>
  <div class="kg-stats-counter" aria-live="polite">
    <div v-if="state === 'loading'" data-testid="kg-stats-skeleton" class="kg-stats-counter__skeleton">
      <span class="kg-stats-counter__skeleton-cell"></span>
      <span class="kg-stats-counter__skeleton-cell"></span>
      <span class="kg-stats-counter__skeleton-cell"></span>
    </div>
    <div v-else-if="state === 'ready'" data-testid="kg-stats-counters" class="kg-stats-counter__counts">
      <div class="kg-stats-counter__cell">
        <strong class="kg-stats-counter__num">{{ format(displayTutorials) }}</strong>
        <span class="kg-stats-counter__label">tutorials</span>
      </div>
      <div class="kg-stats-counter__cell">
        <strong class="kg-stats-counter__num">{{ format(displayConcepts) }}</strong>
        <span class="kg-stats-counter__label">concepts</span>
      </div>
      <div class="kg-stats-counter__cell">
        <strong class="kg-stats-counter__num">{{ format(displayRelationships) }}</strong>
        <span class="kg-stats-counter__label">relationships</span>
      </div>
    </div>
    <div v-else data-testid="kg-stats-fallback" class="kg-stats-counter__fallback">
      <span>Live counters momentarily unavailable.</span>
    </div>
  </div>
</template>
```

- [ ] **Step 2: Write `main.ts`**

```ts
// hugo-apps/src/kg-stats-counter/main.ts
import { createApp } from 'vue';
import App from './App.vue';

const el = document.getElementById('kg-stats-counter');
if (el) {
  createApp(App).mount(el);
}
```

- [ ] **Step 3: Add the Vite entry**

Open `hugo-apps/vite.config.ts`. Find the `rollupOptions.input` block (~line 178). Add this line next to the other entries (alphabetical sorting is loose in this file; place near the other tutorial-* / explore-related entries):

```ts
'kg-stats-counter': resolve(__dirname, 'src/kg-stats-counter/main.ts'),
```

- [ ] **Step 4: Run the Vue tests**

```bash
npx vitest run hugo-apps/src/kg-stats-counter/__tests__/App.spec.ts
```

Expected: 4 tests pass.

- [ ] **Step 5: Build the islands and confirm `kg-stats-counter.js` lands in `hugo/static/js/`**

```bash
npm run build:apps
ls hugo/static/js/kg-stats-counter.js
```

Expected: file exists. (The post-build collision check `scripts/check-build-collisions.ts` runs automatically; if it fails citing a clash with a Hugo `js.Build` output, rename the entry.)

- [ ] **Step 6: Commit**

```bash
git add hugo-apps/src/kg-stats-counter/ hugo-apps/vite.config.ts hugo/static/js/kg-stats-counter.js
git commit -m "feat(#751): kg-stats-counter Vue 3 island with skeleton + count-up animation"
```

---

## Task 1.7 — Open PR 1

- [ ] **Step 1: Push the branch**

```bash
git push -u origin 751-pr1-kg-stats-endpoint-island
```

- [ ] **Step 2: Open the PR**

```bash
# Write a PR body to a tempfile (use the .git worktree dir for the tempfile, then rm).
cat > $TMPDIR/PR1_BODY.md <<'EOF'
## What

PR 1 of 2 for #751.

Adds the unauthenticated `GET /build/kg-stats` endpoint and the `kg-stats-counter` Vue 3 island. Zero user-visible change — nothing on any page references the island bundle or the endpoint yet. PR 2 wires them up.

## Why

#751 needs a "live counter" in the hero of the new `/explore/about/` page. Landing the endpoint and island separately means the page-assembly PR isn't blocked on design iteration.

## How

- `srv/routes/kg-stats.js` — express bridge handler with a 60s TTL in-memory cache + `Cache-Control: public, max-age=60, stale-while-revalidate=300`. Defensive fallback returns the last-good payload on transient DB failures; 503 only if no good payload exists.
- Five unit tests covering shape, caching, TTL refresh, graceful-degradation, and 503-when-never-good.
- One hybrid test (`test/hybrid/kg-stats-endpoint.test.js`) against real HANA — catches CAP-vs-SQLite COUNT divergences.
- One smoke test for post-deploy verification.
- `hugo-apps/src/kg-stats-counter/` — small Vue island with skeleton → count-up animation → static fallback. Respects `prefers-reduced-motion`.

## Spec

[docs/superpowers/specs/2026-06-29-751-kg-overview-page-design.md](docs/superpowers/specs/2026-06-29-751-kg-overview-page-design.md) §Backend additions / §Frontend additions.

## Verification

- `npm test -- test/unit/build-kg-stats.test.js` — 5/5 ✅
- `npx cds bind --exec -- npx vitest run test/hybrid/kg-stats-endpoint.test.js` — 1/1 ✅
- `npx vitest run hugo-apps/src/kg-stats-counter/__tests__/` — 4/4 ✅
- `npm run build:apps` — bundle `hugo/static/js/kg-stats-counter.js` produced ✅
- Post-deploy: `npm run test:smoke -- test/smoke/kg-stats.smoke.test.js`

Closes #751 partially. PR 2 (`/explore/about/` page) finishes the issue.
EOF
gh pr create --base main --title "feat(#751): /build/kg-stats endpoint + kg-stats-counter island (PR 1 of 2)" --body-file $TMPDIR/PR1_BODY.md
rm $TMPDIR/PR1_BODY.md
```

Expected: PR URL printed.

- [ ] **Step 3: Wait for review / merge.** PR 2 cannot proceed until this is merged (PR 2's smoke test depends on `/build/kg-stats` being live).

---

# PR 2 — `feat(#751): /explore/about/ knowledge-graph overview page`

## Task 2.0 — Branch off main for PR 2

Assumes PR 1 has been merged to `main`. The PR 2 branch starts from the new `main` so PR 2 sees the live `/build/kg-stats` endpoint.

**Files:** none yet.

- [ ] **Step 1: Sync main and branch for PR 2**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/751-kg-overview-page-spec
git checkout main
git pull --ff-only
git checkout -b 751-pr2-explore-about-page
```

- [ ] **Step 2: Confirm `/build/kg-stats` is reachable in DEV**

```bash
curl -s https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com/build/kg-stats | head -c 300
```

Expected: JSON output with `tutorials`, `concepts`, `relationships`, `missionsAndGroups`. If the DEV deploy of PR 1 hasn't completed yet, wait for it (see deploy.yml in CI) — do NOT proceed otherwise; the smoke test will fail.

---

## Task 2.1 — Create the content stub

**Files:**
- Create: `hugo/content/explore/about/_index.md`

- [ ] **Step 1: Write the frontmatter stub**

```markdown
---
title: The SAP Developer Knowledge Graph
description: A live graph of the tutorials, missions, and concepts that power developers.sap.com — built by AI, queried by SPARQL, and ready to explore.
type: explore
layout: about
slug: about
---
```

- [ ] **Step 2: Verify Hugo recognizes the page (it'll 404 until the layout exists, but the page should at least be in the dev server's known list)**

```bash
# Start the dev server in a separate terminal:
#   npm run dev
# Then check:
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:1313/explore/about/
```

Expected: 404 for now (layout missing — that's the next task). The 404 means Hugo discovered the content. A 500 here would indicate a frontmatter syntax error.

- [ ] **Step 3: Commit**

```bash
git add hugo/content/explore/about/_index.md
git commit -m "feat(#751): content stub for /explore/about/"
```

---

## Task 2.2 — Hand-author the architecture SVG

This is the biggest visual asset. Authoring it before the layout lets you focus on it without page-template noise.

**Files:**
- Create: `hugo/static/img/knowledge-graph/architecture.svg`

- [ ] **Step 1: Write the SVG**

Authoring approach: every `fill` / `stroke` is a CSS custom property so the same SVG renders in both light and dark. The variables are defined later in `_kg-overview.postcss` under `[data-theme="light"]` and `[data-theme="dark"]` scopes.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 360" role="img" aria-labelledby="kg-arch-title kg-arch-desc">
  <title id="kg-arch-title">Knowledge Graph architecture</title>
  <desc id="kg-arch-desc">
    Pipeline: tutorial markdown from GitHub flows through the SAP AI Core concept extractor,
    is stored as canonical CDS entities by CAP, and is projected into the SAP HANA Cloud
    Knowledge Graph Engine where it is queried by SPARQL. Four consumers read the graph:
    the tutorial sidebar, the /explore/ visualization, the per-concept landing pages, and
    the Joule learning-path assistant.
  </desc>

  <defs>
    <marker id="kg-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M 0 0 L 10 5 L 0 10 z" style="fill: var(--kg-arrow-fill)"/>
    </marker>
  </defs>

  <!-- Pipeline row: four boxes left-to-right -->
  <g class="kg-pipeline">
    <!-- Box 1: Tutorial markdown -->
    <rect x="20"  y="80"  width="160" height="100" rx="8"
          style="fill: var(--kg-box-source-bg); stroke: var(--kg-box-source-border); stroke-width: 1.5"/>
    <text x="100" y="120" text-anchor="middle" font-family="system-ui, sans-serif" font-size="16" font-weight="600"
          style="fill: var(--kg-box-source-text)">Tutorial markdown</text>
    <text x="100" y="142" text-anchor="middle" font-family="system-ui, sans-serif" font-size="13"
          style="fill: var(--kg-box-source-sub)">GitHub</text>

    <!-- Arrow 1 -->
    <line x1="180" y1="130" x2="220" y2="130" stroke-width="2"
          style="stroke: var(--kg-arrow-fill)" marker-end="url(#kg-arrow)"/>

    <!-- Box 2: Concept extractor -->
    <rect x="220" y="80"  width="160" height="100" rx="8"
          style="fill: var(--kg-box-build-bg); stroke: var(--kg-box-build-border); stroke-width: 1.5"/>
    <text x="300" y="115" text-anchor="middle" font-family="system-ui, sans-serif" font-size="16" font-weight="600"
          style="fill: var(--kg-box-build-text)">Concept extractor</text>
    <text x="300" y="138" text-anchor="middle" font-family="system-ui, sans-serif" font-size="13"
          style="fill: var(--kg-box-build-sub)">SAP AI Core</text>
    <text x="300" y="158" text-anchor="middle" font-family="system-ui, sans-serif" font-size="13"
          style="fill: var(--kg-box-build-sub)">nightly cron</text>

    <!-- Arrow 2 -->
    <line x1="380" y1="130" x2="420" y2="130" stroke-width="2"
          style="stroke: var(--kg-arrow-fill)" marker-end="url(#kg-arrow)"/>

    <!-- Box 3: CDS entities -->
    <rect x="420" y="80"  width="160" height="100" rx="8"
          style="fill: var(--kg-box-build-bg); stroke: var(--kg-box-build-border); stroke-width: 1.5"/>
    <text x="500" y="115" text-anchor="middle" font-family="system-ui, sans-serif" font-size="16" font-weight="600"
          style="fill: var(--kg-box-build-text)">CDS entities</text>
    <text x="500" y="138" text-anchor="middle" font-family="system-ui, sans-serif" font-size="13"
          style="fill: var(--kg-box-build-sub)">CAP · HANA</text>
    <text x="500" y="158" text-anchor="middle" font-family="system-ui, sans-serif" font-size="13"
          style="fill: var(--kg-box-build-sub)">canonical state</text>

    <!-- Arrow 3 -->
    <line x1="580" y1="130" x2="620" y2="130" stroke-width="2"
          style="stroke: var(--kg-arrow-fill)" marker-end="url(#kg-arrow)"/>

    <!-- Box 4: KG projection -->
    <rect x="620" y="80"  width="160" height="100" rx="8"
          style="fill: var(--kg-box-store-bg); stroke: var(--kg-box-store-border); stroke-width: 1.5"/>
    <text x="700" y="115" text-anchor="middle" font-family="system-ui, sans-serif" font-size="16" font-weight="600"
          style="fill: var(--kg-box-store-text)">KG projection</text>
    <text x="700" y="138" text-anchor="middle" font-family="system-ui, sans-serif" font-size="13"
          style="fill: var(--kg-box-store-sub)">HANA KGE</text>
    <text x="700" y="158" text-anchor="middle" font-family="system-ui, sans-serif" font-size="13"
          style="fill: var(--kg-box-store-sub)">SPARQL</text>
  </g>

  <!-- Connector: from KG projection down to the consumer row -->
  <line x1="700" y1="180" x2="700" y2="230" stroke-width="1.5" stroke-dasharray="4,4"
        style="stroke: var(--kg-connector-stroke)"/>
  <text x="700" y="220" text-anchor="middle" font-family="system-ui, sans-serif" font-size="12"
        style="fill: var(--kg-connector-text)">consumed by</text>

  <!-- Consumer row: four chips -->
  <g class="kg-consumers">
    <rect x="100" y="250" width="120" height="50" rx="25"
          style="fill: var(--kg-chip-bg); stroke: var(--kg-chip-border); stroke-width: 1"/>
    <text x="160" y="280" text-anchor="middle" font-family="system-ui, sans-serif" font-size="14"
          style="fill: var(--kg-chip-text)">Tutorial sidebar</text>

    <rect x="260" y="250" width="120" height="50" rx="25"
          style="fill: var(--kg-chip-bg); stroke: var(--kg-chip-border); stroke-width: 1"/>
    <text x="320" y="280" text-anchor="middle" font-family="system-ui, sans-serif" font-size="14"
          style="fill: var(--kg-chip-text)">/explore/</text>

    <rect x="420" y="250" width="120" height="50" rx="25"
          style="fill: var(--kg-chip-bg); stroke: var(--kg-chip-border); stroke-width: 1"/>
    <text x="480" y="280" text-anchor="middle" font-family="system-ui, sans-serif" font-size="14"
          style="fill: var(--kg-chip-text)">Concept pages</text>

    <rect x="580" y="250" width="120" height="50" rx="25"
          style="fill: var(--kg-chip-bg); stroke: var(--kg-chip-border); stroke-width: 1"/>
    <text x="640" y="280" text-anchor="middle" font-family="system-ui, sans-serif" font-size="14"
          style="fill: var(--kg-chip-text)">Joule</text>
  </g>

  <!-- Dashed connector splays from KG projection (top center of consumer row) to each chip -->
  <line x1="700" y1="230" x2="160" y2="250" stroke-width="1" stroke-dasharray="2,3"
        style="stroke: var(--kg-connector-stroke); opacity: .6"/>
  <line x1="700" y1="230" x2="320" y2="250" stroke-width="1" stroke-dasharray="2,3"
        style="stroke: var(--kg-connector-stroke); opacity: .6"/>
  <line x1="700" y1="230" x2="480" y2="250" stroke-width="1" stroke-dasharray="2,3"
        style="stroke: var(--kg-connector-stroke); opacity: .6"/>
  <line x1="700" y1="230" x2="640" y2="250" stroke-width="1" stroke-dasharray="2,3"
        style="stroke: var(--kg-connector-stroke); opacity: .6"/>
</svg>
```

- [ ] **Step 2: Sanity-check the SVG renders standalone**

Open the file in a browser: `file:///D:/projects/tutorials-poc/.claude/worktrees/751-kg-overview-page-spec/hugo/static/img/knowledge-graph/architecture.svg`.

Note: it will render with all elements **invisible** because the CSS variables aren't defined outside the page context. That's correct — the SVG is theme-bound. Open DevTools Elements panel and verify the structure: 4 rects in `.kg-pipeline`, 4 rects in `.kg-consumers`, dashed lines between.

- [ ] **Step 3: Commit**

```bash
git add hugo/static/img/knowledge-graph/architecture.svg
git commit -m "feat(#751): architecture SVG for /explore/about/ (theme-aware via CSS vars)"
```

---

## Task 2.3 — Add the CSS partial with theme-aware tokens

**Files:**
- Create: `hugo/assets/css/pages/_kg-overview.postcss`
- Modify: `hugo/assets/css/main.postcss` (one `@import` line)

- [ ] **Step 1: Write the CSS partial**

```postcss
/* hugo/assets/css/pages/_kg-overview.postcss
   Styles for /explore/about/ — scoped under .kg-overview. */

.kg-overview {
  /* ============================================================
     Theme-aware CSS variables for the architecture SVG.
     Same SVG, different colors per data-theme.
     ============================================================ */
  --kg-arrow-fill: #0a6ed1;
  --kg-connector-stroke: #5b738b;
  --kg-connector-text: #5b738b;

  --kg-box-source-bg: #fff;
  --kg-box-source-border: #5b738b;
  --kg-box-source-text: #1c478a;
  --kg-box-source-sub: #5b738b;

  --kg-box-build-bg: #e8f1fb;
  --kg-box-build-border: #0a6ed1;
  --kg-box-build-text: #1c478a;
  --kg-box-build-sub: #5078a8;

  --kg-box-store-bg: #1c478a;
  --kg-box-store-border: #1c478a;
  --kg-box-store-text: #fff;
  --kg-box-store-sub: #a8c6e8;

  --kg-chip-bg: #fff;
  --kg-chip-border: #cbd5e3;
  --kg-chip-text: #5b738b;

  --kg-hero-grad-from: #0a6ed1;
  --kg-hero-grad-to: #1c478a;
}

[data-theme="dark"] .kg-overview {
  --kg-arrow-fill: #58a6ff;
  --kg-connector-stroke: #7d8590;
  --kg-connector-text: #7d8590;

  --kg-box-source-bg: #1c2028;
  --kg-box-source-border: #7d8590;
  --kg-box-source-text: #c9d1d9;
  --kg-box-source-sub: #7d8590;

  --kg-box-build-bg: #0d2233;
  --kg-box-build-border: #58a6ff;
  --kg-box-build-text: #c9d1d9;
  --kg-box-build-sub: #7da8d6;

  --kg-box-store-bg: #0a4a8e;
  --kg-box-store-border: #58a6ff;
  --kg-box-store-text: #fff;
  --kg-box-store-sub: #a8c6e8;

  --kg-chip-bg: #1c2028;
  --kg-chip-border: #30363d;
  --kg-chip-text: #c9d1d9;

  --kg-hero-grad-from: #0a4a8e;
  --kg-hero-grad-to: #0a1e3c;
}

/* ============================================================
   Layout
   ============================================================ */

.kg-overview {
  color: var(--sapTextColor);
}

.kg-overview__hero {
  background: linear-gradient(180deg, var(--kg-hero-grad-from) 0%, var(--kg-hero-grad-to) 100%);
  color: #fff;
  padding: 4rem 1.5rem 3rem;
  text-align: center;
}
.kg-overview__hero h1 {
  font-size: 2.5rem;
  margin: 0 0 .5rem;
  font-weight: 600;
}
.kg-overview__hero p.lede {
  max-width: 48rem;
  margin: 0 auto 2rem;
  font-size: 1.125rem;
  opacity: .92;
}

.kg-stats-counter {
  display: flex;
  gap: 3rem;
  justify-content: center;
  align-items: baseline;
  flex-wrap: wrap;
}
.kg-stats-counter__cell {
  display: flex;
  flex-direction: column;
  align-items: center;
}
.kg-stats-counter__num {
  font-size: 2.5rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  line-height: 1;
}
.kg-stats-counter__label {
  font-size: .875rem;
  opacity: .85;
  letter-spacing: .04em;
  text-transform: uppercase;
  margin-top: .25rem;
}
.kg-stats-counter__skeleton {
  display: flex;
  gap: 3rem;
  justify-content: center;
}
.kg-stats-counter__skeleton-cell {
  display: block;
  width: 4rem;
  height: 2.5rem;
  background: rgba(255,255,255,.18);
  border-radius: .25rem;
  animation: kg-shimmer 1.4s linear infinite;
}
@keyframes kg-shimmer {
  0%,100% { opacity: .4; }
  50%     { opacity: .8; }
}
.kg-stats-counter__fallback {
  color: rgba(255,255,255,.85);
  font-size: .9rem;
}

@media (max-width: 480px) {
  .kg-stats-counter,
  .kg-stats-counter__skeleton { flex-direction: column; gap: 1.5rem; }
}

/* Section shells */
.kg-overview__section {
  padding: 3rem 1.5rem;
  max-width: 80rem;
  margin: 0 auto;
}
.kg-overview__section > h2 {
  font-size: 1.5rem;
  margin: 0 0 1.5rem;
  font-weight: 600;
}

/* Diagram section */
.kg-overview__diagram {
  background: var(--sapPageBackground, transparent);
}
.kg-overview__diagram svg {
  display: block;
  width: 100%;
  height: auto;
  max-width: 56rem;
  margin: 0 auto;
}
.kg-overview__diagram p {
  max-width: 48rem;
  margin: 1.5rem auto 0;
  font-size: 1rem;
  line-height: 1.6;
}

/* Corpus grid */
.kg-overview__corpus {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 1.5rem;
}
.kg-overview__corpus-card {
  background: var(--sapTile_Background);
  border: 1px solid var(--sapList_BorderColor);
  border-radius: .5rem;
  padding: 1.5rem;
  text-align: center;
}
.kg-overview__corpus-card .icon { font-size: 2rem; line-height: 1; margin-bottom: .5rem; }
.kg-overview__corpus-card h3 { margin: 0 0 .25rem; font-size: 1.125rem; }
.kg-overview__corpus-card .count {
  display: block;
  font-size: 1.75rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: var(--sapBrandColor, #0a6ed1);
  margin: .5rem 0;
}
@media (max-width: 768px) { .kg-overview__corpus { grid-template-columns: 1fr; } }

/* Tech badge grid */
.kg-overview__tech {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 1rem;
}
.kg-overview__tech-badge {
  background: var(--sapTile_Background);
  border: 1px solid var(--sapList_BorderColor);
  border-radius: .5rem;
  padding: 1rem 1.25rem;
  text-decoration: none;
  color: var(--sapTextColor);
  display: flex;
  flex-direction: column;
  gap: .25rem;
}
.kg-overview__tech-badge h3 { font-size: 1rem; margin: 0; font-weight: 600; }
.kg-overview__tech-badge p { font-size: .875rem; margin: 0; color: var(--sapContent_LabelColor); }
.kg-overview__tech-badge.is-hana {
  /* Visual cue that the three HANA tiles share a HANA Cloud instance. */
  border-color: var(--sapBrandColor, #0a6ed1);
  box-shadow: 0 0 0 1px var(--sapBrandColor, #0a6ed1);
}
.kg-overview__tech-callout {
  grid-column: 1 / -1;
  font-size: .875rem;
  color: var(--sapContent_LabelColor);
  font-style: italic;
  text-align: center;
  margin-top: .5rem;
}
@media (max-width: 768px) { .kg-overview__tech { grid-template-columns: repeat(2, 1fr); } }

/* Surfaces grid */
.kg-overview__surfaces {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 1.5rem;
}
.kg-overview__surface-card {
  background: var(--sapTile_Background);
  border: 1px solid var(--sapList_BorderColor);
  border-radius: .5rem;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
.kg-overview__surface-card .img-frame {
  background: #fafafa;          /* Light frame around the always-light screenshots */
  padding: 1rem;
}
[data-theme="dark"] .kg-overview__surface-card .img-frame {
  background: #1c2028;
  border-bottom: 1px solid var(--sapList_BorderColor);
}
.kg-overview__surface-card .img-frame img { width: 100%; height: auto; display: block; border-radius: .25rem; }
.kg-overview__surface-card .body { padding: 1rem 1.25rem 1.25rem; }
.kg-overview__surface-card h3 { margin: 0 0 .25rem; font-size: 1.125rem; }
.kg-overview__surface-card p  { margin: 0 0 1rem; font-size: .9375rem; color: var(--sapContent_LabelColor); }
.kg-overview__surface-card .primary {
  display: inline-flex;
  align-items: center;
  gap: .25rem;
  background: var(--sapBrandColor, #0a6ed1);
  color: #fff;
  padding: .5rem 1rem;
  border-radius: .25rem;
  text-decoration: none;
  font-weight: 500;
}
.kg-overview__surface-card .secondary {
  display: inline-flex;
  align-items: center;
  gap: .25rem;
  color: var(--sapLinkColor, #0a6ed1);
  text-decoration: none;
  font-weight: 500;
}
@media (max-width: 768px) { .kg-overview__surfaces { grid-template-columns: 1fr; } }

/* CTA strip */
.kg-overview__cta-strip {
  background: var(--sapBackgroundColor, #f5f6f7);
  border-top: 1px solid var(--sapList_BorderColor);
  padding: 2rem 1.5rem;
}
.kg-overview__cta-strip-inner {
  max-width: 80rem;
  margin: 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1.5rem;
  flex-wrap: wrap;
}
.kg-overview__cta-strip a.primary {
  background: var(--sapBrandColor, #0a6ed1);
  color: #fff;
  padding: .75rem 1.5rem;
  border-radius: .25rem;
  text-decoration: none;
  font-weight: 600;
  font-size: 1.0625rem;
}
.kg-overview__cta-strip ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  gap: 1.5rem;
  font-size: .9375rem;
}
.kg-overview__cta-strip ul a {
  color: var(--sapLinkColor, #0a6ed1);
  text-decoration: none;
}
.kg-overview__cta-strip ul a:hover { text-decoration: underline; }
```

- [ ] **Step 2: Import the partial in main.postcss**

Open `hugo/assets/css/main.postcss`. Find the existing `@import './pages/...'` block. Add:

```postcss
@import './pages/kg-overview';
```

- [ ] **Step 3: Verify Hugo builds**

```bash
# In a separate terminal, npm run dev should already be running. Reload, look for css errors in the dev server output.
# Alternatively:
npm run build:all
```

Expected: no PostCSS errors.

- [ ] **Step 4: Commit**

```bash
git add hugo/assets/css/pages/_kg-overview.postcss hugo/assets/css/main.postcss
git commit -m "feat(#751): theme-aware CSS for /explore/about/"
```

---

## Task 2.4 — Write the page template

**Files:**
- Create: `hugo/layouts/explore/about.html`

- [ ] **Step 1: Write the template**

```html
{{ define "main" }}
<main class="kg-overview" data-page-kind="explore-about">

  <!-- ============================================================
       1. HERO
       ============================================================ -->
  <section class="kg-overview__hero">
    <h1>The SAP Developer Knowledge Graph</h1>
    <p class="lede">
      A live graph of the tutorials, missions, and concepts that make up
      developers.sap.com, built by AI and powered by SAP HANA Cloud.
    </p>
    <div id="kg-stats-counter" aria-live="polite"></div>
  </section>

  <!-- ============================================================
       2. ARCHITECTURE DIAGRAM (the "wow")
       ============================================================ -->
  <section class="kg-overview__section kg-overview__diagram" aria-labelledby="kg-arch">
    <h2 id="kg-arch">How it's built</h2>
    {{ readFile "static/img/knowledge-graph/architecture.svg" | safeHTML }}
    <p>
      Every night, a CAP cron job hands each tutorial's markdown to
      <strong>SAP AI Core</strong>. The model extracts concepts (e.g. <em>CAP</em>,
      <em>SAPUI5</em>, <em>HANA Cloud</em>) and the edges between them — what a
      tutorial <em>teaches</em>, what it <em>requires</em>. Those facts are stored
      as canonical CDS entities in <strong>SAP HANA Cloud</strong> and projected
      into the database's built-in <strong>Knowledge Graph Engine</strong>, where
      SPARQL queries answer "what should I learn next?" in single-digit milliseconds.
    </p>
  </section>

  <!-- ============================================================
       3. CORPUS BREAKDOWN
       ============================================================ -->
  <section class="kg-overview__section" aria-labelledby="kg-corpus">
    <h2 id="kg-corpus">What's in the graph</h2>
    <div class="kg-overview__corpus">
      <div class="kg-overview__corpus-card">
        <div class="icon" aria-hidden="true">📚</div>
        <h3>Tutorials</h3>
        <span class="count" data-kg-count="tutorials">—</span>
        <p>Every tutorial in the <code>sap-tutorials/*</code> GitHub org. Edges: <em>teaches Concept</em>, <em>requires Concept</em>.</p>
      </div>
      <div class="kg-overview__corpus-card">
        <div class="icon" aria-hidden="true">🧠</div>
        <h3>Concepts</h3>
        <span class="count" data-kg-count="concepts">—</span>
        <p>AI-extracted topics — CAP, SAPUI5, HANA Cloud, … Edges: <em>requires Concept</em>, <em>relatedTo Concept</em>.</p>
      </div>
      <div class="kg-overview__corpus-card">
        <div class="icon" aria-hidden="true">🛤️</div>
        <h3>Missions &amp; groups</h3>
        <span class="count" data-kg-count="missionsAndGroups">—</span>
        <p>Curated learning paths. Edges: <em>containsTutorial</em>.</p>
      </div>
    </div>
  </section>

  <!-- ============================================================
       4. TECH BADGE GRID
       ============================================================ -->
  <section class="kg-overview__section" aria-labelledby="kg-tech">
    <h2 id="kg-tech">The tech behind it</h2>
    <div class="kg-overview__tech">
      <a class="kg-overview__tech-badge is-hana" href="https://help.sap.com/docs/hana-cloud-database/sap-hana-cloud-sap-hana-database-administration-guide/knowledge-graph-engine" target="_blank" rel="noopener">
        <h3>SAP HANA Cloud Knowledge Graph Engine</h3>
        <p>RDF triple store; SPARQL via <code>SYS.SPARQL_EXECUTE</code>.</p>
      </a>
      <a class="kg-overview__tech-badge is-hana" href="https://help.sap.com/docs/hana-cloud-database/sap-hana-cloud-sap-hana-database-vector-engine-guide/sap-hana-cloud-sap-hana-database-vector-engine-guide" target="_blank" rel="noopener">
        <h3>SAP HANA Cloud Vector Engine</h3>
        <p>Embedding similarity. Powers concept consolidation.</p>
      </a>
      <a class="kg-overview__tech-badge is-hana" href="https://help.sap.com/docs/hana-cloud/multi-model" target="_blank" rel="noopener">
        <h3>SAP HANA Cloud Multi-Model</h3>
        <p>Graph, vector, and relational data — one database, no ETL.</p>
      </a>
      <a class="kg-overview__tech-badge" href="https://help.sap.com/docs/sap-ai-core" target="_blank" rel="noopener">
        <h3>SAP AI Core / Generative AI Hub</h3>
        <p>LLM extracts concepts from tutorial markdown nightly; a weekly consolidator merges near-duplicates.</p>
      </a>
      <a class="kg-overview__tech-badge" href="https://cap.cloud.sap/docs/" target="_blank" rel="noopener">
        <h3>SAP Cloud Application Programming Model (CAP)</h3>
        <p>Service layer, scheduler, and the cron jobs that build the graph.</p>
      </a>
      <a class="kg-overview__tech-badge" href="https://help.sap.com/docs/btp/sap-business-technology-platform/cloud-foundry-environment" target="_blank" rel="noopener">
        <h3>SAP BTP Cloud Foundry</h3>
        <p>The runtime.</p>
      </a>
      <p class="kg-overview__tech-callout">
        All three HANA tiles run on the same SAP HANA Cloud instance — that's the multi-model story.
      </p>
    </div>
  </section>

  <!-- ============================================================
       5. SURFACES GRID
       ============================================================ -->
  <section class="kg-overview__section" aria-labelledby="kg-surfaces">
    <h2 id="kg-surfaces">Where you see it in action</h2>
    <div class="kg-overview__surfaces">
      <article class="kg-overview__surface-card">
        <div class="img-frame">
          <img src="/img/knowledge-graph/surfaces/explore.png" alt="The /explore/ interactive visualization with a force-directed layout of concepts and tutorials.">
        </div>
        <div class="body">
          <h3>Live graph at <code>/explore/</code></h3>
          <p>Force-directed interactive visualization of the whole graph. Search for a concept, click a node, follow the edges.</p>
          <a class="primary" href="/explore/">Open the live graph →</a>
        </div>
      </article>
      <article class="kg-overview__surface-card">
        <div class="img-frame">
          <img src="/img/knowledge-graph/surfaces/sidebar.png" alt="A tutorial-page sidebar listing prerequisites, related tutorials, and suggested next steps.">
        </div>
        <div class="body">
          <h3>On every tutorial page</h3>
          <p>A sidebar surfaces prerequisites, related tutorials, and suggested next steps based on the concepts a tutorial teaches.</p>
          <a class="secondary" href="/tutorials/abap-cloud-getting-started/">See it on a tutorial →</a>
        </div>
      </article>
      <article class="kg-overview__surface-card">
        <div class="img-frame">
          <img src="/img/knowledge-graph/surfaces/concepts.png" alt="A concept landing page describing CAP with sections for tutorials that teach, require, and relate.">
        </div>
        <div class="body">
          <h3>Concept landing pages</h3>
          <p>One page per concept — what it teaches, what requires it, what relates. Indexed by site search.</p>
          <a class="secondary" href="/concepts/">Browse concepts →</a>
        </div>
      </article>
      <article class="kg-overview__surface-card">
        <div class="img-frame">
          <img src="/img/knowledge-graph/surfaces/joule.png" alt="Joule chat panel showing a learning path between two tutorials with three intermediate tutorials.">
        </div>
        <div class="body">
          <h3>Joule learning paths</h3>
          <p>"Find me the shortest path between two tutorials." Joule queries the graph and returns the steps.</p>
          <a class="secondary" href="/?joule=open&joule_prompt=Find%20the%20shortest%20learning%20path%20between%20two%20tutorials">Ask Joule →</a>
        </div>
      </article>
    </div>
  </section>

  <!-- ============================================================
       6. CTA STRIP
       ============================================================ -->
  <section class="kg-overview__cta-strip" aria-label="Try the knowledge graph">
    <div class="kg-overview__cta-strip-inner">
      <a class="primary" href="/explore/">Explore the live graph →</a>
      <ul>
        <li><a href="https://help.sap.com/docs/hana-cloud-database/sap-hana-cloud-sap-hana-database-administration-guide/knowledge-graph-engine" target="_blank" rel="noopener">Read the SAP HANA Cloud KG docs →</a></li>
        <li><a href="https://github.com/sap-tutorials/tutorials-ims" target="_blank" rel="noopener">View the source on GitHub →</a></li>
      </ul>
    </div>
  </section>

</main>

<!-- After PR 1's island bundle is built, this script tag wires up the hero counter. -->
<script type="module" src="/js/kg-stats-counter.js" defer></script>

<!-- Light-weight inline script: also populate the corpus counts (no Vue island needed for these three numbers). -->
<script>
  (async function () {
    try {
      const res = await fetch('/build/kg-stats');
      if (!res.ok) return;
      const data = await res.json();
      document.querySelectorAll('[data-kg-count]').forEach((el) => {
        const key = el.getAttribute('data-kg-count');
        const v = data[key];
        if (typeof v === 'number') el.textContent = new Intl.NumberFormat('en-US').format(v);
      });
    } catch { /* leave the em-dash placeholder */ }
  })();
</script>

{{ end }}
```

- [ ] **Step 2: Build and view the page locally**

```bash
npm run build:all   # or rely on npm run dev being live
```

Visit `http://localhost:1313/explore/about/`. You should see:
- Hero with the title + lede + three live counters (animating from 0 → final).
- Architecture diagram rendering correctly (CSS variables wired).
- Three corpus tiles with counts.
- Six tech badges (three with the HANA shared-border treatment).
- Four surface cards with light-framed screenshots (the screenshot files don't exist yet — they'll show broken-image icons; that's Task 2.5).
- CTA strip at the bottom.

- [ ] **Step 3: Toggle the theme via the shellbar — confirm both modes look right**

The shellbar's `#sb-theme` button toggles `data-theme` on `<html>`. Verify the diagram, hero, and badge grid all adapt. The four surface screenshots stay light, framed by a darker container in dark mode — that's by design.

- [ ] **Step 4: Commit**

```bash
git add hugo/layouts/explore/about.html
git commit -m "feat(#751): page template for /explore/about/"
```

---

## Task 2.5 — Capture the four surface screenshots

Real product screenshots, normalized dimensions, light-themed. These can be `.png` or `.webp` — `.png` is fine for screenshots with text (sharper).

**Files:**
- Create: `hugo/static/img/knowledge-graph/surfaces/sidebar.png`
- Create: `hugo/static/img/knowledge-graph/surfaces/explore.png`
- Create: `hugo/static/img/knowledge-graph/surfaces/concepts.png`
- Create: `hugo/static/img/knowledge-graph/surfaces/joule.png`

- [ ] **Step 1: Capture each surface**

Sources:
1. **explore.png** — Visit `https://tutorial-system-dev-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com/explore/`. Wait for the viz to settle. Capture roughly the visible viewport, ~1400×900 px.
2. **sidebar.png** — Visit a representative tutorial that has a healthy KG sidebar (e.g. `/tutorials/abap-cloud-getting-started/` if it has one, or whichever tutorial has the most populated sidebar). Capture the sidebar element plus a small slice of the tutorial body for context. ~700×900 px.
3. **concepts.png** — Visit `/concepts/cap/` (or whichever concept slug has the richest landing page). Capture roughly the same dimensions as `explore.png`.
4. **joule.png** — Open Joule shellbar from any page, ask "Find the shortest learning path from `abap-cloud-getting-started` to `cap-getting-started`," wait for the response, screenshot the Joule panel + the path output. ~480×800 px.

Normalize all four to a similar aspect ratio (~3:2 looks balanced in the 2×2 grid). Use a tool like ImageMagick or your screenshot app's crop function. Optimize file size with `pngquant` or `cwebp` — target ~80-150 KB per image. **Strip EXIF metadata** if your screenshot tool includes location data.

- [ ] **Step 2: Place them under `hugo/static/img/knowledge-graph/surfaces/`**

Filename matches the `<img src>` in the template.

- [ ] **Step 3: Reload `/explore/about/` and confirm the surfaces grid renders**

Each card should show a real screenshot, no broken-image icons.

- [ ] **Step 4: Commit**

```bash
git add hugo/static/img/knowledge-graph/surfaces/
git commit -m "feat(#751): real product screenshots for /explore/about/ surfaces grid"
```

---

## Task 2.6 — Add the `/explore/` cross-link

The cross-link from `/explore/` to `/explore/about/` is the one change outside the new files.

**Files:**
- Modify: `hugo/layouts/explore/single.html`

- [ ] **Step 1: Add the link**

Open `hugo/layouts/explore/single.html`. The current layout is a single `<div id="explore-app">`. Add a small chrome link above that div, **inside `{{ define "main" }}`**:

```html
{{ define "main" }}
<div id="explore-app" class="explore-page">
  <a class="explore-page__about-link" href="/explore/about/">About this graph →</a>
  {{ with site.Data.explore_bundle }}
  ... (rest unchanged)
```

And add the corresponding minimal CSS — into `_kg-overview.postcss` is fine (the class is page-adjacent), or add to a new tiny partial. Recommended: a few lines at the bottom of `_kg-overview.postcss`:

```postcss
.explore-page__about-link {
  position: absolute;
  top: .75rem;
  right: 1rem;
  z-index: 10;
  color: var(--sapLinkColor, #0a6ed1);
  text-decoration: none;
  font-size: .9375rem;
  background: var(--sapTile_Background);
  border: 1px solid var(--sapList_BorderColor);
  border-radius: .25rem;
  padding: .375rem .75rem;
}
.explore-page__about-link:hover { text-decoration: underline; }
```

- [ ] **Step 2: Verify locally**

Visit `http://localhost:1313/explore/`. The "About this graph →" link is in the top-right of the explore page. Click it; you should land on `/explore/about/`.

- [ ] **Step 3: Commit**

```bash
git add hugo/layouts/explore/single.html hugo/assets/css/pages/_kg-overview.postcss
git commit -m "feat(#751): cross-link from /explore/ → /explore/about/"
```

---

## Task 2.7 — Extend joule.js to handle `?joule_prompt=...`

The Joule surface card's CTA opens Joule with a pre-filled prompt. The existing `joule.js` handles `?joule=open` at line 742 — extend that block to also read `?joule_prompt`.

**Files:**
- Modify: `hugo/static/js/joule.js`

- [ ] **Step 1: Find the existing block**

```bash
grep -n "joule.*open\|URLSearchParams" hugo/static/js/joule.js | head -10
```

You're looking for the block around line 742 where `params.get('joule') === 'open'` triggers `_openImpl()`.

- [ ] **Step 2: Extend the block**

Replace the auto-open block with one that also reads `joule_prompt`. Note that `_openImpl` already accepts an `opts` object with an `autoSendText` string field (see [hugo/static/js/joule.js:587-590](../../../hugo/static/js/joule.js#L587-L590) — `if (opts && typeof opts.autoSendText === 'string' && opts.autoSendText.length > 0) { send(opts.autoSendText); return; }`). Pass an object, NOT a bare string:

```js
// Auto-open after login redirect: _openImpl() appends ?joule=open to returnTo,
// so when XSUAA bounces the user back here, we re-enter the panel.
// Also: ?joule_prompt=<text> opens Joule with a pre-filled prompt (used by
// /explore/about/ #751). _openImpl's existing opts.autoSendText path skips
// the hero/starters and sends the prompt immediately.
const params = new URLSearchParams(location.search);
if (params.get('joule') === 'open') {
  const prefillPrompt = params.get('joule_prompt') || null;
  params.delete('joule');
  params.delete('joule_prompt');
  const cleaned = params.toString();
  history.replaceState(null, '', location.pathname + (cleaned ? '?' + cleaned : '') + location.hash);
  if (prefillPrompt) {
    _openImpl({ autoSendText: prefillPrompt });
  } else {
    _openImpl();
  }
}
```

- [ ] **Step 3: Verify locally**

Reload `/explore/about/`. Click the Joule surface card's "Ask Joule →" link. Joule should open AND immediately send the pre-filled prompt "Find the shortest learning path between two tutorials" — you'll see the transcript appear with the user message at the top, no hero/starter cards.

- [ ] **Step 4: Commit**

```bash
git add hugo/static/js/joule.js
git commit -m "feat(#751): joule.js handles ?joule_prompt for pre-filled prompts"
```

---

## Task 2.8 — Smoke test for the page

**Files:**
- Create: `test/smoke/explore-about.smoke.test.js`

- [ ] **Step 1: Write the smoke test**

```js
// test/smoke/explore-about.smoke.test.js
import { describe, it, expect } from 'vitest';

const BASE_URL = process.env.SMOKE_BASE_URL;
if (!BASE_URL) {
  throw new Error('SMOKE_BASE_URL not set — set it to the deployed approuter URL');
}

describe('smoke: /explore/about/', () => {
  it('returns 200 with HTML content-type', async () => {
    const res = await fetch(`${BASE_URL}/explore/about/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
  });

  it('HTML body contains the expected hero title', async () => {
    const res = await fetch(`${BASE_URL}/explore/about/`);
    const html = await res.text();
    expect(html).toContain('The SAP Developer Knowledge Graph');
    expect(html).toContain('id="kg-stats-counter"');
  });
});
```

- [ ] **Step 2: Sanity-check the syntax**

```bash
node --check test/smoke/explore-about.smoke.test.js
```

Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add test/smoke/explore-about.smoke.test.js
git commit -m "test(#751): smoke test for /explore/about/"
```

---

## Task 2.9 — Manual one-time pass

Before opening PR 2, walk through the manual checklist from spec §Testing strategy → "Manual one-time pass at merge".

- [ ] **Step 1: Lighthouse a11y audit**

Open `http://localhost:1313/explore/about/` in Chrome. Open DevTools → Lighthouse. Run a "Best practices + Accessibility" audit. Score target: a11y ≥ 95.

If anything flags: fix it before opening the PR. Common issues for this kind of page: missing alt text on images (the SVG has `<title>`/`<desc>`; the surface images already have `alt=`), insufficient color contrast on the badge tiles in one of the themes.

- [ ] **Step 2: Dark-mode walkthrough**

Toggle the shellbar theme. Walk every section:
- Hero gradient: white text on the deeper dark gradient — readable?
- Architecture SVG: all eight boxes/rects visible against the dark background? Arrows visible?
- Corpus cards: legible against the dark `--sapTile_Background`?
- Tech badges: HANA shared-border visible in dark?
- Surface cards: light screenshots framed by dark wrapper — does this look intentional or jarring?
- CTA strip: contrast holds?

- [ ] **Step 3: Mobile walkthrough**

DevTools mobile emulator at 375 px width. Walk every section. Architecture SVG should scale down (the `viewBox` handles that automatically). Hero counters should stack. Corpus / surfaces grids should be 1-col.

- [ ] **Step 4: Cross-browser**

Spot-check the page in Safari and Firefox (Chrome was your dev browser). The Vue island uses standard `fetch` + Vue 3; no exotic APIs. Worth a 30-second check.

- [ ] **Step 5: Run all the unit + hybrid + smoke tests local-against-DEV**

```bash
# Make sure nothing regressed.
npm test
SMOKE_BASE_URL=https://tutorial-system-dev-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com \
SMOKE_SRV_URL=https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com \
  npm run test:smoke -- test/smoke/explore-about.smoke.test.js test/smoke/kg-stats.smoke.test.js
```

Expected: everything green.

- [ ] **Step 6: (no commit — manual review notes go in the PR body)**

---

## Task 2.10 — Open PR 2

- [ ] **Step 1: Push the branch**

```bash
git push -u origin 751-pr2-explore-about-page
```

- [ ] **Step 2: Open the PR**

```bash
cat > $TMPDIR/PR2_BODY.md <<'EOF'
## What

PR 2 of 2 for #751.

Adds the public Hugo page at `/explore/about/` — the narrative companion to `/explore/`. Hero with live stats counter, architecture diagram (the "wow"), corpus breakdown, six SAP tech badges, 2×2 surfaces grid, CTA strip. Theme-aware (light + dark) from day one. Closes #751.

## Spec

[docs/superpowers/specs/2026-06-29-751-kg-overview-page-design.md](docs/superpowers/specs/2026-06-29-751-kg-overview-page-design.md).

## What's in this PR

- `hugo/content/explore/about/_index.md` — frontmatter stub.
- `hugo/layouts/explore/about.html` — page template (six sections per spec).
- `hugo/assets/css/pages/_kg-overview.postcss` — page styles + theme-aware CSS variables for the architecture SVG. `@import`-ed by `main.postcss`.
- `hugo/static/img/knowledge-graph/architecture.svg` — hand-authored SVG; theme-bound via CSS vars.
- `hugo/static/img/knowledge-graph/surfaces/{sidebar,explore,concepts,joule}.png` — real product screenshots.
- `hugo/layouts/explore/single.html` — added "About this graph →" link.
- `hugo/static/js/joule.js` — extended `?joule=open` handler to also accept `?joule_prompt=...` for pre-filled prompts.
- `test/smoke/explore-about.smoke.test.js` — 2 smoke tests.

## Verification

- Manual checklist (Lighthouse a11y, dark-mode walkthrough, mobile, cross-browser) — all passed locally per Task 2.9.
- All unit + hybrid + smoke tests green locally against DEV.

## Visual

[attach 2-3 screenshots in the PR — light hero, dark hero, mobile]

Closes #751.
EOF
gh pr create --base main --title "feat(#751): /explore/about/ knowledge-graph overview page (PR 2 of 2)" --body-file $TMPDIR/PR2_BODY.md
rm $TMPDIR/PR2_BODY.md
```

Expected: PR URL printed.

- [ ] **Step 3: After merge, verify the deployed page**

Once PR 2 deploys to DEV:
```bash
curl -s -o /dev/null -w '%{http_code}\n' https://tutorial-system-dev-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com/explore/about/
```

Expected: `200`.

Visit the URL in a browser. Confirm everything looks right post-deploy. If anything regressed against the local-DEV behavior (CSP issues, font loading, etc.), open a hot-fix PR rather than reverting.

---

# Cross-cutting notes

## Commit hygiene reminders

- **Verify branch before every commit** ([feedback_verify_branch_before_commit](C:/Users/I809764/.claude/projects/d--projects-tutorials-poc/memory/feedback_verify_branch_before_commit.md)). Run `git branch --show-current` in the same Bash invocation as the commit; long sessions silently revert HEAD.
- **CRLF on Windows** ([feedback_crlf_regression_on_windows](C:/Users/I809764/.claude/projects/d--projects-tutorials-poc/memory/feedback_crlf_regression_on_windows.md)). Spawned subagents have flipped LF → CRLF on file edits in this repo. Periodically check `file path/to/changed/file.js` (Git Bash on Windows). If it says `CRLF line terminators`, fix with `sed -i 's/\r$//' <file>`.
- **`.claude/settings.local.json` drift is noise.** The harness rewrites it on every session. `git restore .claude/settings.local.json` before each commit if it shows as modified.
- **Never run `npm run publish-content` from this worktree.** Content publishing is CI-driven; running it locally can roll back deployed content ([feedback_never_run_publish_content_from_workstation](C:/Users/I809764/.claude/projects/d--projects-tutorials-poc/memory/feedback_never_run_publish_content_from_workstation.md)).

## CDS / CAP guardrails

- All four `COUNT(*)` queries in the handler use `cds.ql` (`SELECT.from(...)` with `count(*) as n`). **Never raw SQL.**
- Entity names are pinned in the spec and lock at plan time: `Tutorials`, `Concepts` (status='PUBLISHED'), `ConceptEdges`, `Missions`, `Groups`. **Not `CompletionPaths`** — see spec amendments and [db/schema.cds](../../../db/schema.cds:68) where `Groups` is the entity name.
- Use `cds.log('kg-stats')` for the route's logger (matches the surrounding code).
- Before changing any CDS shape, search via cds-mcp; the project rule (CLAUDE.md global rules) is: prefer `cds-mcp__search_model` over reading `*.cds` files manually.

## Hugo / island guardrails

- The `kg-stats-counter` Vite entry MUST be unique against Hugo's `js.Build` outputs ([feedback list lookup in the gotchas section of CLAUDE.md, issue #251 hit this once with `tutorial.js`]). The post-build collision check in [scripts/check-build-collisions.ts](../../../scripts/check-build-collisions.ts) will fail the build with a file:line ref if there's a clash. If it fails: rename the entry.
- The island uses `defineProperty(window, 'matchMedia', ...)` mocks in tests. If your test environment is jsdom-based (it is — Vitest workspace `unit` uses jsdom), this works. **Do NOT switch the test environment to node.**
- Hugo's `readFile` directive in the layout (`{{ readFile "static/img/knowledge-graph/architecture.svg" | safeHTML }}`) inlines the SVG so CSS variables apply. **Never use `<img src>` for the architecture SVG** — that breaks the theme treatment because variables defined on the parent page don't reach into a child document.

## Smoke-test env vars

The two smoke tests both require env vars to know what URL to hit:
- `SMOKE_BASE_URL` — the approuter URL. For DEV: `https://tutorial-system-dev-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com`.
- `SMOKE_SRV_URL` — the srv URL. For DEV: `https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com`.

These are set automatically in CI's deploy-then-smoke job (see `.github/workflows/deploy.yml`). Locally you must `export` them before `npm run test:smoke`.

## Effort estimate (recap from spec)

- **PR 1:** ~1 day. Mechanical endpoint + small island. Most of the time is reading the canonical patterns referenced in Prerequisites.
- **PR 2:** ~2-3 days. Page assembly is a few hours. The four real screenshots take ~1 hour. The architecture SVG plus a dark-mode visual pass is the bulk — budget half a day for iteration.

---

# Out of scope — these are NOT this plan's job

If you find yourself doing any of the below, stop. They are explicitly deferred or off the table per the spec.

- **Phase 4 corpus types** (learning journeys, blog posts, videos, API docs, code samples). Each lands as a 1-bullet follow-up PR per sub-phase as those phases ship.
- **A top-level nav entry / global IA change.** The page is reachable via `/explore/`'s chrome link, slide URLs, README links, tweets, Google. Adding it to the top nav clutters it and isn't worth it.
- **A page-scoped theme toggle.** The site-wide shellbar theme toggle governs this page.
- **Visual-regression / screenshot-diff tests.** Adding an infrastructure for one marketing page is over-engineering.
- **A mini-viz teaser inside the page** (a degraded Sigma.js render of 20 nodes). Duplicating a degraded `/explore/` on the showcase page confuses visitors about which is "real."
- **A second screenshot set for dark theme.** The single light screenshots framed by theme-aware containers is the right cost trade.
- **The RAG-backed `getRelevantSteps` Joule tool as a fifth surface card.** Invisible to the user; nothing screenshot-worthy. May be added later if the page feels missing-a-piece in practice — that's a follow-up.
- **A `/build/kg-stats` extension to `KnowledgeGraphService`'s OData surface.** The stats endpoint is the hand-curated `/build/*` family; do not add it to the OData service.

---

# Acceptance checklist (read this before either PR opens)

When all of these are true, the PR is ready:

- [ ] All unit tests pass: `npm test -- test/unit/build-kg-stats.test.js`
- [ ] All Vue island tests pass: `npx vitest run hugo-apps/src/kg-stats-counter/__tests__/`
- [ ] Hybrid test passes locally: `npx cds bind --exec -- npx vitest run test/hybrid/kg-stats-endpoint.test.js`
- [ ] Smoke tests pass against DEV: `npm run test:smoke -- <both smoke files>` (PR 2 only — PR 1's smoke runs in CI post-deploy)
- [ ] `npm run build:apps` produces `hugo/static/js/kg-stats-counter.js` (PR 1)
- [ ] `npm run build:all` finishes clean (PR 2; this also runs the PostCSS pipeline)
- [ ] Branch name matches the convention: `751-pr1-...` / `751-pr2-...`
- [ ] Commit messages all reference `#751` and use `feat(#751)`, `test(#751)`, `fix(#751)` prefixes
- [ ] No `.claude/settings.local.json` drift in the commit list
- [ ] CRLF check passed on every modified file
- [ ] PR body cites the spec path and the manual verification matrix from Task 2.9 (PR 2 only)
- [ ] Page works in **both** light and dark mode (PR 2 only)
- [ ] Page is readable on mobile at 375 px (PR 2 only)
- [ ] Lighthouse a11y ≥ 95 (PR 2 only)

When the issue closes:

- [ ] PR 1 merged to main
- [ ] PR 2 merged to main
- [ ] Issue #751 auto-closes via `Closes #751` in PR 2 (PR 1 used `Closes #751 partially.` — that doesn't auto-close)
- [ ] Memory entry written (`admin_shell_*` style — a `reference` memory naming `/explore/about/` and explaining the live-counter trick, so future maintainers find it when changing `/build/kg-stats`)
- [ ] Architecture doc touched if the page becomes a documented dependency of `/explore/` (probably not — it's a sibling marketing page; pure narrative, no other surface depends on it)

