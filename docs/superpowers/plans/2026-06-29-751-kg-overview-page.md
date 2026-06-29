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
      { ID: '00000000-0000-0000-0000-000000000c01', slug: 'cap',   name: 'CAP',   status: 'PUBLISHED', extractedAt: '2026-06-28T03:17:42.000Z' },
      { ID: '00000000-0000-0000-0000-000000000c02', slug: 'sapui5', name: 'SAPUI5', status: 'PUBLISHED', extractedAt: '2026-06-27T03:17:42.000Z' },
      { ID: '00000000-0000-0000-0000-000000000c03', slug: 'draft', name: 'Draft', status: 'DRAFT',     extractedAt: '2026-06-29T03:17:42.000Z' },
    ]);
    await INSERT.into(ConceptEdges).entries([
      { ID: '00000000-0000-0000-0000-000000000e01', source_ID: '00000000-0000-0000-0000-000000000c01', target_ID: '00000000-0000-0000-0000-000000000c02', kind: 'relatedTo' },
      { ID: '00000000-0000-0000-0000-000000000e02', source_ID: '00000000-0000-0000-0000-000000000c02', target_ID: '00000000-0000-0000-0000-000000000c01', kind: 'requires' },
      { ID: '00000000-0000-0000-0000-000000000e03', source_ID: '00000000-0000-0000-0000-000000000c01', target_ID: '00000000-0000-0000-0000-000000000c01', kind: 'teaches' },
      { ID: '00000000-0000-0000-0000-000000000e04', source_ID: '00000000-0000-0000-0000-000000000c02', target_ID: '00000000-0000-0000-0000-000000000c02', kind: 'teaches' },
    ]);
    await INSERT.into(Missions).entries([
      { ID: '00000000-0000-0000-0000-000000000m01', slug: 'm1', name: 'Mission 1', published: true },
      { ID: '00000000-0000-0000-0000-000000000m02', slug: 'm2', name: 'Mission 2', published: true },
    ]);
    await INSERT.into(Groups).entries([
      { ID: '00000000-0000-0000-0000-000000000g01', slug: 'g1', name: 'Group 1' },
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
      concepts: 2,          // draft excluded
      relationships: 4,
      missionsAndGroups: 3, // 2 missions + 1 group
      lastExtractedAt: '2026-06-28T03:17:42.000Z', // MAX over PUBLISHED concepts
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
  const [tutCount, conCount, edgeCount, misCount, grpCount, maxExtracted] =
    await Promise.all([
      db.run(SELECT.from(Tutorials).columns('count(*) as n')),
      db.run(SELECT.from(Concepts).where({ status: 'PUBLISHED' }).columns('count(*) as n')),
      db.run(SELECT.from(ConceptEdges).columns('count(*) as n')),
      db.run(SELECT.from(Missions).columns('count(*) as n')),
      db.run(SELECT.from(Groups).columns('count(*) as n')),
      db.run(SELECT.from(Concepts).where({ status: 'PUBLISHED' }).columns('max(extractedAt) as t')),
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
  const prefersReducedMotion = window.matchMedia?.('(prefers-color-scheme: reduce)')?.matches
    || window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
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
