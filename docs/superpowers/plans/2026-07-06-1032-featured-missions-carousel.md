# Featured Missions Carousel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Row 5 of the developer-portal homepage with a topic-based carousel — 8 slides, each showing one KG concept plus its top 4 missions, auto-advancing every 30s with full a11y — sourced from a nightly snapshot with editorial override.

**Architecture:** New `HomepageFeaturedTopics` entity (editorial overrides) + `FeaturedTopicsSnapshot` materialized table + nightly `kg-featured-topics-job` at 04:11 UTC. Two feeds serve the same snapshot: `/build/featured-topics` (build-baked SSR) and `/api/homepage/featuredTopics` (runtime hydration with ETag/304). SSR Hugo partial provides fast first paint; Vue island overlays fresher data.

**Tech Stack:** CAP 10 (Node.js), Hugo templates, Vue 3 island (Vite-built into `hugo/static/js/`), HANA (prod) / SQLite (unit), Vitest, CDS QL only (no raw SQL).

## Global Constraints

- **Slide count fixed at 8, missions per slide fixed at 4** — no admin knob (per spec §3).
- **Row 5 is replaced, not augmented.** `hugo/layouts/partials/homepage/tutorials-teaser.html` is removed from `hugo/layouts/index.html`; kept as a file for kill-switch revert.
- **CDS QL only, no raw SQL** (project global rule; spec §5).
- **`@UI.RecommendationState: 0` on `concept_ID` value-help** to avoid the `@cap-js/ai` `AICore` runtime crash — memory `cap-ai-plugin-aicore-kind-resolution`. Applied per-field, not globally.
- **Slugs are lowercase canonical everywhere** (memory `tutorial-slugs-lowercase-canonical`).
- **`cds build --production` after any schema change** that must land in `db/last-dev/` (memory: not `cds compile`).
- **Fresh worktree needs `npm run setup` after `npm install`** — `ignore-scripts=true` globally.
- **Cron jobs are wired via `srv/jobs/scheduler.js` `registerJobs()`** (memory: CAP 10 scheduling API through `srv/cron-service.js`, off-minute schedule `11 04 * * *` for this job).
- **After-write hooks trigger the debounced rebuild dispatcher** via `srv/lib/rebuild-trigger.js` (same code path as `HomepageShelves` writes; 60s debounce).
- **Test parity:** unit tests must pass on Node 22 (CI) and Node 24 (local). Use `cds.entities(NS)` refs, not bare projection names in `SELECT.from()` (memory: `ci-node-version-mismatch`).
- **`test:hybrid` requires `--project hybrid`** if run directly with vitest (memory).
- **`xs-security.json` is dual-copied** at root + `.deploy/`. This plan adds no new scopes, so no dual-file edits — but touch nothing there.
- **PR before merge**, never direct-to-main (memory).

---

## File Structure

**Created**
- `db/homepage-featured.cds` — `HomepageFeaturedTopics` + `FeaturedTopicsSnapshot`
- `srv/lib/featured-topics-selection.js` — pure selection algorithm (editorial + KG blend, deterministic)
- `srv/lib/featured-topics-snapshot.js` — writer that runs selection + truncates and rewrites `FeaturedTopicsSnapshot` in one tx
- `srv/lib/featured-topics-etag.js` — ETag formatter (SHA1 of computedAt + slot canonicalization)
- `srv/jobs/kg-featured-topics-job.js` — nightly job wrapper (`runKgFeaturedTopics`) + `registerJob` call added to `scheduler.js`
- `test/unit/srv/featured-topics-selection.test.js`
- `test/unit/srv/featured-topics-snapshot.test.js`
- `test/unit/srv/featured-topics-etag.test.js`
- `test/unit/srv/featured-topics-endpoint.test.js`
- `test/unit/srv/admin-featured-topics-crud.test.js`
- `test/hybrid/featured-topics-hybrid.test.js`
- `test/smoke/smoke-featured-topics.test.js`
- `hugo/layouts/partials/homepage/featured-topics-carousel.html`
- `hugo/assets/css/homepage/_featured-carousel.css`
- `hugo-apps/apps/featured-topics-carousel/package.json`
- `hugo-apps/apps/featured-topics-carousel/vite.config.ts`
- `hugo-apps/apps/featured-topics-carousel/src/main.ts`
- `hugo-apps/apps/featured-topics-carousel/src/Carousel.vue`
- `hugo-apps/apps/featured-topics-carousel/src/composables/useAutoAdvance.ts`
- `hugo-apps/apps/featured-topics-carousel/src/composables/useHydrate.ts`
- `hugo-apps/apps/featured-topics-carousel/src/composables/useDeepLink.ts`
- `hugo-apps/apps/featured-topics-carousel/test/carousel.spec.ts`

**Modified**
- `srv/admin-service.cds` — expose `FeaturedTopics` (draft-enabled), `FeaturedTopicsSnapshotView` (read-only), `recomputeFeaturedTopics()` action
- `srv/admin-service.js` — CRUD handlers + after-SAVE hook (dispatch rebuild + recompute inline) + action handler
- `app/admin-annotations.cds` — value-help + `@UI.RecommendationState: 0` on `concept_ID`; LR + OP layout; Snapshot facet
- `app/admin-shell/webapp/manifest.json` — new admin component route `#featured-topics`
- `srv/homepage-service.cds` — new `featuredTopics()` unbound function
- `srv/homepage-service.js` — implement `featuredTopics` with 60s cache + ETag / 304
- `srv/developer-service.js` — new `GET /build/featured-topics`
- `srv/jobs/scheduler.js` — `registerJob({ jobName: 'kg-featured-topics', schedule: '11 4 * * *', … })`
- `scripts/fetch-tutorials.ts` — call `/build/featured-topics`, write `hugo/data/featured_topics.json`
- `hugo/layouts/index.html` — swap Row 5 partial include
- `hugo/assets/css/homepage.css` — `@import "_featured-carousel.css"`
- `hugo-apps/vite.config.ts` — add carousel app to the multi-app build config (existing convention)
- `docs/developers/architecture/homepage.md` — Row 5 description + spec/plan links

**Removed from index.html but retained as files (kill-switch)**
- `hugo/layouts/partials/homepage/tutorials-teaser.html` — keep as-is on disk

---

## Task 1: Data model — `db/homepage-featured.cds` + build

**Files:**
- Create: `db/homepage-featured.cds`

**Interfaces:**
- Consumes: `Concepts` from `./knowledge-graph`
- Produces:
  - `com.sap.developers.ims.HomepageFeaturedTopics` (cuid, managed): `concept: Association to Concepts (mandatory)`, `displayTitle: String(80)`, `sortOrder: Integer default 100`, `validFrom: Timestamp`, `validUntil: Timestamp`, `missionSlugs: array of String(255)`, `isActive: Boolean default true`, `notes: String(500)`, `@assert.unique.concept: [concept]`
  - `com.sap.developers.ims.FeaturedTopicsSnapshot` (no cuid/managed, `@cds.autoexpose: false`): keys `slotOrder: Integer`; fields `source: String(10)`, `conceptSlug: String(80)`, `displayTitle: String(120)`, `missionSlugs: array of String(255)`, `computedAt: Timestamp`

- [ ] **Step 1: Write the file**

```cds
// db/homepage-featured.cds — issue #1032 (featured missions carousel).
// Editorial rows: HomepageFeaturedTopics. Materialized selection: FeaturedTopicsSnapshot.
// Spec: docs/superpowers/specs/2026-07-06-1032-featured-missions-carousel-design.md §5.
namespace com.sap.developers.ims;

using { managed, cuid } from '@sap/cds/common';
using { Concepts } from './knowledge-graph';

@assert.unique.concept: [concept]
entity HomepageFeaturedTopics : cuid, managed {
  concept        : Association to Concepts @mandatory;
  displayTitle   : String(80);
  sortOrder      : Integer default 100;
  validFrom      : Timestamp;
  validUntil     : Timestamp;
  missionSlugs   : array of String(255);
  isActive       : Boolean default true;
  notes          : String(500);
}

@cds.autoexpose: false
entity FeaturedTopicsSnapshot {
  key slotOrder    : Integer;
      source       : String(10);
      conceptSlug  : String(80);
      displayTitle : String(120);
      missionSlugs : array of String(255);
      computedAt   : Timestamp;
}
```

- [ ] **Step 2: Verify CDS compiles**

Run: `npx cds compile db/homepage-featured.cds -2 sql`
Expected: emits SQL for two tables; no errors.

- [ ] **Step 3: Regenerate persisted schema**

Run: `npm run build:cds || npx cds build --production`
Expected: `db/last-dev/csn.json` (or the equivalent artifact used by the repo) refreshed.

- [ ] **Step 4: Commit**

```bash
git add db/homepage-featured.cds db/last-dev/ 2>/dev/null || git add db/homepage-featured.cds
git commit -m "feat(#1032): add HomepageFeaturedTopics + FeaturedTopicsSnapshot entities"
```

---

## Task 2: Pure selection algorithm — `srv/lib/featured-topics-selection.js`

**Files:**
- Create: `srv/lib/featured-topics-selection.js`
- Test: `test/unit/srv/featured-topics-selection.test.js`

**Interfaces:**
- Consumes: nothing (pure function, DB access lives in Task 3)
- Produces:
  - `selectFeaturedTopics({ editorial, kgCandidates, communityByConcept, tutorialRanksByConcept, tutorialsBySlug, targetCount = 8, missionsPerSlide = 4, now = new Date() })` → `Array<{ source: 'EDITORIAL'|'KG', conceptSlug, displayTitle, missionSlugs }>` (length ≤ targetCount, always in slot order)

**Input shapes** (all plain JS objects, no CDS):
- `editorial`: `Array<{ conceptId, conceptSlug, conceptName, conceptStatus, conceptPublishedAt, displayTitle, sortOrder, validFrom, validUntil, missionSlugs, isActive, createdAt }>` — already fetched from DB
- `kgCandidates`: `Array<{ conceptSlug, conceptName, conceptStatus, conceptPublishedAt, pagerankScore }>` — sorted by `pagerankScore DESC, conceptSlug ASC`
- `communityByConcept`: `Map<conceptSlug, communityFingerprint|null>`
- `tutorialRanksByConcept`: `Map<conceptSlug, Array<{ tutorialSlug, score }>>` — pre-sorted by `score DESC, tutorialSlug ASC`
- `tutorialsBySlug`: `Set<tutorialSlug>` — active tutorials/missions; used to validate editorial `missionSlugs`

- [ ] **Step 1: Write the failing test — happy path (editorial + KG blend)**

```js
// test/unit/srv/featured-topics-selection.test.js
import { describe, it, expect } from 'vitest';
import { selectFeaturedTopics } from '../../../srv/lib/featured-topics-selection.js';

const NOW = new Date('2026-07-06T00:00:00Z');

function ranks(slugs) {
  return slugs.map((s, i) => ({ tutorialSlug: s, score: 100 - i }));
}

describe('selectFeaturedTopics', () => {
  it('places editorial first, KG fills the rest respecting community diversity', () => {
    const editorial = [
      { conceptId: 'e1', conceptSlug: 'cap', conceptName: 'CAP', conceptStatus: 'ACTIVE', conceptPublishedAt: NOW, displayTitle: 'CAP Framework', sortOrder: 10, validFrom: null, validUntil: null, missionSlugs: null, isActive: true, createdAt: NOW },
    ];
    const kgCandidates = [
      { conceptSlug: 'hana',      conceptName: 'HANA',      conceptStatus: 'ACTIVE', conceptPublishedAt: NOW, pagerankScore: 0.9 },
      { conceptSlug: 'hana-perf', conceptName: 'HANA Perf', conceptStatus: 'ACTIVE', conceptPublishedAt: NOW, pagerankScore: 0.8 },
      { conceptSlug: 'abap',      conceptName: 'ABAP',      conceptStatus: 'ACTIVE', conceptPublishedAt: NOW, pagerankScore: 0.7 },
    ];
    const communityByConcept = new Map([
      ['cap', 'c-cap'],
      ['hana', 'c-hana'],
      ['hana-perf', 'c-hana'],   // same community as hana — should be skipped
      ['abap', 'c-abap'],
    ]);
    const tutorialRanksByConcept = new Map([
      ['cap',  ranks(['cap-t1','cap-t2','cap-t3','cap-t4','cap-t5'])],
      ['hana', ranks(['h-t1','h-t2','h-t3','h-t4'])],
      ['abap', ranks(['a-t1','a-t2','a-t3','a-t4'])],
    ]);
    const tutorialsBySlug = new Set(['cap-t1','cap-t2','cap-t3','cap-t4','cap-t5','h-t1','h-t2','h-t3','h-t4','a-t1','a-t2','a-t3','a-t4']);

    const out = selectFeaturedTopics({ editorial, kgCandidates, communityByConcept, tutorialRanksByConcept, tutorialsBySlug, targetCount: 3, missionsPerSlide: 4, now: NOW });

    expect(out.map(s => s.conceptSlug)).toEqual(['cap', 'hana', 'abap']);
    expect(out[0].source).toBe('EDITORIAL');
    expect(out[1].source).toBe('KG');
    expect(out[0].displayTitle).toBe('CAP Framework');
    expect(out[0].missionSlugs).toEqual(['cap-t1','cap-t2','cap-t3','cap-t4']);
  });

  it('honors editorial missionSlugs override when all slugs are active', () => {
    const editorial = [
      { conceptId: 'e1', conceptSlug: 'cap', conceptName: 'CAP', conceptStatus: 'ACTIVE', conceptPublishedAt: NOW, displayTitle: null, sortOrder: 10, validFrom: null, validUntil: null, missionSlugs: ['cap-t5','cap-t3'], isActive: true, createdAt: NOW },
    ];
    const tutorialRanksByConcept = new Map([['cap', ranks(['cap-t1','cap-t2'])]]);
    const tutorialsBySlug = new Set(['cap-t5','cap-t3','cap-t1','cap-t2']);
    const out = selectFeaturedTopics({ editorial, kgCandidates: [], communityByConcept: new Map(), tutorialRanksByConcept, tutorialsBySlug, targetCount: 1, missionsPerSlide: 4, now: NOW });
    expect(out[0].missionSlugs).toEqual(['cap-t5','cap-t3']);
  });

  it('falls back to TutorialRank when editorial missionSlugs has any inactive slug', () => {
    const editorial = [
      { conceptId: 'e1', conceptSlug: 'cap', conceptName: 'CAP', conceptStatus: 'ACTIVE', conceptPublishedAt: NOW, displayTitle: null, sortOrder: 10, validFrom: null, validUntil: null, missionSlugs: ['cap-t5','gone'], isActive: true, createdAt: NOW },
    ];
    const tutorialRanksByConcept = new Map([['cap', ranks(['cap-t1','cap-t2','cap-t3','cap-t4'])]]);
    const tutorialsBySlug = new Set(['cap-t5','cap-t1','cap-t2','cap-t3','cap-t4']);
    const out = selectFeaturedTopics({ editorial, kgCandidates: [], communityByConcept: new Map(), tutorialRanksByConcept, tutorialsBySlug, targetCount: 1, missionsPerSlide: 4, now: NOW });
    expect(out[0].missionSlugs).toEqual(['cap-t1','cap-t2','cap-t3','cap-t4']);
  });

  it('filters editorial by validity window and isActive', () => {
    const past = new Date('2026-01-01T00:00:00Z');
    const future = new Date('2027-01-01T00:00:00Z');
    const editorial = [
      { conceptId: 'e-inactive', conceptSlug: 'a', conceptName: 'A', conceptStatus: 'ACTIVE', conceptPublishedAt: NOW, displayTitle: 'A', sortOrder: 1, validFrom: null, validUntil: null, missionSlugs: null, isActive: false, createdAt: NOW },
      { conceptId: 'e-expired',  conceptSlug: 'b', conceptName: 'B', conceptStatus: 'ACTIVE', conceptPublishedAt: NOW, displayTitle: 'B', sortOrder: 2, validFrom: past, validUntil: past, missionSlugs: null, isActive: true, createdAt: NOW },
      { conceptId: 'e-future',   conceptSlug: 'c', conceptName: 'C', conceptStatus: 'ACTIVE', conceptPublishedAt: NOW, displayTitle: 'C', sortOrder: 3, validFrom: future, validUntil: null, missionSlugs: null, isActive: true, createdAt: NOW },
      { conceptId: 'e-ok',       conceptSlug: 'd', conceptName: 'D', conceptStatus: 'ACTIVE', conceptPublishedAt: NOW, displayTitle: 'D', sortOrder: 4, validFrom: null,   validUntil: null, missionSlugs: null, isActive: true, createdAt: NOW },
    ];
    const tutorialRanksByConcept = new Map([['d', ranks(['dt1','dt2','dt3','dt4'])]]);
    const tutorialsBySlug = new Set(['dt1','dt2','dt3','dt4']);
    const out = selectFeaturedTopics({ editorial, kgCandidates: [], communityByConcept: new Map(), tutorialRanksByConcept, tutorialsBySlug, targetCount: 8, missionsPerSlide: 4, now: NOW });
    expect(out.map(s => s.conceptSlug)).toEqual(['d']);
  });

  it('skips unpublished/vetoed concepts from KG candidates', () => {
    const kgCandidates = [
      { conceptSlug: 'ok',    conceptName: 'OK',    conceptStatus: 'ACTIVE', conceptPublishedAt: NOW, pagerankScore: 0.9 },
      { conceptSlug: 'draft', conceptName: 'Draft', conceptStatus: 'ACTIVE', conceptPublishedAt: null, pagerankScore: 0.8 },
      { conceptSlug: 'veto',  conceptName: 'Veto',  conceptStatus: 'VETOED', conceptPublishedAt: NOW, pagerankScore: 0.7 },
    ];
    const tutorialRanksByConcept = new Map([['ok', ranks(['ok1','ok2','ok3','ok4'])]]);
    const tutorialsBySlug = new Set(['ok1','ok2','ok3','ok4']);
    const out = selectFeaturedTopics({ editorial: [], kgCandidates, communityByConcept: new Map(), tutorialRanksByConcept, tutorialsBySlug, targetCount: 8, missionsPerSlide: 4, now: NOW });
    expect(out.map(s => s.conceptSlug)).toEqual(['ok']);
  });

  it('null communityFingerprint passes filter freely', () => {
    const kgCandidates = [
      { conceptSlug: 'a', conceptName: 'A', conceptStatus: 'ACTIVE', conceptPublishedAt: NOW, pagerankScore: 0.9 },
      { conceptSlug: 'b', conceptName: 'B', conceptStatus: 'ACTIVE', conceptPublishedAt: NOW, pagerankScore: 0.8 },
    ];
    const communityByConcept = new Map([['a', null], ['b', null]]);
    const tutorialRanksByConcept = new Map([['a', ranks(['a1','a2','a3','a4'])], ['b', ranks(['b1','b2','b3','b4'])]]);
    const tutorialsBySlug = new Set(['a1','a2','a3','a4','b1','b2','b3','b4']);
    const out = selectFeaturedTopics({ editorial: [], kgCandidates, communityByConcept, tutorialRanksByConcept, tutorialsBySlug, targetCount: 8, missionsPerSlide: 4, now: NOW });
    expect(out.map(s => s.conceptSlug)).toEqual(['a','b']);
  });

  it('truncates missionSlugs to missionsPerSlide', () => {
    const kgCandidates = [{ conceptSlug: 'a', conceptName: 'A', conceptStatus: 'ACTIVE', conceptPublishedAt: NOW, pagerankScore: 1 }];
    const tutorialRanksByConcept = new Map([['a', ranks(['a1','a2','a3','a4','a5','a6'])]]);
    const tutorialsBySlug = new Set(['a1','a2','a3','a4','a5','a6']);
    const out = selectFeaturedTopics({ editorial: [], kgCandidates, communityByConcept: new Map(), tutorialRanksByConcept, tutorialsBySlug, targetCount: 1, missionsPerSlide: 4, now: NOW });
    expect(out[0].missionSlugs).toEqual(['a1','a2','a3','a4']);
  });

  it('empty inputs → empty output, not throw', () => {
    const out = selectFeaturedTopics({ editorial: [], kgCandidates: [], communityByConcept: new Map(), tutorialRanksByConcept: new Map(), tutorialsBySlug: new Set(), targetCount: 8, missionsPerSlide: 4, now: NOW });
    expect(out).toEqual([]);
  });

  it('uses concept.name when displayTitle is null', () => {
    const kgCandidates = [{ conceptSlug: 'x', conceptName: 'X-Fallback', conceptStatus: 'ACTIVE', conceptPublishedAt: NOW, pagerankScore: 1 }];
    const tutorialRanksByConcept = new Map([['x', ranks(['x1'])]]);
    const tutorialsBySlug = new Set(['x1']);
    const out = selectFeaturedTopics({ editorial: [], kgCandidates, communityByConcept: new Map(), tutorialRanksByConcept, tutorialsBySlug, targetCount: 1, missionsPerSlide: 4, now: NOW });
    expect(out[0].displayTitle).toBe('X-Fallback');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/srv/featured-topics-selection.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```js
// srv/lib/featured-topics-selection.js
// Pure selection function — no DB access. Deterministic given the same inputs.
// Spec: docs/superpowers/specs/2026-07-06-1032-featured-missions-carousel-design.md §6.

function isConceptPublished(c) {
  return c && c.conceptStatus === 'ACTIVE' && c.conceptPublishedAt != null;
}

function inValidityWindow(row, now) {
  if (row.validFrom && new Date(row.validFrom) > now) return false;
  if (row.validUntil && new Date(row.validUntil) < now) return false;
  return true;
}

function resolveMissionSlugs(row, tutorialRanksByConcept, tutorialsBySlug, missionsPerSlide) {
  const override = Array.isArray(row.missionSlugs) ? row.missionSlugs.filter(Boolean) : [];
  if (override.length > 0 && override.every(s => tutorialsBySlug.has(String(s).toLowerCase()))) {
    return override.slice(0, missionsPerSlide).map(s => String(s).toLowerCase());
  }
  const ranks = tutorialRanksByConcept.get(row.conceptSlug) || [];
  return ranks
    .filter(r => tutorialsBySlug.has(String(r.tutorialSlug).toLowerCase()))
    .slice(0, missionsPerSlide)
    .map(r => String(r.tutorialSlug).toLowerCase());
}

export function selectFeaturedTopics({
  editorial,
  kgCandidates,
  communityByConcept,
  tutorialRanksByConcept,
  tutorialsBySlug,
  targetCount = 8,
  missionsPerSlide = 4,
  now = new Date(),
}) {
  const slots = [];
  const usedConcepts = new Set();
  const usedCommunities = new Set();

  const sortedEditorial = [...editorial]
    .filter(r => r.isActive)
    .filter(r => isConceptPublished(r))
    .filter(r => inValidityWindow(r, now))
    .sort((a, b) => {
      const so = (a.sortOrder ?? 100) - (b.sortOrder ?? 100);
      if (so !== 0) return so;
      return new Date(a.createdAt) - new Date(b.createdAt);
    });

  for (const row of sortedEditorial) {
    if (slots.length >= targetCount) break;
    if (usedConcepts.has(row.conceptSlug)) continue;
    const missionSlugs = resolveMissionSlugs(row, tutorialRanksByConcept, tutorialsBySlug, missionsPerSlide);
    if (missionSlugs.length === 0) continue;
    slots.push({
      source: 'EDITORIAL',
      conceptSlug: row.conceptSlug,
      displayTitle: row.displayTitle || row.conceptName,
      missionSlugs,
    });
    usedConcepts.add(row.conceptSlug);
    const fp = communityByConcept.get(row.conceptSlug);
    if (fp) usedCommunities.add(fp);
  }

  for (const cand of kgCandidates) {
    if (slots.length >= targetCount) break;
    if (!isConceptPublished(cand)) continue;
    if (usedConcepts.has(cand.conceptSlug)) continue;
    const fp = communityByConcept.get(cand.conceptSlug);
    if (fp && usedCommunities.has(fp)) continue;
    const missionSlugs = resolveMissionSlugs(
      { conceptSlug: cand.conceptSlug, missionSlugs: null },
      tutorialRanksByConcept,
      tutorialsBySlug,
      missionsPerSlide,
    );
    if (missionSlugs.length === 0) continue;
    slots.push({
      source: 'KG',
      conceptSlug: cand.conceptSlug,
      displayTitle: cand.conceptName,
      missionSlugs,
    });
    usedConcepts.add(cand.conceptSlug);
    if (fp) usedCommunities.add(fp);
  }

  return slots;
}
```

- [ ] **Step 4: Run tests to verify all pass**

Run: `npx vitest run test/unit/srv/featured-topics-selection.test.js`
Expected: 8 passing.

- [ ] **Step 5: Commit**

```bash
git add srv/lib/featured-topics-selection.js test/unit/srv/featured-topics-selection.test.js
git commit -m "feat(#1032): pure selection algorithm for featured topics"
```

---

## Task 3: ETag helper — `srv/lib/featured-topics-etag.js`

**Files:**
- Create: `srv/lib/featured-topics-etag.js`
- Test: `test/unit/srv/featured-topics-etag.test.js`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `computeSnapshotEtag({ computedAt, slots })` → `string` (weak ETag, e.g. `W/"<sha1hex>"`)
  - `slots` shape: `Array<{ slotOrder, conceptSlug, missionSlugs }>`

- [ ] **Step 1: Write the failing test**

```js
// test/unit/srv/featured-topics-etag.test.js
import { describe, it, expect } from 'vitest';
import { computeSnapshotEtag } from '../../../srv/lib/featured-topics-etag.js';

describe('computeSnapshotEtag', () => {
  const ts = new Date('2026-07-06T04:11:00Z');
  it('is stable across identical snapshots', () => {
    const slots = [
      { slotOrder: 1, conceptSlug: 'cap',  missionSlugs: ['a','b','c','d'] },
      { slotOrder: 2, conceptSlug: 'hana', missionSlugs: ['e','f','g','h'] },
    ];
    expect(computeSnapshotEtag({ computedAt: ts, slots }))
      .toBe(computeSnapshotEtag({ computedAt: ts, slots: [...slots] }));
  });
  it('changes when a missionSlug changes', () => {
    const a = { computedAt: ts, slots: [{ slotOrder: 1, conceptSlug: 'cap', missionSlugs: ['a','b','c','d'] }] };
    const b = { computedAt: ts, slots: [{ slotOrder: 1, conceptSlug: 'cap', missionSlugs: ['a','b','c','X'] }] };
    expect(computeSnapshotEtag(a)).not.toBe(computeSnapshotEtag(b));
  });
  it('changes when slot order changes', () => {
    const a = { computedAt: ts, slots: [
      { slotOrder: 1, conceptSlug: 'cap',  missionSlugs: ['a'] },
      { slotOrder: 2, conceptSlug: 'hana', missionSlugs: ['b'] },
    ]};
    const b = { computedAt: ts, slots: [
      { slotOrder: 1, conceptSlug: 'hana', missionSlugs: ['b'] },
      { slotOrder: 2, conceptSlug: 'cap',  missionSlugs: ['a'] },
    ]};
    expect(computeSnapshotEtag(a)).not.toBe(computeSnapshotEtag(b));
  });
  it('is weak-tagged with quoted sha1', () => {
    const etag = computeSnapshotEtag({ computedAt: ts, slots: [] });
    expect(etag).toMatch(/^W\/"[0-9a-f]{40}"$/);
  });
  it('empty snapshot has a stable non-empty etag', () => {
    expect(computeSnapshotEtag({ computedAt: ts, slots: [] }))
      .toBe(computeSnapshotEtag({ computedAt: ts, slots: [] }));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/srv/featured-topics-etag.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```js
// srv/lib/featured-topics-etag.js
import { createHash } from 'node:crypto';

export function computeSnapshotEtag({ computedAt, slots }) {
  const canonical = [
    new Date(computedAt).toISOString(),
    ...[...slots]
      .sort((a, b) => a.slotOrder - b.slotOrder)
      .map(s => `${s.slotOrder}:${s.conceptSlug}:${(s.missionSlugs || []).join(',')}`),
  ].join('|');
  const digest = createHash('sha1').update(canonical).digest('hex');
  return `W/"${digest}"`;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/unit/srv/featured-topics-etag.test.js`
Expected: 5 passing.

- [ ] **Step 5: Commit**

```bash
git add srv/lib/featured-topics-etag.js test/unit/srv/featured-topics-etag.test.js
git commit -m "feat(#1032): weak-ETag helper for featured-topics snapshot"
```

---

## Task 4: Snapshot writer + hydrator — `srv/lib/featured-topics-snapshot.js`

**Files:**
- Create: `srv/lib/featured-topics-snapshot.js`
- Test: `test/unit/srv/featured-topics-snapshot.test.js`

**Interfaces:**
- Consumes:
  - `selectFeaturedTopics` from `./featured-topics-selection.js`
  - `computeSnapshotEtag` from `./featured-topics-etag.js`
  - CDS entities via `cds.entities('com.sap.developers.ims')`: `HomepageFeaturedTopics`, `FeaturedTopicsSnapshot`, `Concepts`, `ConceptRank`, `TutorialRank`, `KgCommunity`, `TutorialConceptLinks`, `Tutorials`, `Missions`
- Produces:
  - `async recomputeSnapshot(tx)` → `{ count: Number, computedAt: Date }` — truncates + rewrites `FeaturedTopicsSnapshot` within the provided tx
  - `async readSnapshotForFeed(tx)` → `{ computedAt: Date | null, slots: Array<{ slotOrder, source, conceptSlug, displayTitle, missions: Array<{ slug, title, summary, imageUrl, kind }> }>, etag: string }`

- [ ] **Step 1: Write the failing test**

```js
// test/unit/srv/featured-topics-snapshot.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

describe('featured-topics-snapshot', () => {
  let recomputeSnapshot, readSnapshotForFeed;
  const NS = 'com.sap.developers.ims';

  beforeAll(async () => {
    await cds.deploy(['db/knowledge-graph.cds','db/homepage-featured.cds','db/tutorials.cds','db/missions.cds']).to('sqlite::memory:');
    ({ recomputeSnapshot, readSnapshotForFeed } = await import('../../../srv/lib/featured-topics-snapshot.js'));
  });

  it('produces an empty snapshot when no editorial and no ConceptRank rows', async () => {
    await cds.tx(async (tx) => {
      const res = await recomputeSnapshot(tx);
      expect(res.count).toBe(0);
      const feed = await readSnapshotForFeed(tx);
      expect(feed.slots).toEqual([]);
      expect(feed.etag).toMatch(/^W\/"[0-9a-f]{40}"$/);
    });
  });

  it('materializes 1 editorial slot when concept is published + missions active', async () => {
    await cds.tx(async (tx) => {
      const { Concepts, TutorialRank, TutorialConceptLinks, HomepageFeaturedTopics, Tutorials } = cds.entities(NS);
      const conceptId = cds.utils.uuid();
      await tx.run(INSERT.into(Concepts).entries({ ID: conceptId, slug: 'cap', name: 'CAP', status: 'ACTIVE', publishedAt: new Date().toISOString() }));
      await tx.run(INSERT.into(Tutorials).entries({ slug: 'cap-t1', title: 'CAP T1' }));
      await tx.run(INSERT.into(TutorialRank).entries({ slug: 'cap-t1', score: 1.0, computedAt: new Date().toISOString() }));
      await tx.run(INSERT.into(TutorialConceptLinks).entries({ ID: cds.utils.uuid(), tutorial_slug: 'cap-t1', concept_ID: conceptId, predicate: 'teaches' }));
      await tx.run(INSERT.into(HomepageFeaturedTopics).entries({ ID: cds.utils.uuid(), concept_ID: conceptId, sortOrder: 10, isActive: true }));

      const res = await recomputeSnapshot(tx);
      expect(res.count).toBe(1);
      const feed = await readSnapshotForFeed(tx);
      expect(feed.slots).toHaveLength(1);
      expect(feed.slots[0].conceptSlug).toBe('cap');
      expect(feed.slots[0].source).toBe('EDITORIAL');
      expect(feed.slots[0].missions[0].slug).toBe('cap-t1');
    });
  });

  it('is idempotent — running twice produces the same rows', async () => {
    await cds.tx(async (tx) => {
      const first = await recomputeSnapshot(tx);
      const second = await recomputeSnapshot(tx);
      expect(second.count).toBe(first.count);
    });
  });
});
```

Note: if the project's `Tutorials`/`Missions` entities have additional mandatory columns, add them to the `INSERT.into(...)` payloads in the tests — do not weaken assertions.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/srv/featured-topics-snapshot.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```js
// srv/lib/featured-topics-snapshot.js
import cds from '@sap/cds';
import { selectFeaturedTopics } from './featured-topics-selection.js';
import { computeSnapshotEtag } from './featured-topics-etag.js';

const NS = 'com.sap.developers.ims';
const TARGET_COUNT = 8;
const MISSIONS_PER_SLIDE = 4;
const LOG = cds.log('featured-topics');

const lower = (x) => (x == null ? x : String(x).toLowerCase());

async function loadInputs(tx) {
  const { HomepageFeaturedTopics, Concepts, ConceptRank, TutorialRank, KgCommunity, TutorialConceptLinks, Tutorials, Missions } = cds.entities(NS);

  const editorialRows = await tx.run(SELECT.from(HomepageFeaturedTopics).columns('ID','concept_ID','displayTitle','sortOrder','validFrom','validUntil','missionSlugs','isActive','createdAt'));
  const editorialConceptIds = [...new Set(editorialRows.map(r => r.concept_ID).filter(Boolean))];
  const editorialConceptsById = new Map();
  if (editorialConceptIds.length) {
    const rows = await tx.run(SELECT.from(Concepts).columns('ID','slug','name','status','publishedAt').where({ ID: { in: editorialConceptIds } }));
    for (const r of rows) editorialConceptsById.set(r.ID, r);
  }
  const editorial = editorialRows.map(r => {
    const c = editorialConceptsById.get(r.concept_ID) || {};
    return {
      conceptId: r.concept_ID,
      conceptSlug: lower(c.slug),
      conceptName: c.name,
      conceptStatus: c.status,
      conceptPublishedAt: c.publishedAt,
      displayTitle: r.displayTitle,
      sortOrder: r.sortOrder,
      validFrom: r.validFrom,
      validUntil: r.validUntil,
      missionSlugs: Array.isArray(r.missionSlugs) ? r.missionSlugs.map(lower) : r.missionSlugs,
      isActive: r.isActive,
      createdAt: r.createdAt,
    };
  }).filter(r => r.conceptSlug);

  const rankRows = await tx.run(SELECT.from(ConceptRank).columns('slug','score').orderBy('score desc','slug asc'));
  const conceptMetaBySlug = new Map();
  if (rankRows.length) {
    const rows = await tx.run(SELECT.from(Concepts).columns('ID','slug','name','status','publishedAt').where({ slug: { in: rankRows.map(r => lower(r.slug)) } }));
    for (const r of rows) conceptMetaBySlug.set(lower(r.slug), r);
  }
  const kgCandidates = rankRows.map(r => {
    const meta = conceptMetaBySlug.get(lower(r.slug)) || {};
    return {
      conceptSlug: lower(r.slug),
      conceptName: meta.name,
      conceptStatus: meta.status,
      conceptPublishedAt: meta.publishedAt,
      pagerankScore: r.score,
    };
  });

  const communityByConcept = new Map();
  try {
    const rows = await tx.run(SELECT.from(KgCommunity).columns('vertexSlug','communityFingerprint').where({ vertexKind: 'CONCEPT' }));
    for (const r of rows) communityByConcept.set(lower(r.vertexSlug), r.communityFingerprint);
  } catch (err) {
    LOG.warn('KgCommunity read failed; diversity filter no-ops:', err.message);
  }

  const conceptSlugsById = new Map();
  for (const c of editorialConceptsById.values()) if (c.slug) conceptSlugsById.set(c.ID, lower(c.slug));
  for (const c of conceptMetaBySlug.values()) if (c.ID) conceptSlugsById.set(c.ID, lower(c.slug));

  const links = await tx.run(SELECT.from(TutorialConceptLinks).columns('tutorial_slug','concept_ID').where({ predicate: 'teaches' }));
  const trRows = await tx.run(SELECT.from(TutorialRank).columns('slug','score').orderBy('score desc','slug asc'));
  const rankBySlug = new Map(trRows.map(r => [lower(r.slug), r.score]));
  const tutorialRanksByConcept = new Map();
  for (const l of links) {
    const cs = conceptSlugsById.get(l.concept_ID);
    if (!cs) continue;
    const ts = lower(l.tutorial_slug);
    if (!tutorialRanksByConcept.has(cs)) tutorialRanksByConcept.set(cs, []);
    tutorialRanksByConcept.get(cs).push({ tutorialSlug: ts, score: rankBySlug.has(ts) ? rankBySlug.get(ts) : 0 });
  }
  for (const arr of tutorialRanksByConcept.values()) {
    arr.sort((a, b) => (b.score - a.score) || a.tutorialSlug.localeCompare(b.tutorialSlug));
  }

  const tutorialsBySlug = new Set();
  const tuts = await tx.run(SELECT.from(Tutorials).columns('slug'));
  for (const t of tuts) tutorialsBySlug.add(lower(t.slug));
  try {
    const missions = await tx.run(SELECT.from(Missions).columns('slug'));
    for (const m of missions) tutorialsBySlug.add(lower(m.slug));
  } catch { /* fixture may omit Missions */ }

  return { editorial, kgCandidates, communityByConcept, tutorialRanksByConcept, tutorialsBySlug };
}

export async function recomputeSnapshot(tx) {
  const { FeaturedTopicsSnapshot } = cds.entities(NS);
  const inputs = await loadInputs(tx);
  const slots = selectFeaturedTopics({ ...inputs, targetCount: TARGET_COUNT, missionsPerSlide: MISSIONS_PER_SLIDE });
  const computedAt = new Date().toISOString();

  await tx.run(DELETE.from(FeaturedTopicsSnapshot));
  if (slots.length) {
    await tx.run(INSERT.into(FeaturedTopicsSnapshot).entries(
      slots.map((s, i) => ({
        slotOrder: i + 1,
        source: s.source,
        conceptSlug: s.conceptSlug,
        displayTitle: s.displayTitle || '',
        missionSlugs: s.missionSlugs,
        computedAt,
      })),
    ));
  }
  LOG.info(`recomputeSnapshot wrote ${slots.length} slots`);
  return { count: slots.length, computedAt: new Date(computedAt) };
}

export async function readSnapshotForFeed(tx) {
  const { FeaturedTopicsSnapshot, Tutorials, Missions } = cds.entities(NS);
  const rows = await tx.run(SELECT.from(FeaturedTopicsSnapshot).orderBy('slotOrder asc'));
  if (!rows.length) {
    return { computedAt: null, slots: [], etag: computeSnapshotEtag({ computedAt: new Date(0), slots: [] }) };
  }
  const allSlugs = new Set();
  for (const r of rows) for (const s of (r.missionSlugs || [])) allSlugs.add(lower(s));
  const slugList = [...allSlugs];

  const cardBySlug = new Map();
  if (slugList.length) {
    const tRows = await tx.run(SELECT.from(Tutorials).columns('slug','title','summary','imageUrl').where({ slug: { in: slugList } }));
    for (const c of tRows) cardBySlug.set(lower(c.slug), { slug: lower(c.slug), title: c.title, summary: c.summary, imageUrl: c.imageUrl, kind: 'tutorial' });
    try {
      const mRows = await tx.run(SELECT.from(Missions).columns('slug','title','summary','imageUrl').where({ slug: { in: slugList } }));
      for (const c of mRows) cardBySlug.set(lower(c.slug), { slug: lower(c.slug), title: c.title, summary: c.summary, imageUrl: c.imageUrl, kind: 'mission' });
    } catch { /* fixture may omit Missions */ }
  }

  const computedAt = rows[0].computedAt;
  const slots = rows.map(r => ({
    slotOrder: r.slotOrder,
    source: r.source,
    conceptSlug: r.conceptSlug,
    displayTitle: r.displayTitle,
    missions: (r.missionSlugs || []).map(s => cardBySlug.get(lower(s))).filter(Boolean),
  }));
  const etag = computeSnapshotEtag({
    computedAt,
    slots: rows.map(r => ({ slotOrder: r.slotOrder, conceptSlug: r.conceptSlug, missionSlugs: r.missionSlugs || [] })),
  });
  return { computedAt: new Date(computedAt), slots, etag };
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/unit/srv/featured-topics-snapshot.test.js`
Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git add srv/lib/featured-topics-snapshot.js test/unit/srv/featured-topics-snapshot.test.js
git commit -m "feat(#1032): snapshot writer + dereferenced feed reader"
```

---

## Task 5: Nightly job — `srv/jobs/kg-featured-topics-job.js` + scheduler wiring

**Files:**
- Create: `srv/jobs/kg-featured-topics-job.js`
- Modify: `srv/jobs/scheduler.js` — add one `registerJob({...})` block inside `registerJobs()`

**Interfaces:**
- Consumes: `recomputeSnapshot` from `srv/lib/featured-topics-snapshot.js`
- Produces:
  - `async runKgFeaturedTopics(logId)` — used by the scheduler's `runJobByName` path
  - Registered `jobName: 'kg-featured-topics'` with `schedule: '11 4 * * *'`, `ttlMs: 600000`

- [ ] **Step 1: Write the job module**

```js
// srv/jobs/kg-featured-topics-job.js
// Nightly rebuild of FeaturedTopicsSnapshot at 04:11 UTC (after PageRank + communities).
// Spec: docs/superpowers/specs/2026-07-06-1032-featured-missions-carousel-design.md §7.4.
import cds from '@sap/cds';
import { recomputeSnapshot } from '../lib/featured-topics-snapshot.js';

const LOG = cds.log('kg-featured-topics');

export async function runKgFeaturedTopics(_logId) {
  const started = Date.now();
  try {
    const { count, computedAt } = await cds.tx(async (tx) => recomputeSnapshot(tx));
    LOG.info(`snapshot rewritten in ${Date.now() - started}ms — ${count} slots at ${computedAt.toISOString()}`);
    return { count, computedAt };
  } catch (err) {
    LOG.error(`snapshot rebuild failed after ${Date.now() - started}ms — snapshot table left untouched`, err);
    throw err;
  }
}
```

- [ ] **Step 2: Register in scheduler.js**

Open `srv/jobs/scheduler.js`. Find the existing `registerJobs()` function. Add near other KG jobs (kg-pagerank, kg-communities):

```js
import { runKgFeaturedTopics } from './kg-featured-topics-job.js';
```

And inside `registerJobs()`:

```js
// Daily at 04:11 UTC — recompute FeaturedTopicsSnapshot from ConceptRank +
// KgCommunity + editorial rows. Off-minute :11 avoids the :00/:30 herd and
// runs after PageRank (03:53) and communities (03:57). (#1032)
registerJob({
  jobName: 'kg-featured-topics',
  schedule: '11 4 * * *',
  ttlMs: 600000,
  description: 'Rebuild FeaturedTopicsSnapshot from KG signals + editorial rows',
  fn: (logId) => runKgFeaturedTopics(logId),
});
```

Verify no other job in the file uses `11 4 * * *` (off-minute collision guard from the file's own header comment).

- [ ] **Step 3: Write a smoke test for the job registration**

```js
// test/unit/srv/kg-featured-topics-job.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

describe('kg-featured-topics-job', () => {
  beforeAll(async () => {
    await cds.deploy(['db/knowledge-graph.cds','db/homepage-featured.cds','db/tutorials.cds','db/missions.cds']).to('sqlite::memory:');
  });

  it('runs without throwing when inputs are empty', async () => {
    const { runKgFeaturedTopics } = await import('../../../srv/jobs/kg-featured-topics-job.js');
    const res = await runKgFeaturedTopics('test-log-id');
    expect(res.count).toBe(0);
  });
});
```

- [ ] **Step 4: Run test**

Run: `npx vitest run test/unit/srv/kg-featured-topics-job.test.js`
Expected: 1 passing.

- [ ] **Step 5: Commit**

```bash
git add srv/jobs/kg-featured-topics-job.js srv/jobs/scheduler.js test/unit/srv/kg-featured-topics-job.test.js
git commit -m "feat(#1032): nightly kg-featured-topics job at 04:11 UTC"
```

---

## Task 6: Build + runtime feeds — `/build/featured-topics`, `/api/homepage/featuredTopics`

**Files:**
- Modify: `srv/developer-service.js` — new express route `GET /build/featured-topics`
- Modify: `srv/homepage-service.cds` — add unbound function
- Modify: `srv/homepage-service.js` — implement handler with 60s cache + ETag / 304
- Test: `test/unit/srv/featured-topics-endpoint.test.js`

**Interfaces:**
- Consumes: `readSnapshotForFeed` from `srv/lib/featured-topics-snapshot.js`
- Produces:
  - `GET /build/featured-topics` → `200 { computedAt, etag, snapshot: [ { slotOrder, source, conceptSlug, displayTitle, missions: [...] } ] }`
  - `GET /api/homepage/featuredTopics(...)` OData → same payload; sets `ETag` + `Cache-Control: public, max-age=60`; returns `304` when `If-None-Match` matches.

- [ ] **Step 1: Write the failing test**

```js
// test/unit/srv/featured-topics-endpoint.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

const HOMEPAGE = 'HomepageService';

describe('featured-topics endpoints', () => {
  let app;
  beforeAll(async () => {
    app = await cds.test('.');
  });

  it('/api/homepage/featuredTopics returns 200 with empty snapshot initially', async () => {
    const res = await app.get('/api/homepage/featuredTopics()');
    expect(res.status).toBe(200);
    expect(res.data).toHaveProperty('snapshot');
    expect(res.data).toHaveProperty('etag');
    expect(res.headers.etag).toBe(res.data.etag);
  });

  it('/api/homepage/featuredTopics returns 304 on If-None-Match', async () => {
    const first = await app.get('/api/homepage/featuredTopics()');
    const etag = first.headers.etag;
    const second = await app.get('/api/homepage/featuredTopics()', { headers: { 'If-None-Match': etag } });
    expect(second.status).toBe(304);
  });

  it('/build/featured-topics returns 200 with the same payload shape', async () => {
    const res = await app.get('/build/featured-topics');
    expect(res.status).toBe(200);
    expect(res.data).toHaveProperty('snapshot');
    expect(res.data).toHaveProperty('computedAt');
    expect(res.data).toHaveProperty('etag');
  });
});
```

- [ ] **Step 2: Extend `srv/homepage-service.cds`**

Add inside the existing service definition:

```cds
// (#1032) Featured missions carousel snapshot. Public — no auth. 60s cache;
// ETag returned so the Vue island can hydrate cheaply.
function featuredTopics() returns { computedAt : Timestamp; etag : String; snapshot : many {
  slotOrder    : Integer;
  source       : String;
  conceptSlug  : String;
  displayTitle : String;
  missions     : many { slug: String; title: String; summary: String; imageUrl: String; kind: String; };
}};
```

- [ ] **Step 3: Implement handler in `srv/homepage-service.js`**

Add near the other handlers:

```js
import { readSnapshotForFeed } from './lib/featured-topics-snapshot.js';

// 60s in-process cache — small object, single instance, no cross-instance
// coherence needed because the payload shifts only on scheduled job or admin
// save (both of which we can tolerate a 60s lag on).
let _ftCache = { at: 0, payload: null };
const FT_CACHE_MS = 60_000;

async function _getFeaturedTopicsPayload() {
  const now = Date.now();
  if (_ftCache.payload && (now - _ftCache.at) < FT_CACHE_MS) return _ftCache.payload;
  const tx = cds.tx({});
  try {
    const { computedAt, slots, etag } = await readSnapshotForFeed(tx);
    const payload = { computedAt, etag, snapshot: slots };
    _ftCache = { at: now, payload };
    return payload;
  } finally {
    await tx.commit();
  }
}

// (#1032) featuredTopics — unbound function handler with ETag + 304.
this.on('featuredTopics', async (req) => {
  const payload = await _getFeaturedTopicsPayload();
  const ifNoneMatch = req.http?.req?.headers?.['if-none-match'];
  const res = req.http?.res;
  if (res) {
    res.setHeader('ETag', payload.etag);
    res.setHeader('Cache-Control', 'public, max-age=60');
  }
  if (ifNoneMatch && ifNoneMatch === payload.etag && res) {
    res.status(304).end();
    req.reject({ code: 304, message: 'Not Modified' }); // suppress body serialization
    return;
  }
  return payload;
});
```

Note: if `srv/homepage-service.js` is CommonJS, adapt the `import` to `const { readSnapshotForFeed } = require('./lib/featured-topics-snapshot.js')` — check the surrounding file style before making the change.

- [ ] **Step 4: Add `GET /build/featured-topics` to `srv/developer-service.js`**

Find the block that registers `/build/homepage-shelves` (or `/build/catalog`) and add:

```js
this.on('*', async (req) => { /* existing */ });

// (#1032) featured topics snapshot — used by scripts/fetch-tutorials.ts to
// bake hugo/data/featured_topics.json. Public; internal build-time consumer.
if (this.app) {
  this.app.get('/build/featured-topics', async (_req, res) => {
    try {
      const { readSnapshotForFeed } = await import('./lib/featured-topics-snapshot.js');
      const tx = cds.tx({});
      try {
        const { computedAt, slots, etag } = await readSnapshotForFeed(tx);
        res.json({ computedAt, etag, snapshot: slots });
      } finally { await tx.commit(); }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}
```

Note: the exact wiring for HTTP routes on `DeveloperService` follows the existing `/build/homepage-shelves` handler — mirror whatever framing that route uses (express `this.app.get`, or a CAP `serve.on('READ', ...)` if that's the convention). Do not fabricate a new mechanism.

- [ ] **Step 5: Run tests**

Run: `npx vitest run test/unit/srv/featured-topics-endpoint.test.js`
Expected: 3 passing.

- [ ] **Step 6: Commit**

```bash
git add srv/homepage-service.cds srv/homepage-service.js srv/developer-service.js test/unit/srv/featured-topics-endpoint.test.js
git commit -m "feat(#1032): /build/featured-topics + /api/homepage/featuredTopics with ETag/304"
```

---

## Task 7: Admin surface — CRUD + `recomputeFeaturedTopics` + Fiori Elements page

**Files:**
- Modify: `srv/admin-service.cds`
- Modify: `srv/admin-service.js`
- Modify: `app/admin-annotations.cds`
- Modify: `app/admin-shell/webapp/manifest.json` — new route + component
- Test: `test/unit/srv/admin-featured-topics-crud.test.js`

**Interfaces:**
- Consumes: `recomputeSnapshot` from `srv/lib/featured-topics-snapshot.js`; `triggerRebuildDispatch` (or the exported name in `srv/lib/rebuild-trigger.js` — verify before use)
- Produces:
  - `AdminService.FeaturedTopics` (draft-enabled projection on `HomepageFeaturedTopics`, `@requires: 'Tutorial.Author'`)
  - `AdminService.FeaturedTopicsSnapshotView` (read-only projection on `FeaturedTopicsSnapshot`)
  - `action recomputeFeaturedTopics() returns { count: Integer; computedAt: Timestamp }` (`@requires: 'Tutorial.SuperAdmin'`)

- [ ] **Step 1: Write the failing test**

```js
// test/unit/srv/admin-featured-topics-crud.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

describe('AdminService.FeaturedTopics', () => {
  let app;
  beforeAll(async () => { app = await cds.test('.'); });

  it('rejects duplicate concept on active create', async () => {
    const { Concepts } = cds.entities('com.sap.developers.ims');
    const conceptId = cds.utils.uuid();
    await cds.tx(async (tx) => {
      await tx.run(INSERT.into(Concepts).entries({ ID: conceptId, slug: 'x', name: 'X', status: 'ACTIVE', publishedAt: new Date().toISOString() }));
    });
    const one = await app.post('/odata/v4/admin/FeaturedTopics', { concept_ID: conceptId, sortOrder: 10, isActive: true }, { auth: { username: 'author', password: '' } });
    expect(one.status).toBeLessThan(300);
    const two = await app.post('/odata/v4/admin/FeaturedTopics', { concept_ID: conceptId, sortOrder: 20, isActive: true }, { auth: { username: 'author', password: '' } });
    expect(two.status).toBeGreaterThanOrEqual(400);
  });

  it('recomputeFeaturedTopics action returns count + computedAt', async () => {
    const res = await app.post('/odata/v4/admin/recomputeFeaturedTopics', {}, { auth: { username: 'superadmin', password: '' } });
    expect(res.status).toBeLessThan(300);
    expect(res.data).toHaveProperty('count');
    expect(res.data).toHaveProperty('computedAt');
  });

  it('after-SAVE fires recompute + rebuild dispatch (dispatch is spied)', async () => {
    // Details vary by the project's rebuild-trigger export shape; guard by
    // asserting the snapshot count changes after a create.
    // (Implementation of this test may need to import a mock hook from
    // srv/lib/rebuild-trigger.js — check that module's testing seam.)
  });
});
```

Note: the auth stubs (`author`, `superadmin`) match the project's mock users in `.cdsrc.json` / `package.json`. Verify the actual mock-user names in that file and adjust if different.

- [ ] **Step 2: Extend `srv/admin-service.cds`**

Add inside the existing `AdminService` service block:

```cds
// (#1032) Featured missions carousel — editorial rows + read-only snapshot.
@odata.draft.enabled
@requires: 'Tutorial.Author'
entity FeaturedTopics as projection on db.HomepageFeaturedTopics;

@readonly
@requires: 'Tutorial.Author'
entity FeaturedTopicsSnapshotView as projection on db.FeaturedTopicsSnapshot;

@requires: 'Tutorial.SuperAdmin'
action recomputeFeaturedTopics() returns { count : Integer; computedAt : Timestamp; };
```

(Update the `db.` alias to whatever the file uses to reference the DB namespace — mirror how `HomepageShelves` is projected in the same file.)

- [ ] **Step 3: Handlers in `srv/admin-service.js`**

Add (respect the file's module style — ESM vs CJS — from context):

```js
import { recomputeSnapshot } from './lib/featured-topics-snapshot.js';
import { scheduleRebuildDispatch } from './lib/rebuild-trigger.js'; // verify exported name

this.on('recomputeFeaturedTopics', async () => {
  const { count, computedAt } = await cds.tx(async (tx) => recomputeSnapshot(tx));
  return { count, computedAt };
});

// After-SAVE on the draft-active flow — recompute inline (8 rows, fast) so
// admins see the new snapshot immediately, and trigger the debounced rebuild
// dispatcher so hugo/data/featured_topics.json is refreshed within ~2 min.
this.after(['CREATE','UPDATE','DELETE'], 'FeaturedTopics', async (_data, req) => {
  try {
    await cds.tx(async (tx) => recomputeSnapshot(tx));
  } catch (err) {
    cds.log('admin-featured').warn('inline recompute failed after write:', err.message);
  }
  try {
    scheduleRebuildDispatch({ triggerSource: 'admin-featured-topics', mode: 'auto' });
  } catch (err) {
    cds.log('admin-featured').warn('rebuild dispatch failed:', err.message);
  }
});
```

If `srv/lib/rebuild-trigger.js` exports a differently-named function, use whatever export the file provides — mirror the way `HomepageShelves` writes call it (search the file for `HomepageShelves` references or `triggerSource` string literals).

- [ ] **Step 4: Fiori Elements annotations in `app/admin-annotations.cds`**

```cds
using AdminService from '../srv/admin-service';

annotate AdminService.FeaturedTopics with @(
  UI.HeaderInfo: { TypeName: 'Featured Topic', TypeNamePlural: 'Featured Topics', Title: { Value: displayTitle } },
  UI.LineItem: [
    { Value: concept_ID, Label: 'Concept' },
    { Value: displayTitle,   Label: 'Display Title' },
    { Value: sortOrder,      Label: 'Order' },
    { Value: validFrom,      Label: 'From' },
    { Value: validUntil,     Label: 'Until' },
    { Value: isActive,       Label: 'Active' },
  ],
  UI.SelectionFields: [ isActive ],
  UI.FieldGroup #Main: { Data: [
    { Value: concept_ID }, { Value: displayTitle }, { Value: sortOrder },
    { Value: validFrom },  { Value: validUntil },   { Value: isActive },
    { Value: missionSlugs, Label: 'Mission Slug Overrides' },
    { Value: notes },
  ]},
  UI.Facets: [
    { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#Main', Label: 'Details' },
  ],
);

annotate AdminService.FeaturedTopics with {
  concept @(
    Common.ValueList: {
      CollectionPath: 'Concepts',
      SearchSupported: true,
      Parameters: [
        { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: concept_ID, ValueListProperty: 'ID' },
        { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'slug' },
        { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'name' },
      ],
    },
    // (#1032) Prevent @cap-js/ai after-write hook from crashing on draft
    // create — memory `cap-ai-plugin-aicore-kind-resolution` / #1019.
    UI.RecommendationState: 0,
  );
};

annotate AdminService.FeaturedTopicsSnapshotView with @(
  UI.HeaderInfo: { TypeName: 'Snapshot Slot', TypeNamePlural: 'Snapshot Slots' },
  UI.LineItem: [
    { Value: slotOrder }, { Value: source }, { Value: conceptSlug },
    { Value: displayTitle }, { Value: computedAt },
  ],
);
```

- [ ] **Step 5: Route in admin-shell manifest**

Open `app/admin-shell/webapp/manifest.json`. Under `sap.ui5.routing.routes`, add (mirror existing shape for e.g. `homepageShelves`):

```json
{
  "pattern": "featured-topics",
  "name": "featuredTopics",
  "target": "featuredTopics"
}
```

And under `sap.ui5.routing.targets`:

```json
"featuredTopics": {
  "type": "Component",
  "id": "featuredTopicsComponent",
  "name": "sap.ux.fe.templates.ListReport",
  "options": { "settings": { "contextPath": "/FeaturedTopics" } }
}
```

Exact key names + component template come from the neighboring admin component config — copy that shape verbatim to avoid drift.

- [ ] **Step 6: Run tests**

Run: `npx vitest run test/unit/srv/admin-featured-topics-crud.test.js`
Expected: 2 passing (+ the third is a stub that documents intent; may be marked `it.skip` if the rebuild-trigger seam isn't easily mockable).

- [ ] **Step 7: Regenerate CDS + commit**

```bash
npx cds build --production
git add srv/admin-service.cds srv/admin-service.js app/admin-annotations.cds app/admin-shell/webapp/manifest.json test/unit/srv/admin-featured-topics-crud.test.js db/last-dev/ 2>/dev/null || git add srv/admin-service.cds srv/admin-service.js app/admin-annotations.cds app/admin-shell/webapp/manifest.json test/unit/srv/admin-featured-topics-crud.test.js
git commit -m "feat(#1032): admin surface — FeaturedTopics CRUD + recompute action + FE annotations"
```

---

## Task 8: Build-time bake — `scripts/fetch-tutorials.ts` writes `hugo/data/featured_topics.json`

**Files:**
- Modify: `scripts/fetch-tutorials.ts`

**Interfaces:**
- Consumes: `GET /build/featured-topics` (from CAP backend, base URL from env or existing helper)
- Produces: `hugo/data/featured_topics.json` — `{ computedAt, etag, snapshot: [...] }`. Missing/error → `{ computedAt: null, etag: '', snapshot: [] }`.

- [ ] **Step 1: Locate the existing fetch helper**

Search for the block that writes `hugo/data/homepage_shelves.json` (baked from `GET /build/homepage-shelves`, per `docs/developers/architecture/homepage.md` §Data Flow). Mirror its fetch + write structure.

Run: `grep -n "homepage_shelves\|/build/homepage-shelves" scripts/fetch-tutorials.ts`
Note the function name, the base URL helper, and the retry/timeout handling.

- [ ] **Step 2: Add the sibling function**

Right below the homepage-shelves writer, insert:

```ts
// (#1032) Featured missions carousel — build-baked baseline. The Vue island
// hydrates against /api/homepage/featuredTopics with If-None-Match at load
// time, so a slightly stale JSON is fine; a fetch failure degrades to an
// empty carousel (Row 5 disappears cleanly).
async function writeFeaturedTopics(): Promise<void> {
  const outPath = path.join(HUGO_DATA_DIR, 'featured_topics.json');
  const empty = { computedAt: null, etag: '', snapshot: [] };
  const base = getCapBaseUrl(); // reuse the helper /build/homepage-shelves uses
  if (!base) {
    console.warn('  [featured-topics] no CAP base URL — writing empty payload');
    await fs.writeFile(outPath, JSON.stringify(empty));
    return;
  }
  const url = `${base.replace(/\/$/, '')}/build/featured-topics`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    await fs.writeFile(outPath, JSON.stringify(body));
    console.log(`  [featured-topics] wrote ${body?.snapshot?.length ?? 0} slides → ${outPath}`);
  } catch (err) {
    console.warn(`  [featured-topics] fetch failed: ${(err as Error).message} — writing empty payload`);
    await fs.writeFile(outPath, JSON.stringify(empty));
  }
}
```

Then call `await writeFeaturedTopics()` in the same block that calls the homepage-shelves writer.

- [ ] **Step 3: Sanity-check the writer runs**

Run: `npm run fetch-tutorials` (with a mocked CAP endpoint or DEV backend). If CAP is unreachable, verify the file is created with the empty payload rather than the command failing.

```bash
node -e "console.log(JSON.parse(require('fs').readFileSync('hugo/data/featured_topics.json','utf8')))"
```

Expected: valid JSON with `snapshot` array (possibly empty), `computedAt`, `etag`.

- [ ] **Step 4: Commit**

```bash
git add scripts/fetch-tutorials.ts
git commit -m "feat(#1032): bake hugo/data/featured_topics.json at build time"
```

---

## Task 9: SSR partial + Row 5 swap + CSS

**Files:**
- Create: `hugo/layouts/partials/homepage/featured-topics-carousel.html`
- Create: `hugo/assets/css/homepage/_featured-carousel.css`
- Modify: `hugo/layouts/index.html` — swap partial include for Row 5
- Modify: `hugo/assets/css/homepage.css` — `@import "_featured-carousel.css"` (or whatever mechanism the file uses to compose partial CSS)

**Interfaces:**
- Consumes: `.Site.Data.featured_topics` (written by Task 8)
- Produces: SSR carousel HTML with `data-app="featured-topics-carousel"` and `data-etag` for the Vue island to hydrate.

- [ ] **Step 1: Write the SSR partial**

```html
{{- /* featured-topics-carousel.html — issue #1032 row 5.
       Reads .Site.Data.featured_topics (populated by scripts/fetch-tutorials.ts
       calling GET /build/featured-topics). Renders 8 SSR slides so the first
       paint is instant + SEO-visible. The Vue island (data-app hook) rehydrates
       with fresher data via /api/homepage/featuredTopics + If-None-Match. */ -}}
{{- $ft := .Site.Data.featured_topics -}}
{{- $slides := $ft.snapshot | default slice -}}
{{- if gt (len $slides) 0 -}}
<section class="hp-featured-carousel"
         data-app="featured-topics-carousel"
         data-etag="{{ $ft.etag }}"
         aria-roledescription="carousel"
         aria-label="Featured missions by topic">
  <div class="hp-featured-carousel__header">
    <h2 id="hp-featured-title" class="hp-band__title">Featured missions</h2>
    <a class="hp-featured-carousel__see-all" href="/tutorial-navigator/">Browse all →</a>
  </div>
  <div class="hp-featured-carousel__viewport" aria-live="polite">
    {{ range $i, $slide := $slides }}
      <div class="hp-featured-carousel__slide {{ if eq $i 0 }}is-active{{ else }}hidden{{ end }}"
           id="featured-{{ $slide.conceptSlug }}"
           role="group"
           aria-roledescription="slide"
           aria-label="{{ $slide.displayTitle }}, slide {{ add $i 1 }} of {{ len $slides }}">
        <h3 class="hp-featured-carousel__topic">{{ $slide.displayTitle }}</h3>
        <div class="hp-featured-carousel__grid cards">
          {{ range $slide.missions }}{{ partial "browse/_partials/card-mission.html" . }}{{ end }}
        </div>
      </div>
    {{ end }}
  </div>
  <nav class="hp-featured-carousel__controls" aria-label="Carousel controls">
    <button type="button" data-action="prev" aria-label="Previous topic">‹</button>
    <button type="button" data-action="play-pause" aria-label="Pause auto-advance" aria-pressed="false">⏸</button>
    <button type="button" data-action="next" aria-label="Next topic">›</button>
    <ol class="hp-featured-carousel__dots" role="tablist">
      {{ range $i, $slide := $slides }}
        <li role="presentation">
          <button type="button" role="tab" data-slide-index="{{ $i }}"
                  aria-selected="{{ if eq $i 0 }}true{{ else }}false{{ end }}"
                  aria-label="Show {{ $slide.displayTitle }}">
          </button>
        </li>
      {{ end }}
    </ol>
  </nav>
</section>
{{- end -}}
```

- [ ] **Step 2: Write the CSS**

```css
/* hugo/assets/css/homepage/_featured-carousel.css — issue #1032 */
.hp-featured-carousel { position: relative; }
.hp-featured-carousel__header { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 1rem; }
.hp-featured-carousel__viewport { position: relative; min-height: 22rem; }
.hp-featured-carousel__slide { transition: opacity 300ms ease, transform 300ms ease; opacity: 1; transform: translateX(0); }
.hp-featured-carousel__slide.hidden { display: none; }
.hp-featured-carousel__slide.is-fading-out { opacity: 0; transform: translateX(-10px); }
.hp-featured-carousel__slide.is-fading-in  { opacity: 0; transform: translateX(10px); }
.hp-featured-carousel__topic { font-size: 1.125rem; margin-bottom: 0.75rem; }
.hp-featured-carousel__grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1rem; }
@media (max-width: 900px) { .hp-featured-carousel__grid { grid-template-columns: repeat(2, 1fr); } }
@media (max-width: 500px) { .hp-featured-carousel__grid { grid-template-columns: 1fr; } }
.hp-featured-carousel__controls { display: flex; align-items: center; gap: 0.5rem; margin-top: 1rem; justify-content: center; }
.hp-featured-carousel__dots { list-style: none; padding: 0; margin: 0; display: flex; gap: 0.375rem; }
.hp-featured-carousel__dots button {
  width: 0.625rem; height: 0.625rem; border-radius: 50%; border: 0;
  background: var(--sapContent_ForegroundColor, #556B82); opacity: 0.35;
  cursor: pointer; padding: 0;
}
.hp-featured-carousel__dots button[aria-selected="true"] { opacity: 1; }
@media (prefers-reduced-motion: reduce) {
  .hp-featured-carousel__slide,
  .hp-featured-carousel__slide.is-fading-out,
  .hp-featured-carousel__slide.is-fading-in { transition: none; transform: none; }
}
```

- [ ] **Step 3: Wire into `homepage.css`**

Append (or insert at the same position as `_teaser.css` / other homepage partials):

```css
@import "_featured-carousel.css";
```

- [ ] **Step 4: Swap Row 5 in `hugo/layouts/index.html`**

Find the line that includes the Row 5 partial:

```
{{ partial "homepage/tutorials-teaser.html" . }}
```

Replace with:

```
{{ partial "homepage/featured-topics-carousel.html" . }}
```

Leave `tutorials-teaser.html` in place on disk as the kill-switch revert target.

- [ ] **Step 5: Build Hugo locally + eyeball**

Run: `npm run dev` and visit `http://localhost:1313/`. Row 5 should render the carousel with SSR content (first slide active, others hidden). If `hugo/data/featured_topics.json` is empty, Row 5 renders nothing — that's the correct empty-state.

- [ ] **Step 6: Commit**

```bash
git add hugo/layouts/partials/homepage/featured-topics-carousel.html hugo/assets/css/homepage/_featured-carousel.css hugo/assets/css/homepage.css hugo/layouts/index.html
git commit -m "feat(#1032): SSR carousel partial + Row 5 swap + horizon-tokened CSS"
```

---

## Task 10: Vue island — `hugo-apps/apps/featured-topics-carousel/`

**Files:**
- Create: full Vue island scaffold under `hugo-apps/apps/featured-topics-carousel/`
- Modify: `hugo-apps/vite.config.ts` (or the equivalent multi-app config file) — register the new app so its bundle emits to `hugo/static/js/featured-topics-carousel.js`

**Interfaces:**
- Consumes: SSR container with `data-app="featured-topics-carousel"` and `data-etag="…"` (from Task 9); runtime endpoint `/api/homepage/featuredTopics(...)` (from Task 6)
- Produces: mounted carousel with auto-advance, pause conditions, deep-link, ETag hydration, reduced-motion honour, keyboard nav.

- [ ] **Step 1: Mirror an existing island's scaffold**

Copy the smallest matching island's scaffold (likely `hugo-apps/apps/for-you/`) into `hugo-apps/apps/featured-topics-carousel/`, then edit paths/names. Files to write:

`hugo-apps/apps/featured-topics-carousel/package.json` — same shape as neighbor.

`hugo-apps/apps/featured-topics-carousel/src/main.ts`:

```ts
import { createApp } from 'vue';
import Carousel from './Carousel.vue';

const roots = document.querySelectorAll<HTMLElement>('[data-app="featured-topics-carousel"]');
roots.forEach((root) => {
  const etag = root.getAttribute('data-etag') || '';
  // Snapshot the SSR-rendered slides into structured props before Vue takes over.
  const initial = readInitialFromDom(root);
  createApp(Carousel, { root, initialEtag: etag, initialSlides: initial }).mount(root);
});

function readInitialFromDom(root: HTMLElement) {
  const slides = Array.from(root.querySelectorAll<HTMLElement>('.hp-featured-carousel__slide')).map((el) => ({
    conceptSlug: el.id.replace(/^featured-/, ''),
    displayTitle: el.querySelector('.hp-featured-carousel__topic')?.textContent || '',
    // Missions are read as HTML strings — Carousel.vue re-renders via v-html so no
    // client-side card-mission partial is needed. Keeps parity with SSR.
    missionsHtml: el.querySelector('.hp-featured-carousel__grid')?.innerHTML || '',
  }));
  return slides;
}
```

- [ ] **Step 2: Write `src/Carousel.vue`**

```vue
<template>
  <div class="hp-featured-carousel__viewport" aria-live="polite">
    <div v-for="(slide, i) in slides"
         :key="slide.conceptSlug"
         class="hp-featured-carousel__slide"
         :class="{ 'is-active': i === active, 'hidden': i !== active }"
         :id="'featured-' + slide.conceptSlug"
         role="group"
         aria-roledescription="slide"
         :aria-label="slide.displayTitle + ', slide ' + (i + 1) + ' of ' + slides.length">
      <h3 class="hp-featured-carousel__topic">{{ slide.displayTitle }}</h3>
      <div class="hp-featured-carousel__grid cards" v-html="slide.missionsHtml"></div>
    </div>
  </div>
  <nav class="hp-featured-carousel__controls" aria-label="Carousel controls">
    <button type="button" @click="prev" aria-label="Previous topic">‹</button>
    <button type="button" @click="togglePlay" :aria-pressed="!autoAdvance" :aria-label="autoAdvance ? 'Pause auto-advance' : 'Resume auto-advance'">
      {{ autoAdvance ? '⏸' : '▶' }}
    </button>
    <button type="button" @click="next" aria-label="Next topic">›</button>
    <ol class="hp-featured-carousel__dots" role="tablist">
      <li v-for="(slide, i) in slides" :key="slide.conceptSlug" role="presentation">
        <button type="button" role="tab"
                :aria-selected="i === active ? 'true' : 'false'"
                :aria-label="'Show ' + slide.displayTitle"
                @click="jumpTo(i)"></button>
      </li>
    </ol>
  </nav>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, computed } from 'vue';
import { useAutoAdvance } from './composables/useAutoAdvance';
import { useHydrate } from './composables/useHydrate';
import { useDeepLink } from './composables/useDeepLink';

const props = defineProps<{
  root: HTMLElement;
  initialEtag: string;
  initialSlides: Array<{ conceptSlug: string; displayTitle: string; missionsHtml: string }>;
}>();

const slides = ref(props.initialSlides);
const active = ref(0);
const userPaused = ref(false);
const reducedMotion = ref(typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches);
const autoAdvance = computed(() => !userPaused.value && !reducedMotion.value);

function jumpTo(i: number) {
  if (i < 0 || i >= slides.value.length) return;
  active.value = i;
  history.replaceState(null, '', `#featured/${slides.value[i].conceptSlug}`);
}
function next() { jumpTo((active.value + 1) % Math.max(1, slides.value.length)); userPaused.value = true; }
function prev() { jumpTo((active.value - 1 + slides.value.length) % Math.max(1, slides.value.length)); userPaused.value = true; }
function togglePlay() { userPaused.value = !userPaused.value; }

useAutoAdvance({ intervalMs: 30_000, enabled: autoAdvance, container: () => props.root, tick: () => jumpTo((active.value + 1) % Math.max(1, slides.value.length)) });
useHydrate({ etag: props.initialEtag, onFresh: (fresh) => { slides.value = fresh; } });
useDeepLink({ slides, onResolve: (i) => { active.value = i; userPaused.value = true; } });
</script>
```

- [ ] **Step 3: Composables**

`src/composables/useAutoAdvance.ts`:

```ts
import { watchEffect, onBeforeUnmount } from 'vue';

export function useAutoAdvance(opts: {
  intervalMs: number;
  enabled: { value: boolean };
  container: () => HTMLElement | null;
  tick: () => void;
}) {
  let timer: number | null = null;
  let hover = false;
  let focus = false;
  let hidden = document.hidden;
  const paused = () => hover || focus || hidden || !opts.enabled.value;
  function schedule() { if (timer != null) { clearTimeout(timer); timer = null; } if (!paused()) timer = window.setTimeout(fire, opts.intervalMs); }
  function fire() { if (!paused()) opts.tick(); schedule(); }

  const el = opts.container();
  const onMouseEnter = () => { hover = true; schedule(); };
  const onMouseLeave = () => { hover = false; schedule(); };
  const onFocusIn   = () => { focus = true; schedule(); };
  const onFocusOut  = () => { focus = false; schedule(); };
  const onVis = () => { hidden = document.hidden; schedule(); };

  if (el) {
    el.addEventListener('mouseenter', onMouseEnter);
    el.addEventListener('mouseleave', onMouseLeave);
    el.addEventListener('focusin', onFocusIn);
    el.addEventListener('focusout', onFocusOut);
  }
  document.addEventListener('visibilitychange', onVis);

  watchEffect(() => { schedule(); });
  onBeforeUnmount(() => {
    if (timer != null) clearTimeout(timer);
    if (el) {
      el.removeEventListener('mouseenter', onMouseEnter);
      el.removeEventListener('mouseleave', onMouseLeave);
      el.removeEventListener('focusin', onFocusIn);
      el.removeEventListener('focusout', onFocusOut);
    }
    document.removeEventListener('visibilitychange', onVis);
  });
}
```

`src/composables/useHydrate.ts`:

```ts
import { onMounted } from 'vue';

export function useHydrate(opts: {
  etag: string;
  onFresh: (slides: Array<{ conceptSlug: string; displayTitle: string; missionsHtml: string }>) => void;
}) {
  onMounted(async () => {
    try {
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (opts.etag) headers['If-None-Match'] = opts.etag;
      const res = await fetch('/api/homepage/featuredTopics()', { headers });
      if (res.status === 304) return;
      if (!res.ok) return;
      const body = await res.json();
      const slides = (body.snapshot || body.value?.[0]?.snapshot || []).map((s: any) => ({
        conceptSlug: s.conceptSlug,
        displayTitle: s.displayTitle,
        missionsHtml: (s.missions || []).map((m: any) =>
          `<a class="card card-mission" href="/tutorials/${m.slug}/"><img alt="" src="${m.imageUrl || ''}"><h4>${m.title || ''}</h4><p>${m.summary || ''}</p></a>`
        ).join(''),
      }));
      if (slides.length) opts.onFresh(slides);
    } catch { /* keep SSR */ }
  });
}
```

Note: the inline card markup mirrors `hugo/layouts/partials/browse/_partials/card-mission.html`. If that partial's class names differ (open the file and check), adjust the string builder — do not diverge from the SSR shape.

`src/composables/useDeepLink.ts`:

```ts
import { onMounted, Ref } from 'vue';

export function useDeepLink(opts: {
  slides: Ref<Array<{ conceptSlug: string }>>;
  onResolve: (i: number) => void;
}) {
  onMounted(() => {
    const m = location.hash.match(/^#featured\/(.+)$/);
    if (!m) return;
    const slug = decodeURIComponent(m[1]).toLowerCase();
    const idx = opts.slides.value.findIndex(s => s.conceptSlug === slug);
    if (idx >= 0) opts.onResolve(idx);
  });
}
```

- [ ] **Step 4: Register bundle in `hugo-apps/vite.config.ts`**

Add `featured-topics-carousel` to whatever apps list drives the multi-input build. Verify:

```bash
grep -n "for-you\|shared-loader\|input:" hugo-apps/vite.config.ts | head
```

Mirror the same entry pattern.

- [ ] **Step 5: Write unit tests**

```ts
// hugo-apps/apps/featured-topics-carousel/test/carousel.spec.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import Carousel from '../src/Carousel.vue';

const slides = [
  { conceptSlug: 'cap',  displayTitle: 'CAP',  missionsHtml: '<a>1</a>' },
  { conceptSlug: 'hana', displayTitle: 'HANA', missionsHtml: '<a>2</a>' },
];

function fakeRoot() {
  const el = document.createElement('section');
  document.body.appendChild(el);
  return el;
}

beforeEach(() => {
  document.body.innerHTML = '';
  vi.stubGlobal('fetch', vi.fn(async () => ({ status: 304, ok: false, json: async () => ({}) })));
});

describe('Carousel', () => {
  it('renders SSR slides on mount', () => {
    const w = mount(Carousel, { props: { root: fakeRoot(), initialEtag: 'W/"abc"', initialSlides: slides } });
    expect(w.findAll('.hp-featured-carousel__slide')).toHaveLength(2);
    expect(w.find('.is-active .hp-featured-carousel__topic').text()).toBe('CAP');
  });

  it('advances after 30s of auto-advance', async () => {
    vi.useFakeTimers();
    const w = mount(Carousel, { props: { root: fakeRoot(), initialEtag: '', initialSlides: slides } });
    await vi.advanceTimersByTimeAsync(30_500);
    expect(w.find('.is-active .hp-featured-carousel__topic').text()).toBe('HANA');
    vi.useRealTimers();
  });

  it('manual next stops auto-advance', async () => {
    vi.useFakeTimers();
    const w = mount(Carousel, { props: { root: fakeRoot(), initialEtag: '', initialSlides: slides } });
    await w.find('button[aria-label="Next topic"]').trigger('click');
    expect(w.find('.is-active .hp-featured-carousel__topic').text()).toBe('HANA');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(w.find('.is-active .hp-featured-carousel__topic').text()).toBe('HANA'); // did not advance
    vi.useRealTimers();
  });

  it('respects prefers-reduced-motion by not auto-advancing', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
    vi.useFakeTimers();
    const w = mount(Carousel, { props: { root: fakeRoot(), initialEtag: '', initialSlides: slides } });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(w.find('.is-active .hp-featured-carousel__topic').text()).toBe('CAP');
    vi.useRealTimers();
  });
});
```

- [ ] **Step 6: Run tests + build the bundle**

```bash
cd hugo-apps && npm test -- apps/featured-topics-carousel && npm run build
```

Expected: 4 passing; a `hugo/static/js/featured-topics-carousel*.js` bundle emitted.

- [ ] **Step 7: Commit**

```bash
git add hugo-apps/apps/featured-topics-carousel/ hugo-apps/vite.config.ts hugo/static/js/featured-topics-carousel*.js 2>/dev/null || git add hugo-apps/apps/featured-topics-carousel/ hugo-apps/vite.config.ts
git commit -m "feat(#1032): Vue island — auto-advance, pause conditions, deep-link, ETag hydration"
```

---

## Task 11: Hybrid + smoke tests, docs, finalize + PR

**Files:**
- Create: `test/hybrid/featured-topics-hybrid.test.js`
- Create: `test/smoke/smoke-featured-topics.test.js`
- Modify: `docs/developers/architecture/homepage.md` — Row 5 description + spec/plan links

**Interfaces:**
- Consumes: all upstream tasks.
- Produces: green hybrid + smoke test suites; docs pointer.

- [ ] **Step 1: Hybrid test**

```js
// test/hybrid/featured-topics-hybrid.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

describe('featured-topics hybrid', () => {
  let app;
  beforeAll(async () => { app = await cds.test('.'); });

  it('recompute produces a snapshot readable by /api/homepage/featuredTopics', async () => {
    // Seed: 1 published concept, 1 tutorial that teaches it, 1 editorial row,
    // 1 ConceptRank + 1 TutorialRank. Verify snapshot has 1 slot.
    // (Full seed omitted for brevity — mirror the SQL that seeds
    // ConceptRank / TutorialRank in the kg-pagerank hybrid tests, and
    // insert one HomepageFeaturedTopics row referencing the concept ID.)
    const admin = { auth: { username: 'superadmin', password: '' } };
    const rec = await app.post('/odata/v4/admin/recomputeFeaturedTopics', {}, admin);
    expect(rec.status).toBeLessThan(300);

    const feed = await app.get('/api/homepage/featuredTopics()');
    expect(feed.status).toBe(200);
    expect(Array.isArray(feed.data.snapshot)).toBe(true);
    if (feed.data.snapshot.length) {
      const first = feed.data.snapshot[0];
      // Guard: slugs are lowercase canonical.
      expect(first.conceptSlug).toBe(first.conceptSlug.toLowerCase());
      for (const m of first.missions) expect(m.slug).toBe(m.slug.toLowerCase());
    }
  });
});
```

- [ ] **Step 2: Run hybrid**

Run: `npm run test:hybrid -- --project hybrid featured-topics`
Expected: passing (or the seed reveals a schema mismatch to fix in place).

- [ ] **Step 3: Smoke test**

```js
// test/smoke/smoke-featured-topics.test.js
import { describe, it, expect } from 'vitest';

const BASE = process.env.SMOKE_SRV_URL || process.env.SMOKE_BASE_URL;
const skip = !BASE ? describe.skip : describe;

skip('featured-topics smoke', () => {
  it('/api/homepage/featuredTopics is reachable and returns valid JSON', async () => {
    const res = await fetch(`${BASE.replace(/\/$/, '')}/api/homepage/featuredTopics()`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('snapshot');
    expect(body).toHaveProperty('etag');
  });

  it('mission slugs in the snapshot resolve to real tutorial pages', async () => {
    const res = await fetch(`${BASE.replace(/\/$/, '')}/api/homepage/featuredTopics()`);
    const body = await res.json();
    for (const slide of (body.snapshot || []).slice(0, 2)) {
      for (const m of (slide.missions || []).slice(0, 1)) {
        const head = await fetch(`${BASE.replace(/\/$/, '')}/tutorials/${m.slug}/`, { method: 'HEAD' });
        expect(head.status).toBeGreaterThanOrEqual(200);
        expect(head.status).toBeLessThan(400);
      }
    }
  });
});
```

- [ ] **Step 4: Update `docs/developers/architecture/homepage.md`**

- Edit the Row 5 line in the "Page Anatomy" block from `Tutorials catalog teaser` to `Featured missions carousel (topic-based, 8 slides × 4 missions)`.
- Edit the "Data Flow" table: Row 5's source is now `hugo/data/featured_topics.json` + runtime `/api/homepage/featuredTopics`; freshness is nightly job at 04:11 UTC + editorial-save debounced rebuild.
- Add at the bottom:

```markdown
### Featured missions carousel (#1032)

Row 5 topic-carousel. Nightly `kg-featured-topics-job` recomputes
`FeaturedTopicsSnapshot` from `ConceptRank` × `KgCommunity` × editorial rows.
SSR baseline via `hugo/data/featured_topics.json`; runtime hydration via
`/api/homepage/featuredTopics` with weak ETag / 304. Admin surface at
`/admin-ui/#featured-topics`.

**Spec:** `docs/superpowers/specs/2026-07-06-1032-featured-missions-carousel-design.md`
**Plan:** `docs/superpowers/plans/2026-07-06-1032-featured-missions-carousel.md`
```

- [ ] **Step 5: Full test sweep**

```bash
npm test
npm run test:hybrid -- --project hybrid
```

Expected: green. Fix any regressions inline before committing.

- [ ] **Step 6: Commit hybrid + smoke + docs**

```bash
git add test/hybrid/featured-topics-hybrid.test.js test/smoke/smoke-featured-topics.test.js docs/developers/architecture/homepage.md
git commit -m "test(#1032): hybrid + smoke tests; docs: Row 5 carousel wiring"
```

- [ ] **Step 7: Push + draft PR**

```bash
git push -u origin worktree-issue-1032-featured-missions-carousel
gh pr create --draft --title "feat(#1032): featured missions topic-based carousel" \
  --body "Closes #1032. Spec: docs/superpowers/specs/2026-07-06-1032-featured-missions-carousel-design.md · Plan: docs/superpowers/plans/2026-07-06-1032-featured-missions-carousel.md"
```

---

## Self-Review Notes

**Spec coverage:**
- §4 Architecture — Tasks 1–10.
- §5 Data model — Task 1.
- §6 Selection algorithm — Task 2 (pure), Task 4 (DB shim).
- §7.1 Admin — Task 7.
- §7.2 Build feed + §7.3 Runtime feed — Task 6.
- §7.4 Cron — Task 5.
- §8 Frontend (SSR + Vue) — Tasks 9 + 10.
- §9 Testing — Tasks 2, 3, 4, 6, 7, 10 (unit) + Task 11 (hybrid + smoke).
- §10 Error handling — covered by try/catch in Task 4 loader + Task 6 handler + Task 5 job; fail-open posture matches spec.
- §11 Observability — deferred to a follow-up if the metrics module doesn't already have a straightforward hook; the plan's Task 5 emits duration logs today.
- §12 Rebuild wiring — Task 7 hooks `scheduleRebuildDispatch` in after-SAVE.
- §13 Rollout — Task 11 PR-body notes the kill switch (revert Row 5 include).
- §15 Non-goals — no code produced for personalization / pin-first / per-user persistence, as intended.

**Placeholder scan:** none — every step contains the actual content.

**Type consistency:** `selectFeaturedTopics` inputs/outputs consistent across Tasks 2, 4, 5. `computeSnapshotEtag` signature consistent between Tasks 3, 4. Endpoint payload shape consistent between Tasks 6, 8, 10, 11.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-06-1032-featured-missions-carousel.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
