# Personalized "What's Next" Recommendations — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Worktree required:** Per `feedback_parallel_agents_worktrees`, set up `.worktrees/personalized-recommendations` with branch `feature/personalized-recommendations` before starting (skill: superpowers:using-git-worktrees). All commits below assume that branch.

**Goal:** Replace the build-time tag/co-completion blender output in `hugo/layouts/partials/next-steps.html`'s "Related Tutorials" rail with a runtime, per-user personalized ranking that reuses existing per-step embeddings, the existing co-completion aggregator, and the existing user-progress lookup. Anonymous visitors get similarity-ranked recs; authenticated users additionally get already-completed tutorials filtered.

**Architecture:** New backend orchestrator `srv/lib/recommend.js` blends `0.6·cosine(centroid_t, centroid_c) + 0.4·co_completion(t, c)` with filters (self, completed, unpublished). Centroids come from a new `srv/lib/tutorial-centroid.js` module (in-process LRU averaging step embeddings — no schema change). New unauthenticated `GET /api/recommendations?slug=...` endpoint reads the XSUAA session if present. A small Hugo+TS island (`hugo/assets/js/recommend.ts`) fetches the endpoint and swaps `.next-steps-grid` cards on success, falling back silently to the server-rendered static rail on any failure.

**Tech Stack:** CAP Node.js (`@sap/cds`), HANA Cloud (raw-SQL carve-out for LOB-locator avoidance), SQLite (test path), Hugo (esbuild via `js.Build`), TypeScript, Vitest.

**Spec:** [docs/superpowers/specs/2026-05-22-personalized-recommendations-design.md](../specs/2026-05-22-personalized-recommendations-design.md)

---

## Codebase orientation (read once before starting)

- Existing reused modules:
  - `srv/lib/co-completion.js` — `computeCoCompletions({ topN, force })` returns `{ slug: [{ slug, score }, ...], ... }`. 1h cache. Already wired to express handler at `/build/co-completions`.
  - `srv/lib/user-progress.js` — `getUserProgress(user)` returns `{ inProgress, completedSlugs, completedMissionSlugs, completedGroupSlugs }`. Uses `user.__dbUserId` per-request cache. `completedSlugs` is an Array of strings.
  - `srv/lib/embedding-query.js` — HANA raw-SQL precedent. Identifiers stored upper-case in catalog: `"COM_SAP_DEVELOPERS_IMS_TUTORIALEMBEDDING"`, columns `"TUTORIAL_ID"`, `"STEPNUMBER"`, `"EMBEDDING"`, `"EMBEDDINGMODEL"`. Tutorials table: `"COM_SAP_DEVELOPERS_IMS_TUTORIALS"`, columns `"ID"`, `"SLUG"`, `"TITLE"`. SQLite test path uses CDS QL on `cds.entities('com.sap.developers.ims').TutorialEmbedding`.
- Express handler registration site: `srv/server.js:101-118` — `app.get(...)` calls during `cds.on('bootstrap')`. Add the new route alongside `/api/qrcode` and `/build/co-completions`.
- Hugo partial site: `hugo/layouts/partials/next-steps.html` — currently mounts the rail when `Params.recommendations` is non-empty. Mounted from `hugo/layouts/tutorials/u1-object-page.html:272` inside `<section id="op-resources">`.
- Hugo TypeScript bootstrap: `hugo/assets/js/ui5-bootstrap.ts` — pattern is "side-effect import; module self-bootstraps; gated on DOM presence". See `./reading-progress`, `./lightbox`, `./mission-side-nav` for precedent.
- Smoke test scaffolding: `test/smoke/smoke.config.js` exports `BASE_URL` and `fetchWithRetry`. SMOKE_BASE_URL is the AppRouter; SMOKE_SRV_URL is the CAP srv URL (used directly by `/api/...` smoke tests).
- Existing smoke tests for the rail: `test/smoke/next-steps-recommendations.test.js`. Don't break it — it asserts `Related Tutorials` heading + `next-steps-rail-card` markup are server-rendered.

---

## File structure

| File | Action | Responsibility |
|---|---|---|
| `srv/lib/tutorial-centroid.js` | **create** | `getCentroid(tutorialId)` — averages step embeddings; in-process LRU. Returns `Float32Array` or `null`. |
| `srv/lib/recommend.js` | **create** | `recommend({ currentSlug, user, limit })` — orchestrates centroid + co-completion + filter + top-K. Exports `RANKING_WEIGHTS = { sim: 0.6, co: 0.4 }`. Per-process LRU. |
| `srv/handlers/recommendations.js` | **create** | Express handler. Validates query, resolves user, calls `recommend()`, shapes JSON. |
| `srv/server.js` | **modify** | Register `app.get('/api/recommendations', ...)` next to `/api/qrcode`. |
| `hugo/layouts/partials/next-steps-card.html` | **create** | One-card markup (server-rendered loop and JS island both consume it). |
| `hugo/layouts/partials/next-steps.html` | **modify** | Rail wrapper gets `data-recommend-slug`; loop body delegated to `next-steps-card.html`; inline `<template>` added for client-side cloning. |
| `hugo/assets/js/recommend.ts` | **create** | Self-bootstrapping JS island. Fetch + DOM swap. Gated on `[data-recommend-slug]`. |
| `hugo/assets/js/ui5-bootstrap.ts` | **modify** | Add `import "./recommend";` next to other gated modules. |
| `test/unit/lib/tutorial-centroid.test.js` | **create** | Vitest unit tests for centroid math + LRU + null-on-empty. |
| `test/unit/lib/recommend.test.js` | **create** | Vitest unit tests for ranker, filters, blend, tiebreak, cold-start. |
| `test/unit/handlers/recommendations.test.js` | **create** | Vitest tests for handler shape (400/404/200/500, anon vs auth, limit clamp). |
| `test/hybrid/recommend-hana.test.js` | **create** | Real-HANA test for centroid + raw-SQL cosine match. |
| `test/smoke/recommendations.test.js` | **create** | HTTP smoke for endpoint + Hugo wrapper presence. |

---

## Pre-flight

- [ ] **Step 0a: Create worktree**

```bash
# From repo root
git worktree add .worktrees/personalized-recommendations -b feature/personalized-recommendations
cd .worktrees/personalized-recommendations
npm install
```

- [ ] **Step 0b: Verify baseline tests pass**

```bash
npm test
```

Expected: existing unit suite green (≥29 known pre-existing failures on main per `project_main_test_failures` are acceptable; verify the count doesn't increase).

---

## Task 1: TutorialCentroid module

Pure-JS averaging + LRU. No DB on first cut — we'll exercise it with synthetic vectors. The HANA path is exercised in the hybrid test (Task 4).

**Files:**
- Create: `srv/lib/tutorial-centroid.js`
- Test: `test/unit/lib/tutorial-centroid.test.js`

- [ ] **Step 1.1: Write the failing test**

```js
// test/unit/lib/tutorial-centroid.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import { __resetForTest, averageVectors, getCentroid } from '../../../srv/lib/tutorial-centroid.js';

beforeEach(() => __resetForTest());

describe('averageVectors', () => {
  it('averages element-wise into Float32Array', () => {
    const v1 = new Float32Array([1, 2, 3]);
    const v2 = new Float32Array([3, 4, 5]);
    const out = averageVectors([v1, v2]);
    expect(Array.from(out)).toEqual([2, 3, 4]);
    expect(out).toBeInstanceOf(Float32Array);
  });

  it('returns null on empty input', () => {
    expect(averageVectors([])).toBeNull();
  });

  it('skips dim-mismatched rows but keeps going', () => {
    const v1 = new Float32Array([1, 1, 1]);
    const bad = new Float32Array([5, 5]);
    const v2 = new Float32Array([3, 3, 3]);
    const out = averageVectors([v1, bad, v2]);
    expect(Array.from(out)).toEqual([2, 2, 2]);
  });
});

describe('getCentroid LRU', () => {
  it('returns same Float32Array reference on second call within TTL (cache hit)', async () => {
    let calls = 0;
    const loader = async () => {
      calls += 1;
      return [new Float32Array([1, 2, 3])];
    };
    const a = await getCentroid('tutA', loader);
    const b = await getCentroid('tutA', loader);
    expect(a).toBe(b);
    expect(calls).toBe(1);
  });

  it('returns null when loader yields no rows', async () => {
    const out = await getCentroid('empty', async () => []);
    expect(out).toBeNull();
  });
});
```

- [ ] **Step 1.2: Run test to verify it fails**

```bash
npx vitest run test/unit/lib/tutorial-centroid.test.js
```

Expected: FAIL — module not found.

- [ ] **Step 1.3: Implement minimal module**

```js
// srv/lib/tutorial-centroid.js
const TTL_MS = 30 * 60 * 1000;
const MAX_ENTRIES = 256;

const cache = new Map(); // key -> { value, at }

export function __resetForTest() { cache.clear(); }

export function averageVectors(vectors) {
  if (!vectors || vectors.length === 0) return null;
  // Pick the modal dimension; skip rows that don't match.
  const dimCounts = new Map();
  for (const v of vectors) dimCounts.set(v.length, (dimCounts.get(v.length) ?? 0) + 1);
  let dim = 0, best = 0;
  for (const [d, c] of dimCounts) if (c > best) { best = c; dim = d; }
  const out = new Float32Array(dim);
  let kept = 0;
  for (const v of vectors) {
    if (v.length !== dim) continue;
    for (let i = 0; i < dim; i++) out[i] += v[i];
    kept += 1;
  }
  if (kept === 0) return null;
  for (let i = 0; i < dim; i++) out[i] /= kept;
  return out;
}

export async function getCentroid(tutorialId, loadVectors) {
  const now = Date.now();
  const hit = cache.get(tutorialId);
  if (hit && now - hit.at < TTL_MS) return hit.value;

  const vectors = await loadVectors(tutorialId);
  const value = averageVectors(vectors);

  cache.set(tutorialId, { value, at: now });
  if (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
  return value;
}
```

- [ ] **Step 1.4: Run test to verify it passes**

```bash
npx vitest run test/unit/lib/tutorial-centroid.test.js
```

Expected: PASS, all 5 tests green.

- [ ] **Step 1.5: Commit**

```bash
git add srv/lib/tutorial-centroid.js test/unit/lib/tutorial-centroid.test.js
git commit -m "feat(recommend): add tutorial centroid LRU module"
```

---

## Task 2: Recommend module (ranker + filter + cache)

Pure logic. Mocks the three external deps (centroid loader, co-completion map, user progress). HANA queries belong to Task 4.

**Files:**
- Create: `srv/lib/recommend.js`
- Test: `test/unit/lib/recommend.test.js`

- [ ] **Step 2.1: Write the failing test**

```js
// test/unit/lib/recommend.test.js
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { __resetForTest as resetCentroid } from '../../../srv/lib/tutorial-centroid.js';
import { recommend, RANKING_WEIGHTS, __resetForTest as resetRecommend } from '../../../srv/lib/recommend.js';

const f = (...nums) => new Float32Array(nums);

// Three "tutorials": current + two candidates. Centroids chosen so c1 is more similar.
const centroids = {
  cur: f(1, 0, 0),
  c1:  f(0.9, 0.1, 0),
  c2:  f(0, 1, 0)
};
const candidates = [
  { ID: 'cur-id', slug: 'cur', title: 'Current', primaryTag: 'CAP', published: true, time: 30 },
  { ID: 'c1-id',  slug: 'c1',  title: 'Cand One', primaryTag: 'CAP', published: true, time: 20 },
  { ID: 'c2-id',  slug: 'c2',  title: 'Cand Two', primaryTag: 'BTP', published: true, time: 45 }
];

const deps = {
  loadAllTutorials: async () => candidates,
  loadCentroid: async (id) => {
    if (id === 'cur-id') return centroids.cur;
    if (id === 'c1-id')  return centroids.c1;
    if (id === 'c2-id')  return centroids.c2;
    return null;
  },
  loadCoCompletions: async () => ({ cur: [{ slug: 'c1', score: 5 }, { slug: 'c2', score: 1 }] }),
  loadUserProgress: async (user) => user
    ? { completedSlugs: ['c2'] }
    : { completedSlugs: [] }
};

beforeEach(() => { resetCentroid(); resetRecommend(); });

describe('recommend()', () => {
  it('weights similarity 0.6 and co-completion 0.4', () => {
    expect(RANKING_WEIGHTS).toEqual({ sim: 0.6, co: 0.4 });
  });

  it('returns top-K with current slug excluded', async () => {
    const r = await recommend({ currentSlug: 'cur', user: null, limit: 3 }, deps);
    expect(r.recommendations.map(x => x.slug)).not.toContain('cur');
  });

  it('filters completed slugs for authed user, includes them for anon', async () => {
    const authed = await recommend({ currentSlug: 'cur', user: { id: 'u1' }, limit: 3 }, deps);
    const anon = await recommend({ currentSlug: 'cur', user: null, limit: 3 }, deps);
    expect(authed.recommendations.map(x => x.slug)).not.toContain('c2');
    expect(anon.recommendations.map(x => x.slug)).toContain('c2');
  });

  it('marks personalized=true only when completed-filter actually removed something', async () => {
    const authed = await recommend({ currentSlug: 'cur', user: { id: 'u1' }, limit: 3 }, deps);
    expect(authed.personalized).toBe(true);
    const anon = await recommend({ currentSlug: 'cur', user: null, limit: 3 }, deps);
    expect(anon.personalized).toBe(false);
  });

  it('orders by blended score; c1 (more similar + higher co) ranks above c2', async () => {
    const r = await recommend({ currentSlug: 'cur', user: null, limit: 3 }, deps);
    expect(r.recommendations[0].slug).toBe('c1');
  });

  it('returns reason=no_embedding when current centroid is null', async () => {
    const noEmb = { ...deps, loadCentroid: async (id) => id === 'cur-id' ? null : centroids.c1 };
    const r = await recommend({ currentSlug: 'cur', user: null, limit: 3 }, noEmb);
    expect(r).toEqual({ currentSlug: 'cur', personalized: false, recommendations: [], reason: 'no_embedding' });
  });

  it('falls back to similarity-only when co-completion map is empty', async () => {
    const noCo = { ...deps, loadCoCompletions: async () => ({}) };
    const r = await recommend({ currentSlug: 'cur', user: null, limit: 3 }, noCo);
    expect(r.recommendations[0].slug).toBe('c1');
  });

  it('skips unpublished candidates', async () => {
    const unpub = {
      ...deps,
      loadAllTutorials: async () => candidates.map(c => c.slug === 'c1' ? { ...c, published: false } : c)
    };
    const r = await recommend({ currentSlug: 'cur', user: null, limit: 3 }, unpub);
    expect(r.recommendations.map(x => x.slug)).not.toContain('c1');
  });

  it('clamps limit to 6 max', async () => {
    const r = await recommend({ currentSlug: 'cur', user: null, limit: 99 }, deps);
    expect(r.recommendations.length).toBeLessThanOrEqual(6);
  });

  it('tiebreak prefers same primaryTag, then title-asc', async () => {
    // Two candidates with identical scores; one shares primaryTag with current.
    const tied = {
      loadAllTutorials: async () => ([
        { ID: 'cur-id', slug: 'cur', title: 'Current', primaryTag: 'CAP', published: true },
        { ID: 'a-id', slug: 'a-twin', title: 'Twin A', primaryTag: 'BTP', published: true },
        { ID: 'b-id', slug: 'b-twin', title: 'Twin B', primaryTag: 'CAP', published: true }
      ]),
      loadCentroid: async () => f(1, 0, 0),
      loadCoCompletions: async () => ({}),
      loadUserProgress: async () => ({ completedSlugs: [] })
    };
    const r = await recommend({ currentSlug: 'cur', user: null, limit: 3 }, tied);
    expect(r.recommendations[0].slug).toBe('b-twin');
  });

  it('caches identical (slug,user) requests within TTL', async () => {
    let coCalls = 0;
    const counted = { ...deps, loadCoCompletions: async () => { coCalls++; return {}; } };
    await recommend({ currentSlug: 'cur', user: null, limit: 3 }, counted);
    await recommend({ currentSlug: 'cur', user: null, limit: 3 }, counted);
    expect(coCalls).toBe(1);
  });
});
```

- [ ] **Step 2.2: Run test to verify it fails**

```bash
npx vitest run test/unit/lib/recommend.test.js
```

Expected: FAIL — module not found.

- [ ] **Step 2.3: Implement minimal module**

```js
// srv/lib/recommend.js
import { getCentroid } from './tutorial-centroid.js';

export const RANKING_WEIGHTS = { sim: 0.6, co: 0.4 };
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX = 1024;

const cache = new Map(); // key -> { value, at }
export function __resetForTest() { cache.clear(); }

function cosineNorm(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  if (!denom) return 0;
  return (dot / denom + 1) / 2;
}

export async function recommend({ currentSlug, user, limit = 3 }, deps) {
  if (!currentSlug) throw new Error('currentSlug required');
  const cap = Math.max(1, Math.min(6, limit | 0));
  const key = `${currentSlug}:${user?.id || 'anon'}:${cap}`;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.value;

  const all = await deps.loadAllTutorials();
  const current = all.find(t => t.slug === currentSlug);
  if (!current) {
    const out = { currentSlug, personalized: false, recommendations: [], reason: 'unknown_slug' };
    storeCache(key, out, now);
    return out;
  }

  const curCentroid = await deps.loadCentroid(current.ID);
  if (!curCentroid) {
    const out = { currentSlug, personalized: false, recommendations: [], reason: 'no_embedding' };
    storeCache(key, out, now);
    return out;
  }

  const coAll = await safeCo(deps);
  const coForCurrent = coAll[currentSlug] || [];
  const coBySlug = new Map(coForCurrent.map(x => [x.slug, x.score]));
  const coMax = coForCurrent.reduce((m, x) => Math.max(m, x.score), 0) || 1;

  const completedSlugs = new Set((await deps.loadUserProgress(user))?.completedSlugs || []);

  const scored = [];
  for (const c of all) {
    if (c.slug === currentSlug) continue;
    if (c.published === false) continue;
    const cCentroid = await deps.loadCentroid(c.ID);
    const sim = cosineNorm(curCentroid, cCentroid);
    const co = (coBySlug.get(c.slug) || 0) / coMax;
    const score = RANKING_WEIGHTS.sim * sim + RANKING_WEIGHTS.co * co;
    scored.push({ slug: c.slug, title: c.title, primaryTag: c.primaryTag, time: c.time, score, _completed: completedSlugs.has(c.slug) });
  }

  const filtered = user ? scored.filter(s => !s._completed) : scored;
  filtered.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const aSame = a.primaryTag === current.primaryTag ? 1 : 0;
    const bSame = b.primaryTag === current.primaryTag ? 1 : 0;
    if (aSame !== bSame) return bSame - aSame;
    return a.title.localeCompare(b.title);
  });

  const filteredDropped = user && filtered.length < scored.length;
  const recommendations = filtered.slice(0, cap).map(({ _completed, ...rest }) => rest);

  const out = { currentSlug, personalized: !!filteredDropped, recommendations };
  storeCache(key, out, now);
  return out;
}

async function safeCo(deps) {
  try { return await deps.loadCoCompletions(); }
  catch { return {}; }
}

function storeCache(key, value, at) {
  cache.set(key, { value, at });
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
}
```

- [ ] **Step 2.4: Run test to verify it passes**

```bash
npx vitest run test/unit/lib/recommend.test.js
```

Expected: PASS, all 11 tests green.

- [ ] **Step 2.5: Commit**

```bash
git add srv/lib/recommend.js test/unit/lib/recommend.test.js
git commit -m "feat(recommend): add ranking+filter+cache module"
```

---

## Task 3: Express handler + server.js wiring

Wraps the pure recommender with CDS-aware deps (real co-completion, user-progress, tutorial loader). Validates query params; logs via `cds.log('recommend')`.

**Files:**
- Create: `srv/handlers/recommendations.js`
- Modify: `srv/server.js` (add import + `app.get(...)`)
- Test: `test/unit/handlers/recommendations.test.js`

- [ ] **Step 3.1: Write the failing handler test**

```js
// test/unit/handlers/recommendations.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { __resetForTest } from '../../../srv/lib/recommend.js';

const recommendMock = vi.fn();
vi.mock('../../../srv/lib/recommend.js', async (orig) => ({
  ...(await orig()),
  recommend: (...args) => recommendMock(...args)
}));

let recommendationsHandler;
beforeEach(async () => {
  __resetForTest();
  recommendMock.mockReset();
  ({ recommendationsHandler } = await import('../../../srv/handlers/recommendations.js'));
});

function makeRes() {
  const res = { status: vi.fn(() => res), json: vi.fn(() => res) };
  return res;
}

describe('GET /api/recommendations handler', () => {
  it('400 on missing slug', async () => {
    const res = makeRes();
    await recommendationsHandler({ query: {}, user: null }, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('404 when recommend reports unknown_slug', async () => {
    recommendMock.mockResolvedValueOnce({ currentSlug: 'x', personalized: false, recommendations: [], reason: 'unknown_slug' });
    const res = makeRes();
    await recommendationsHandler({ query: { slug: 'x' }, user: null }, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('200 with body for happy path', async () => {
    recommendMock.mockResolvedValueOnce({ currentSlug: 'a', personalized: true, recommendations: [{ slug: 'b', title: 'B', primaryTag: 'CAP', score: 0.5 }] });
    const res = makeRes();
    await recommendationsHandler({ query: { slug: 'a' }, user: { id: 'u1' } }, res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ currentSlug: 'a', personalized: true }));
  });

  it('clamps limit=99 to 6 before calling recommend', async () => {
    recommendMock.mockResolvedValueOnce({ currentSlug: 'a', personalized: false, recommendations: [] });
    const res = makeRes();
    await recommendationsHandler({ query: { slug: 'a', limit: '99' }, user: null }, res);
    expect(recommendMock).toHaveBeenCalledWith(expect.objectContaining({ limit: 6 }), expect.any(Object));
  });

  it('500 when recommend throws', async () => {
    recommendMock.mockRejectedValueOnce(new Error('boom'));
    const res = makeRes();
    await recommendationsHandler({ query: { slug: 'a' }, user: null }, res);
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it('passes user=null when req.user is missing or anonymous', async () => {
    recommendMock.mockResolvedValueOnce({ currentSlug: 'a', personalized: false, recommendations: [] });
    const res = makeRes();
    await recommendationsHandler({ query: { slug: 'a' }, user: { id: 'anonymous' } }, res);
    expect(recommendMock).toHaveBeenCalledWith(expect.objectContaining({ user: null }), expect.any(Object));
  });
});
```

- [ ] **Step 3.2: Run test to verify it fails**

```bash
npx vitest run test/unit/handlers/recommendations.test.js
```

Expected: FAIL — handler module not found.

- [ ] **Step 3.3: Implement handler**

```js
// srv/handlers/recommendations.js
import cds from '@sap/cds';
import { recommend } from '../lib/recommend.js';
import { computeCoCompletions } from '../lib/co-completion.js';
import { getUserProgress } from '../lib/user-progress.js';
import { getCentroid } from '../lib/tutorial-centroid.js';

const LOG = cds.log('recommend');

async function loadAllTutorials() {
  const { Tutorials, ContentManifest } = cds.entities('com.sap.developers.ims');
  const tutorials = await SELECT.from(Tutorials)
    .columns('ID', 'slug', 'title', 'primaryTag', 'time')
    .where(`status = 'ACTIVE' or status is null`);
  // Published = has an ACTIVE manifest entry for the slug.
  let publishedSlugs = new Set();
  try {
    const rows = await SELECT.from(ContentManifest)
      .columns('slug')
      .where({ status: 'ACTIVE' });
    publishedSlugs = new Set(rows.map(r => r.slug));
  } catch (err) {
    LOG.warn('publishedSlugs lookup failed; treating all tutorials as published', err.message);
  }
  return tutorials
    .filter(t => !!t.slug)
    .map(t => ({ ...t, published: publishedSlugs.size === 0 ? true : publishedSlugs.has(t.slug) }));
}

async function loadStepVectors(tutorialId) {
  const db = cds.db;
  const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
  if (isHana) {
    const sql = `
      SELECT "EMBEDDING"
      FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALEMBEDDING"
      WHERE "TUTORIAL_ID" = ?`;
    const rows = await db.run(sql, [tutorialId]);
    return rows.map(r => bufToFloat32(r.EMBEDDING ?? r.embedding)).filter(Boolean);
  }
  const { TutorialEmbedding } = cds.entities('com.sap.developers.ims');
  const rows = await SELECT.from(TutorialEmbedding).columns('embedding').where({ tutorial_ID: tutorialId });
  return rows.map(r => bufToFloat32(r.embedding)).filter(Boolean);
}

function bufToFloat32(blob) {
  if (!blob) return null;
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  if (buf.byteLength % 4 !== 0) return null;
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

const DEPS = {
  loadAllTutorials,
  loadCentroid: (id) => getCentroid(id, loadStepVectors),
  loadCoCompletions: () => computeCoCompletions().catch(err => { LOG.warn('co-completion failed', err.message); return {}; }),
  loadUserProgress: (user) => user ? getUserProgress(user) : Promise.resolve({ completedSlugs: [] })
};

export async function recommendationsHandler(req, res) {
  const start = Date.now();
  try {
    const slug = req.query?.slug;
    if (!slug || typeof slug !== 'string') {
      return res.status(400).json({ error: 'slug query parameter is required' });
    }
    const limitRaw = parseInt(req.query?.limit, 10);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(6, limitRaw)) : 3;

    const user = (req.user && req.user.id && req.user.id !== 'anonymous') ? req.user : null;

    const result = await recommend({ currentSlug: slug, user, limit }, DEPS);
    if (result.reason === 'unknown_slug') {
      return res.status(404).json({ error: 'unknown slug', currentSlug: slug });
    }
    LOG.info(`slug=${slug} user=${user ? 'auth' : 'anon'} personalized=${result.personalized} count=${result.recommendations.length} durationMs=${Date.now() - start}`);
    res.json(result);
  } catch (err) {
    LOG.error('recommendations handler failed', err.message);
    res.status(500).json({ error: 'recommendations failed' });
  }
}
```

- [ ] **Step 3.4: Run test to verify it passes**

```bash
npx vitest run test/unit/handlers/recommendations.test.js
```

Expected: PASS, all 6 tests green.

- [ ] **Step 3.5: Wire handler in server.js**

In `srv/server.js`, find the `import { coCompletionsHandler } from './lib/co-completion.js';` line near the top and add immediately below:

```js
import { recommendationsHandler } from './handlers/recommendations.js';
```

Find `app.get('/api/qrcode', qrcodeHandler);` (around line 101) and add immediately below:

```js
  app.get('/api/recommendations', recommendationsHandler);
```

- [ ] **Step 3.6: Sanity-check CAP boots**

```bash
# Start CAP in background, hit endpoint, kill
npx cds-serve --in-memory &
CAP_PID=$!
sleep 5
curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:4004/api/recommendations"
kill $CAP_PID 2>/dev/null || true
```

Expected: `400` (missing slug). If `404`, the route isn't registered — re-check the `app.get(...)` call in `srv/server.js`.

- [ ] **Step 3.7: Commit**

```bash
git add srv/handlers/recommendations.js srv/server.js test/unit/handlers/recommendations.test.js
git commit -m "feat(recommend): add /api/recommendations endpoint"
```

---

## Task 4: Hybrid HANA test

Validates the raw-SQL embedding loader against real HANA. Read-only; no writes; gated on `cf login` (existing hybrid suite convention).

**Files:**
- Create: `test/hybrid/recommend-hana.test.js`

- [ ] **Step 4.1: Write the test**

```js
// test/hybrid/recommend-hana.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
import { getCentroid, __resetForTest } from '../../srv/lib/tutorial-centroid.js';

let db;

beforeAll(async () => {
  await cds.connect.to('db');
  db = cds.db;
  __resetForTest();
});

async function loadStepVectors(tutorialId) {
  const sql = `SELECT "EMBEDDING" FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALEMBEDDING" WHERE "TUTORIAL_ID" = ?`;
  const rows = await db.run(sql, [tutorialId]);
  return rows.map(r => {
    const blob = r.EMBEDDING ?? r.embedding;
    if (!blob) return null;
    const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
    return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  }).filter(Boolean);
}

describe('centroid against real HANA', () => {
  it('produces a non-null centroid for at least one seeded tutorial', async () => {
    const { Tutorials } = cds.entities('com.sap.developers.ims');
    const sample = await SELECT.from(Tutorials).columns('ID', 'slug').limit(20);
    let found = 0;
    for (const t of sample) {
      const c = await getCentroid(t.ID, loadStepVectors);
      if (c && c.length > 0) found += 1;
    }
    expect(found).toBeGreaterThan(0);
  }, 30_000);

  it('cosine math matches HANA COSINE_SIMILARITY within 1e-4', async () => {
    const { Tutorials } = cds.entities('com.sap.developers.ims');
    const [a, b] = await SELECT.from(Tutorials).columns('ID').limit(2);
    if (!a || !b) return; // Empty DB — skip; no assertion is fine for sanity.
    const va = await getCentroid(a.ID, loadStepVectors);
    const vb = await getCentroid(b.ID, loadStepVectors);
    if (!va || !vb) return;

    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < va.length; i++) { dot += va[i]*vb[i]; na += va[i]*va[i]; nb += vb[i]*vb[i]; }
    const jsCos = dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);

    const sql = `SELECT COSINE_SIMILARITY(TO_REAL_VECTOR(?), TO_REAL_VECTOR(?)) AS "score" FROM "DUMMY"`;
    const [row] = await db.run(sql, [JSON.stringify(Array.from(va)), JSON.stringify(Array.from(vb))]);
    const hanaCos = row.SCORE ?? row.score;

    expect(Math.abs(jsCos - hanaCos)).toBeLessThan(1e-4);
  }, 30_000);
});
```

- [ ] **Step 4.2: Run hybrid test**

```bash
# Requires `cf login` to DEV space already done
npm run test:hybrid -- test/hybrid/recommend-hana.test.js
```

Expected: PASS. If the DB has zero embeddings yet, the second test silently passes — that's fine for the smoke validation.

- [ ] **Step 4.3: Commit**

```bash
git add test/hybrid/recommend-hana.test.js
git commit -m "test(recommend): add hybrid HANA centroid + cosine parity test"
```

---

## Task 5: Hugo partial refactor

Two cosmetic changes that unblock the JS island:
1. Extract the rail card markup into `next-steps-card.html` so server and client use one source.
2. Add `data-recommend-slug` to the rail wrapper and embed an inline `<template>` for client-side cloning.

The curated `Params.next` block above the rail is **untouched**.

**Files:**
- Create: `hugo/layouts/partials/next-steps-card.html`
- Modify: `hugo/layouts/partials/next-steps.html`

- [ ] **Step 5.1: Create the card partial**

Create `hugo/layouts/partials/next-steps-card.html`:

```hugo
{{- $slug := .slug -}}
{{- $title := .title -}}
{{- $time := .time -}}
{{- $page := site.GetPage (printf "/tutorials/%s" $slug) -}}
{{- if and (not $title) $page -}}{{- $title = $page.Title -}}{{- end -}}
{{- if and (not $time) $page -}}{{- $time = $page.Params.time -}}{{- end -}}
<a href="/tutorials/{{ $slug }}" class="next-steps-rail-card" data-recommend-card>
  <span class="next-steps-label">TUTORIAL</span>
  <span class="next-steps-title" data-recommend-title>{{ $title | default ($slug | humanize | title) }}</span>
  {{- with $time }}
  <span class="next-steps-meta" data-recommend-meta>
    <span class="next-steps-time-icon">&#9201;</span> {{ . }} min.
  </span>
  {{- end }}
</a>
```

- [ ] **Step 5.2: Refactor `next-steps.html`**

Replace lines 31–52 in `hugo/layouts/partials/next-steps.html` (the existing `{{- if $hasRecs }}` block) with:

```hugo
  {{- if $hasRecs }}
  <div class="next-steps-rail" data-recommend-slug="{{ .Params.slug }}">
    <h4 class="next-steps-rail-heading">Related Tutorials</h4>
    <div class="next-steps-grid" data-recommend-target>
      {{- range .Params.recommendations -}}
      {{- $recSlug := . -}}
      {{- $recPage := site.GetPage (printf "/tutorials/%s" $recSlug) -}}
      {{- if $recPage -}}
      {{ partial "next-steps-card.html" (dict "slug" $recSlug "title" $recPage.Title "time" $recPage.Params.time) }}
      {{- end -}}
      {{- end }}
    </div>
    <template data-recommend-template>
      {{ partial "next-steps-card.html" (dict "slug" "__placeholder__" "title" "__placeholder__") }}
    </template>
  </div>
  {{- end }}
```

- [ ] **Step 5.3: Build Hugo and verify rail still renders**

```bash
npm run fetch-tutorials
npm run dev &
HUGO_PID=$!
sleep 8
curl -s "http://localhost:1313/tutorials/abap-cloud-ui-from-interface/" | grep -o 'data-recommend-slug="[^"]*"' | head -1
curl -s "http://localhost:1313/tutorials/abap-cloud-ui-from-interface/" | grep -c 'next-steps-rail-card'
kill $HUGO_PID 2>/dev/null || true
```

Expected: First grep prints `data-recommend-slug="abap-cloud-ui-from-interface"`. Second grep prints a count > 0 (server-rendered cards still present).

- [ ] **Step 5.4: Run existing smoke locally is not possible without deploy — defer to Task 7. Just commit.**

```bash
git add hugo/layouts/partials/next-steps.html hugo/layouts/partials/next-steps-card.html
git commit -m "refactor(hugo): extract next-steps card partial; add data-recommend-slug"
```

---

## Task 6: JS island

Self-bootstrapping TS module. Lazy-loaded only when the wrapper attribute is present.

**Files:**
- Create: `hugo/assets/js/recommend.ts`
- Modify: `hugo/assets/js/ui5-bootstrap.ts` (add side-effect import)

- [ ] **Step 6.1: Create the island**

```ts
// hugo/assets/js/recommend.ts
// Personalized "What's next" — fetches /api/recommendations and swaps the
// server-rendered static rail cards on success. Silent no-op on any failure.
//
// Gated on [data-recommend-slug] presence — safe import on every page.

interface RecCard {
  slug: string;
  title: string;
  primaryTag?: string;
  time?: number;
}

interface RecResponse {
  currentSlug: string;
  personalized: boolean;
  recommendations: RecCard[];
  reason?: string;
}

function init(): void {
  const wrapper = document.querySelector<HTMLElement>('[data-recommend-slug]');
  if (!wrapper) return;
  const target = wrapper.querySelector<HTMLElement>('[data-recommend-target]');
  const template = wrapper.querySelector<HTMLTemplateElement>('[data-recommend-template]');
  const slug = wrapper.dataset.recommendSlug;
  if (!target || !template || !slug) return;

  const ac = new AbortController();
  window.addEventListener('pagehide', () => ac.abort(), { once: true });

  fetch(`/api/recommendations?slug=${encodeURIComponent(slug)}&limit=3`, {
    credentials: 'include',
    signal: ac.signal
  })
    .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
    .then((data: RecResponse) => {
      if (!data.recommendations || data.recommendations.length === 0) return; // keep static fallback
      const frag = document.createDocumentFragment();
      for (const rec of data.recommendations) {
        const node = template.content.firstElementChild?.cloneNode(true) as HTMLAnchorElement | null;
        if (!node) continue;
        node.setAttribute('href', `/tutorials/${rec.slug}`);
        const titleEl = node.querySelector('[data-recommend-title]');
        if (titleEl) titleEl.textContent = rec.title;
        const metaEl = node.querySelector('[data-recommend-meta]');
        if (metaEl) {
          if (rec.time) {
            metaEl.innerHTML = `<span class="next-steps-time-icon">&#9201;</span> ${rec.time} min.`;
          } else {
            metaEl.remove();
          }
        }
        frag.appendChild(node);
      }
      target.replaceChildren(frag);
    })
    .catch(() => { /* silent: server-rendered fallback stays */ });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
```

- [ ] **Step 6.2: Wire into bootstrap**

In `hugo/assets/js/ui5-bootstrap.ts`, find the line `import "./mission-side-nav";` and add immediately below:

```ts
// Personalized "What's next" rail. Self-bootstraps; safe no-op when [data-recommend-slug] is missing.
import "./recommend";
```

- [ ] **Step 6.3: Build Hugo and confirm bundle includes recommend module**

```bash
npm run dev &
HUGO_PID=$!
sleep 8
# The compiled bootstrap bundle name differs; just check the rendered page references the bundle.
curl -s "http://localhost:1313/tutorials/abap-cloud-ui-from-interface/" | grep -o 'src="/js/[^"]*ui5-bootstrap[^"]*"' | head -1
kill $HUGO_PID 2>/dev/null || true
```

Expected: a `src="/js/...ui5-bootstrap...js"` reference is printed. The compiled bundle now includes `recommend.ts` (verified at deploy via the smoke test in Task 7).

- [ ] **Step 6.4: Commit**

```bash
git add hugo/assets/js/recommend.ts hugo/assets/js/ui5-bootstrap.ts
git commit -m "feat(hugo): add recommend.ts island for personalized rail hydration"
```

---

## Task 7: Smoke test

Runs against deployed environment. Validates endpoint shape AND that the Hugo wrapper attribute landed.

**Files:**
- Create: `test/smoke/recommendations.test.js`

- [ ] **Step 7.1: Write the smoke test**

```js
// test/smoke/recommendations.test.js
import { describe, it, expect } from 'vitest';
import { BASE_URL, fetchWithRetry } from './smoke.config.js';

const SRV_URL = process.env.SMOKE_SRV_URL || BASE_URL;
const KNOWN_SLUG = 'abap-cloud-ui-from-interface';

describe('Personalized recommendations endpoint', () => {
  it('400 on missing slug', async () => {
    const res = await fetchWithRetry(`${SRV_URL}/api/recommendations`);
    expect(res.status).toBe(400);
  });

  it('404 on unknown slug', async () => {
    const res = await fetchWithRetry(`${SRV_URL}/api/recommendations?slug=__bogus__`);
    expect(res.status).toBe(404);
  });

  it('200 with valid shape on known slug', async () => {
    const res = await fetchWithRetry(`${SRV_URL}/api/recommendations?slug=${KNOWN_SLUG}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      currentSlug: KNOWN_SLUG,
      personalized: expect.any(Boolean),
      recommendations: expect.any(Array)
    });
    expect(body.recommendations.length).toBeLessThanOrEqual(3);
    for (const rec of body.recommendations) {
      expect(rec).toMatchObject({ slug: expect.any(String), title: expect.any(String) });
    }
  });
});

describe('Personalized rail wrapper in Hugo HTML', () => {
  it('renders data-recommend-slug attribute on a known tutorial page', async () => {
    const res = await fetchWithRetry(`${BASE_URL}/tutorials/${KNOWN_SLUG}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(new RegExp(`data-recommend-slug=["']${KNOWN_SLUG}["']`));
    expect(html).toContain('data-recommend-target');
  });
});
```

- [ ] **Step 7.2: Don't run the smoke test yet — it requires deploy**

Smoke tests run in CI after `mbt build && cf deploy`. They will execute automatically post-deploy via `.github/workflows/deploy.yml`. Locally, you can run them after the next deploy with `npm run test:smoke` provided `SMOKE_BASE_URL` and `SMOKE_SRV_URL` are set.

- [ ] **Step 7.3: Verify the existing smoke test isn't broken**

The existing `test/smoke/next-steps-recommendations.test.js` asserts server-rendered `Related Tutorials` heading + `next-steps-rail-card` class. After Task 5, those still render server-side. Confirm by reading the rendered HTML from Step 5.3: `next-steps-rail-card` should appear at least once.

- [ ] **Step 7.4: Commit**

```bash
git add test/smoke/recommendations.test.js
git commit -m "test(smoke): add personalized recommendations endpoint + Hugo wrapper checks"
```

---

## Task 8: Final verification + PR

- [ ] **Step 8.1: Run full unit suite**

```bash
npm test
```

Expected: ≥3 new test files green; baseline failure count from Step 0b unchanged.

- [ ] **Step 8.2: Lint**

```bash
npx eslint srv/lib/recommend.js srv/lib/tutorial-centroid.js srv/handlers/recommendations.js
```

Expected: clean.

- [ ] **Step 8.3: Push and open PR**

Per `feedback_pr_over_direct_merge` — open a PR, don't merge directly.

```bash
git push -u origin feature/personalized-recommendations
gh pr create --title "feat: personalized 'What's next' recommendations" --body "$(cat <<'EOF'
## Summary
- Replaces build-time tag/co-completion blender for the "Related Tutorials" rail with a runtime, per-user ranking
- Reuses existing per-step embeddings, co-completion aggregator, and user-progress lookup — no schema change
- Anonymous users get a similarity-based upgrade; authed users additionally skip already-completed tutorials
- Graceful degradation: every failure path lands on the server-rendered static rail (zero-risk swap)

## Test plan
- [ ] `npm test` (unit; centroid + recommender + handler)
- [ ] `npm run test:hybrid -- test/hybrid/recommend-hana.test.js` after `cf login`
- [ ] `npm run test:smoke` after deploy (endpoint + Hugo wrapper checks)
- [ ] Manual: load a known tutorial in DEV, verify rail cards refresh from `/api/recommendations`
- [ ] Manual: hit `/api/recommendations` without slug → 400; bogus slug → 404; happy path → 200
EOF
)"
```

- [ ] **Step 8.4: Hand off**

After PR is created, surface the PR URL to Tom for review. Once merged, consider:
- Save a project memory entry under `project_personalized_recommendations_shipped.md` and add to `MEMORY.md`
- Use `superpowers:finishing-a-development-branch` to clean up the worktree

---

## Risks & rollback

| Risk | Mitigation |
|---|---|
| Endpoint 500s in prod | Static rail is server-rendered; client `catch()` keeps it visible |
| Bundle bloat from `recommend.ts` | Module is ~80 lines, gated DOM check, no UI5 imports |
| Centroid memory growth | LRU cap 256; resets on process restart |
| Co-completion aggregation cost | Reused 1h-cached `computeCoCompletions()` |

**Rollback:** Revert the `data-recommend-slug` attribute in `next-steps.html`. JS island becomes a no-op (selector returns null). Backend endpoint can stay live with no callers.
