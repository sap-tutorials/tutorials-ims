# Time-fenced "Top Tutorials" Ranking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a completions-based "Top Tutorials" ranking (90/180/360-day windows, default 180) by evolving the existing PageRank Featured-missions carousel into one carousel that flips between two modes.

**Architecture:** Mirror the featured-topics snapshot pattern end-to-end: a nightly job materializes a `TopTutorialsSnapshot` sidecar (top-8 per window) from windowed `TaskRecords` completion counts; a cached, ETag-aware `HomepageService.topTutorials()` function serves all three windows under the anonymous `/homepage/*` namespace; the existing `featured-topics-carousel` Vue island gains a mode toggle + window selector and lazily fetches the Top Tutorials payload.

**Tech Stack:** SAP CAP (Node.js, `@sap/cds`), CDS QL, SAP HANA Cloud (hybrid) / SQLite (unit), Hugo, Vue 3 islands (`hugo-apps`), Vitest.

**Spec:** `docs/superpowers/specs/2026-08-14-top-tutorials-ranking-design.md`

## Global Constraints

- **Metric:** raw completion records; `status IN ('COMPLETED','SUPERSEDED')`, `taskType='TUTORIAL'`; NO per-user dedup. Top-8 per window; windows `[90,180,360]`, default 180.
- **Window predicate binds a JS-computed `Date` cutoff** via `.and(\`completionDate >=\`, cutoff)` — NEVER HANA `ADD_DAYS`/`CURRENT_DATE`. This keeps the aggregation cross-adapter (runs on SQLite unit + HANA hybrid). Precedent: `srv/admin-service.js` `exportMissionCompletions`.
- **CAP rules:** never write raw SQL except the sanctioned LOB-safe description SELECT (featured-topics precedent); never SELECT a HANA BLOB/NCLOB alongside metadata in one CDS QL query; the anonymous endpoint lives under `/homepage/*` (route `^/homepage/(.*)$` is already `authenticationType:none`) — NOT `/api/*`.
- **Slugs are lowercase canonical** — lowercase every slug on read/compare (`lower()` helper).
- **HANA folds unquoted identifiers to UPPERCASE only in raw SQL** — CDS QL preserves alias casing; the one raw SELECT uses quoted UPPERCASE identifiers.
- **Cron:** off-minute; `53 4 * * *` (04:53 UTC) is free (verified against `registerJobs()`).
- **After adding any `db/**/*.cds`:** run `npx cds deploy --to sqlite::memory:` before committing.
- **`srv/lib/` change → re-walk the `srv-qa` `cp` list** in `.deploy/mta.yaml` for transitive `./` imports (QA boot crashes on a missing dep).
- **Frontend:** we EVOLVE the existing `featured-topics-carousel` island — do NOT add a new Vite entry / island-src line / `hugo/data` file. Featured mode's SSR path stays byte-compatible (no regression). User-facing UI change → add a committed `test/e2e` spec.
- **hugo-apps Vue tests run from repo root:** `npx vitest run --project unit <path>`.
- **Branch `feat/1782-top-tutorials` (off `origin/DEV`); PR targets `DEV`.** Frequent commits — one per task.

---

### Task 1: Sidecar entity `TopTutorialsSnapshot`

**Files:**
- Create: `db/homepage-top-tutorials.cds`

**Interfaces:**
- Produces: entity `com.sap.developers.ims.TopTutorialsSnapshot` with key `(windowDays, rank)` and fields `slug`, `completions`, `computedAt`. HANA table name → `COM_SAP_DEVELOPERS_IMS_TOPTUTORIALSSNAPSHOT`.

- [ ] **Step 1: Create the CDS file**

```cds
// db/homepage-top-tutorials.cds — issue #1782 (time-fenced Top Tutorials ranking).
// Nightly-materialized top-N tutorials by raw completion count, per rolling
// window (90/180/360 days). Mirrors the FeaturedTopicsSnapshot derived-table
// convention (no cuid/managed; computedAt captures batch time; kept off OData).
// Spec: docs/superpowers/specs/2026-08-14-top-tutorials-ranking-design.md

namespace com.sap.developers.ims;

@cds.autoexpose: false
entity TopTutorialsSnapshot {
  key windowDays  : Integer;      // 90 | 180 | 360
  key rank        : Integer;      // 1..8
      slug        : String(255);  // matches Tutorials.slug width
      completions : Integer;      // raw count in window
      computedAt  : Timestamp;
}
```

- [ ] **Step 2: Verify the model compiles + deploys to SQLite**

Run: `npx cds deploy --to sqlite::memory:`
Expected: exits 0, no schema errors. (Confirms the new entity integrates with the existing model.)

- [ ] **Step 3: Commit**

```bash
git add db/homepage-top-tutorials.cds
git commit -m "feat(1782): add TopTutorialsSnapshot sidecar entity"
```

---

### Task 2: Pure ranking helper `selectTopN`

**Files:**
- Create: `srv/lib/top-tutorials-selection.js`
- Test: `test/unit/top-tutorials-selection.test.js`

**Interfaces:**
- Produces: `selectTopN(groupedRows, slugByLegacyId, topN)` → `Array<{ slug, completions, lastCompletion }>` sorted `completions DESC, lastCompletion DESC, slug ASC`, length ≤ `topN`. Skips rows whose `taskLegacyId` is absent from `slugByLegacyId` (orphaned/inactive tutorials). `groupedRows` element shape: `{ taskLegacyId, completions, lastCompletion }`.

- [ ] **Step 1: Write the failing test**

```js
// test/unit/top-tutorials-selection.test.js
import { describe, it, expect } from 'vitest';
import { selectTopN } from '../../srv/lib/top-tutorials-selection.js';

const slugMap = new Map([[10, 'a-tut'], [20, 'b-tut'], [30, 'c-tut']]);

describe('selectTopN', () => {
  it('ranks by completions desc, then lastCompletion desc, then slug asc', () => {
    const rows = [
      { taskLegacyId: 10, completions: 5, lastCompletion: '2026-01-01T00:00:00Z' },
      { taskLegacyId: 20, completions: 9, lastCompletion: '2026-02-01T00:00:00Z' },
      { taskLegacyId: 30, completions: 5, lastCompletion: '2026-03-01T00:00:00Z' },
    ];
    const out = selectTopN(rows, slugMap, 8);
    expect(out.map(r => r.slug)).toEqual(['b-tut', 'c-tut', 'a-tut']); // 9; then 5/Mar; then 5/Jan
  });

  it('breaks a completions+date tie by slug asc', () => {
    const rows = [
      { taskLegacyId: 20, completions: 4, lastCompletion: '2026-01-01T00:00:00Z' },
      { taskLegacyId: 10, completions: 4, lastCompletion: '2026-01-01T00:00:00Z' },
    ];
    expect(selectTopN(rows, slugMap, 8).map(r => r.slug)).toEqual(['a-tut', 'b-tut']);
  });

  it('drops rows whose legacyId is not an active tutorial', () => {
    const rows = [
      { taskLegacyId: 10, completions: 3, lastCompletion: '2026-01-01T00:00:00Z' },
      { taskLegacyId: 999, completions: 100, lastCompletion: '2026-01-01T00:00:00Z' },
    ];
    expect(selectTopN(rows, slugMap, 8).map(r => r.slug)).toEqual(['a-tut']);
  });

  it('caps at topN', () => {
    const rows = [10, 20, 30].map((id, i) => ({ taskLegacyId: id, completions: 10 - i, lastCompletion: '2026-01-01T00:00:00Z' }));
    expect(selectTopN(rows, slugMap, 2)).toHaveLength(2);
  });

  it('coerces string/HANA-typed completions to numbers', () => {
    const rows = [{ taskLegacyId: 10, completions: '7', lastCompletion: '2026-01-01T00:00:00Z' }];
    expect(selectTopN(rows, slugMap, 8)[0].completions).toBe(7);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/top-tutorials-selection.test.js`
Expected: FAIL — cannot find module `top-tutorials-selection.js`.

- [ ] **Step 3: Write minimal implementation**

```js
// srv/lib/top-tutorials-selection.js
// Pure ranking core for the Top Tutorials carousel (issue #1782). No DB — the
// caller supplies DB-grouped rows + an active-tutorial slug map so this is
// unit-testable and cross-adapter.

const lower = (x) => (x == null ? x : String(x).toLowerCase());

/**
 * @param {Array<{taskLegacyId:number, completions:number|string, lastCompletion:string|Date}>} groupedRows
 * @param {Map<number,string>} slugByLegacyId  active tutorial legacyId → lowercased slug
 * @param {number} topN
 * @returns {Array<{slug:string, completions:number, lastCompletion:(string|Date)}>}
 */
export function selectTopN(groupedRows, slugByLegacyId, topN) {
  const mapped = [];
  for (const r of groupedRows || []) {
    const slug = slugByLegacyId.get(r.taskLegacyId);
    if (!slug) continue; // orphaned legacyId or inactive/retired tutorial
    mapped.push({
      slug: lower(slug),
      completions: Number(r.completions) || 0,
      lastCompletion: r.lastCompletion,
    });
  }
  mapped.sort((a, b) =>
    (b.completions - a.completions) ||
    (new Date(b.lastCompletion).getTime() - new Date(a.lastCompletion).getTime()) ||
    a.slug.localeCompare(b.slug));
  return mapped.slice(0, topN);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/top-tutorials-selection.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add srv/lib/top-tutorials-selection.js test/unit/top-tutorials-selection.test.js
git commit -m "feat(1782): pure selectTopN ranking helper"
```

---

### Task 3: Snapshot lib — `recomputeSnapshot` + `readSnapshotForFeed`

**Files:**
- Create: `srv/lib/top-tutorials-snapshot.js`
- Test: `test/unit/top-tutorials-snapshot.test.js`

**Interfaces:**
- Consumes: `selectTopN` (Task 2); `decodeDescription` (imported from `./featured-topics-snapshot.js`).
- Produces:
  - `WINDOWS = [90, 180, 360]`, `TOP_N = 8` (exported).
  - `recomputeSnapshot(tx)` → `{ count, computedAt: Date }`. Per window: groups completed TUTORIAL `TaskRecords` by `taskLegacyId` with a JS-`Date` cutoff, maps to active-tutorial slugs, takes top-8, then `DELETE.from(TopTutorialsSnapshot)` + one `INSERT` of all rows.
  - `readSnapshotForFeed(tx)` → `{ computedAt: Date|null, etag: string, windows: Array<{ windowDays, items: Array<{ rank, slug, completions, card }> }> }`. `card` = `{ slug, title, description, level, time, primaryTag, href, isNew }`.
  - `computeTopTutorialsEtag({ computedAt, rows })` → weak ETag string.

- [ ] **Step 1: Write the failing test** (runs on in-memory SQLite via `cds.test`)

```js
// test/unit/top-tutorials-snapshot.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
import { recomputeSnapshot, readSnapshotForFeed, WINDOWS, TOP_N } from '../../srv/lib/top-tutorials-snapshot.js';

const NS = 'com.sap.developers.ims';
const DAY_MS = 24 * 60 * 60 * 1000;
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

cds.test(__dirname + '/../..', '--in-memory');

async function seed() {
  const db = await cds.connect.to('db');
  const { Tutorials, TaskRecords, Users, TopTutorialsSnapshot } = cds.entities(NS);
  await db.run(DELETE.from(TopTutorialsSnapshot));
  await db.run(DELETE.from(TaskRecords));
  await db.run(DELETE.from(Tutorials));
  // Active tutorials (legacyId → slug). t-inactive is INACTIVE and must be excluded.
  await db.run(INSERT.into(Tutorials).entries([
    { ID: cds.utils.uuid(), legacyId: 1, slug: 't-popular', title: 'Popular', status: 'ACTIVE', description: 'd1' },
    { ID: cds.utils.uuid(), legacyId: 2, slug: 't-mid',     title: 'Mid',     status: null,     description: 'd2' },
    { ID: cds.utils.uuid(), legacyId: 3, slug: 't-inactive',title: 'Inactive',status: 'INACTIVE', description: 'd3' },
  ]));
  const uid = cds.utils.uuid();
  await db.run(INSERT.into(Users).entries([{ ID: uid }]));
  const rec = (legacyId, status, msAgo) => ({
    ID: cds.utils.uuid(), user_ID: uid, taskType: 'TUTORIAL', taskLegacyId: legacyId,
    status, completionDate: iso(msAgo),
  });
  await db.run(INSERT.into(TaskRecords).entries([
    // t-popular: 3 completions inside 90d (incl one SUPERSEDED — must count)
    rec(1, 'COMPLETED', 5 * DAY_MS), rec(1, 'COMPLETED', 10 * DAY_MS), rec(1, 'SUPERSEDED', 20 * DAY_MS),
    // t-mid: 1 completion inside 90d, +1 at 200d (only in the 360 window)
    rec(2, 'COMPLETED', 15 * DAY_MS), rec(2, 'COMPLETED', 200 * DAY_MS),
    // t-inactive: 50 completions inside 90d — must be EXCLUDED (inactive tutorial)
    ...Array.from({ length: 50 }, () => rec(3, 'COMPLETED', 1 * DAY_MS)),
    // noise: an IN_PROGRESS row (no completionDate window meaning) must not count
    { ID: cds.utils.uuid(), user_ID: uid, taskType: 'TUTORIAL', taskLegacyId: 1, status: 'IN_PROGRESS', completionDate: null },
  ]));
}

describe('top-tutorials-snapshot', () => {
  beforeAll(seed);

  it('materializes top-N per window, counting SUPERSEDED, excluding inactive tutorials', async () => {
    const tx = cds.tx({});
    const { count } = await recomputeSnapshot(tx);
    await tx.commit();
    expect(WINDOWS).toEqual([90, 180, 360]);
    expect(count).toBeGreaterThan(0);

    const feed = await readSnapshotForFeed(cds.tx({}));
    const w90 = feed.windows.find(w => w.windowDays === 90).items;
    // t-popular (3) ranks above t-mid (1); t-inactive excluded entirely.
    expect(w90.map(i => i.slug)).toEqual(['t-popular', 't-mid']);
    expect(w90[0].completions).toBe(3);
    expect(w90.every(i => i.slug !== 't-inactive')).toBe(true);
    // 360-day window sees t-mid's extra 200d completion → 2.
    const w360 = feed.windows.find(w => w.windowDays === 360).items;
    expect(w360.find(i => i.slug === 't-mid').completions).toBe(2);
    // hydrated card carries title + description + href.
    expect(w90[0].card.title).toBe('Popular');
    expect(w90[0].card.href).toBe('/tutorials/t-popular');
  });

  it('recompute is idempotent (atomic replace, not append)', async () => {
    const tx1 = cds.tx({}); await recomputeSnapshot(tx1); await tx1.commit();
    const before = (await readSnapshotForFeed(cds.tx({}))).windows.find(w => w.windowDays === 90).items.length;
    const tx2 = cds.tx({}); await recomputeSnapshot(tx2); await tx2.commit();
    const after = (await readSnapshotForFeed(cds.tx({}))).windows.find(w => w.windowDays === 90).items.length;
    expect(after).toBe(before);
    expect(after).toBeLessThanOrEqual(TOP_N);
  });

  it('empty table → empty windows + stable etag, no throw', async () => {
    const db = await cds.connect.to('db');
    await db.run(DELETE.from(cds.entities(NS).TopTutorialsSnapshot));
    const feed = await readSnapshotForFeed(cds.tx({}));
    expect(feed.windows).toEqual([]);
    expect(typeof feed.etag).toBe('string');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/top-tutorials-snapshot.test.js`
Expected: FAIL — cannot find module `top-tutorials-snapshot.js`.

- [ ] **Step 3: Write the implementation**

```js
// srv/lib/top-tutorials-snapshot.js
// Issue #1782 — completions-based Top Tutorials ranking. Mirrors
// featured-topics-snapshot.js: recompute (write) + readForFeed (read+hydrate+etag).
// Window predicate binds a JS Date cutoff (cross-adapter; no HANA ADD_DAYS).
import cds from '@sap/cds';
import { createHash } from 'node:crypto';
import { selectTopN } from './top-tutorials-selection.js';
import { decodeDescription } from './featured-topics-snapshot.js';

const NS = 'com.sap.developers.ims';
const LOG = cds.log('top-tutorials');
const DAY_MS = 24 * 60 * 60 * 1000;

export const WINDOWS = [90, 180, 360];
export const TOP_N = 8;

const lower = (x) => (x == null ? x : String(x).toLowerCase());

export function computeTopTutorialsEtag({ computedAt, rows }) {
  const canonical = [
    new Date(computedAt || 0).toISOString(),
    ...[...rows]
      .sort((a, b) => (a.windowDays - b.windowDays) || (a.rank - b.rank))
      .map(r => `${r.windowDays}:${r.rank}:${r.slug}:${r.completions}`),
  ].join('|');
  return `W/"${createHash('sha1').update(canonical).digest('hex')}"`;
}

// Active tutorial legacyId → lowercased slug (excludes INACTIVE/DELETED).
async function loadActiveSlugMap(tx) {
  const { Tutorials } = cds.entities(NS);
  const rows = await tx.run(SELECT.from(Tutorials).columns('legacyId', 'slug').where(`status = 'ACTIVE' or status is null`));
  const map = new Map();
  for (const r of rows) if (r.legacyId != null && r.slug) map.set(r.legacyId, lower(r.slug));
  return map;
}

export async function recomputeSnapshot(tx) {
  const { TaskRecords, TopTutorialsSnapshot } = cds.entities(NS);
  const slugByLegacyId = await loadActiveSlugMap(tx);
  const now = Date.now();
  const computedAtIso = new Date(now).toISOString();

  const outRows = [];
  for (const windowDays of WINDOWS) {
    const cutoff = new Date(now - windowDays * DAY_MS);
    // Group by taskLegacyId in SQL (no association needed). count(*)/max()/groupBy
    // are cross-adapter (proven by TutorialCompletionStats). The window predicate
    // binds a JS Date — NOT ADD_DAYS — so this runs on SQLite + HANA identically.
    const grouped = await tx.run(
      SELECT.from(TaskRecords)
        .columns('taskLegacyId', 'count(*) as completions', 'max(completionDate) as lastCompletion')
        .where({ taskType: 'TUTORIAL', status: { in: ['COMPLETED', 'SUPERSEDED'] } })
        .and(`completionDate >=`, cutoff)
        .groupBy('taskLegacyId'),
    );
    const ranked = selectTopN(grouped, slugByLegacyId, TOP_N);
    ranked.forEach((r, i) => outRows.push({
      windowDays, rank: i + 1, slug: r.slug, completions: r.completions, computedAt: computedAtIso,
    }));
  }

  // Atomic replace within the caller's tx (mirrors featured-topics recompute).
  await tx.run(DELETE.from(TopTutorialsSnapshot));
  if (outRows.length) await tx.run(INSERT.into(TopTutorialsSnapshot).entries(outRows));
  LOG.info(`recomputeSnapshot wrote ${outRows.length} rows across ${WINDOWS.length} windows`);
  return { count: outRows.length, computedAt: new Date(computedAtIso) };
}

export async function readSnapshotForFeed(tx) {
  const { TopTutorialsSnapshot } = cds.entities(NS);
  const rows = await tx.run(SELECT.from(TopTutorialsSnapshot).orderBy('windowDays asc', 'rank asc'));
  if (!rows.length) {
    return { computedAt: null, etag: computeTopTutorialsEtag({ computedAt: new Date(0), rows: [] }), windows: [] };
  }

  const slugList = [...new Set(rows.map(r => lower(r.slug)))];
  const cardBySlug = await hydrateTutorialCards(tx, slugList);

  const byWindow = new Map();
  for (const r of rows) {
    if (!byWindow.has(r.windowDays)) byWindow.set(r.windowDays, []);
    byWindow.get(r.windowDays).push({
      rank: r.rank,
      slug: lower(r.slug),
      completions: r.completions,
      card: cardBySlug.get(lower(r.slug)) || null,
    });
  }
  const windows = [...byWindow.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([windowDays, items]) => ({ windowDays, items: items.filter(i => i.card) }));

  return {
    computedAt: new Date(rows[0].computedAt),
    etag: computeTopTutorialsEtag({ computedAt: rows[0].computedAt, rows }),
    windows,
  };
}

// Tutorial-only card hydration (top tutorials are never missions). LOB-safe
// description fetch on HANA (separate query) to avoid LOB-locator expiry —
// mirrors featured-topics-snapshot.readSnapshotForFeed.
async function hydrateTutorialCards(tx, slugList) {
  const { Tutorials } = cds.entities(NS);
  const cardBySlug = new Map();
  if (!slugList.length) return cardBySlug;

  const tRows = await tx.run(SELECT.from(Tutorials)
    .columns('slug', 'title', 'experienceTag', 'averageTimeToComplete', 'primaryTag')
    .where({ slug: { in: slugList } })
    .and(`status = 'ACTIVE' or status is null`));

  const db = await cds.connect.to('db');
  const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
  let descBySlug = new Map();
  if (isHana) {
    const placeholders = slugList.map(() => '?').join(',');
    const descRows = await db.run(
      `SELECT "SLUG", "DESCRIPTION" FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALS" WHERE "SLUG" IN (${placeholders})`,
      slugList,
    );
    descBySlug = new Map(descRows.map(r => [lower(r.SLUG ?? r.slug), decodeDescription(r.DESCRIPTION ?? r.description)]));
  } else {
    const descRows = await tx.run(SELECT.from(Tutorials).columns('slug', 'description').where({ slug: { in: slugList } }));
    descBySlug = new Map(descRows.map(r => [lower(r.slug), r.description || '']));
  }

  for (const c of tRows) {
    const slug = lower(c.slug);
    cardBySlug.set(slug, {
      slug,
      title: c.title,
      description: descBySlug.get(slug) || '',
      level: c.experienceTag || null,
      time: c.averageTimeToComplete || null,
      primaryTag: c.primaryTag || null,
      href: `/tutorials/${slug}`,
      isNew: false,
    });
  }
  return cardBySlug;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/top-tutorials-snapshot.test.js`
Expected: PASS (3 tests). If the `count(*) as completions` alias comes back upper-cased on SQLite (unlikely with CDS QL), adjust `selectTopN`'s read to `r.completions ?? r.COMPLETIONS` — but verify first; CDS QL preserves alias casing.

- [ ] **Step 5: Commit**

```bash
git add srv/lib/top-tutorials-snapshot.js test/unit/top-tutorials-snapshot.test.js
git commit -m "feat(1782): TopTutorials snapshot recompute + readForFeed + etag"
```

---

### Task 4: Nightly job + scheduler registration

**Files:**
- Create: `srv/jobs/top-tutorials-job.js`
- Modify: `srv/jobs/scheduler.js` (add an import near the other job imports ~line 56, and a `registerJob({...})` call inside `registerJobs()`)
- Test: `test/unit/top-tutorials-job.test.js`

**Interfaces:**
- Consumes: `recomputeSnapshot` (Task 3).
- Produces: `runTopTutorials(logId)` → `{ count, computedAt }`; throws on error (fail-open at read time; scheduler chassis records FAILED). Registered as job `top-tutorials`, cron `53 4 * * *`.

- [ ] **Step 1: Write the failing test**

```js
// test/unit/top-tutorials-job.test.js
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../srv/lib/top-tutorials-snapshot.js', () => ({
  recomputeSnapshot: vi.fn(async () => ({ count: 24, computedAt: new Date('2026-08-14T00:00:00Z') })),
}));

// cds.tx(fn) must invoke the callback and return its result.
vi.mock('@sap/cds', () => ({
  default: {
    log: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    tx: async (fn) => fn({}),
  },
}));

import { runTopTutorials } from '../../srv/jobs/top-tutorials-job.js';
import { recomputeSnapshot } from '../../srv/lib/top-tutorials-snapshot.js';

describe('runTopTutorials', () => {
  it('runs recompute in a tx and returns its summary', async () => {
    const out = await runTopTutorials('log-1');
    expect(recomputeSnapshot).toHaveBeenCalledOnce();
    expect(out.count).toBe(24);
  });

  it('propagates a recompute failure (fail-open handled by chassis + readers)', async () => {
    recomputeSnapshot.mockRejectedValueOnce(new Error('HANA blip'));
    await expect(runTopTutorials('log-2')).rejects.toThrow('HANA blip');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/top-tutorials-job.test.js`
Expected: FAIL — cannot find module `top-tutorials-job.js`.

- [ ] **Step 3: Write the job** (mirrors `srv/jobs/kg-featured-topics-job.js`)

```js
// srv/jobs/top-tutorials-job.js
// Nightly rebuild of TopTutorialsSnapshot at 04:53 UTC. Issue #1782.
// Fail-open: on error the snapshot table is left untouched (atomic replace
// inside recomputeSnapshot's tx) and readers keep yesterday's rows.
// Spec: docs/superpowers/specs/2026-08-14-top-tutorials-ranking-design.md
import cds from '@sap/cds';
import { recomputeSnapshot } from '../lib/top-tutorials-snapshot.js';

const LOG = cds.log('top-tutorials');

export async function runTopTutorials(_logId) {
  const started = Date.now();
  try {
    const { count, computedAt } = await cds.tx(async (tx) => recomputeSnapshot(tx));
    LOG.info(`snapshot rewritten in ${Date.now() - started}ms — ${count} rows at ${computedAt.toISOString()}`);
    return { count, computedAt };
  } catch (err) {
    LOG.error(`snapshot rebuild failed after ${Date.now() - started}ms — table left untouched`, err);
    throw err;
  }
}
```

- [ ] **Step 4: Register the job in the scheduler**

In `srv/jobs/scheduler.js`, add the import beside the other job imports (near line 56, after the `kg-featured-topics-job` import):

```js
import { runTopTutorials } from './top-tutorials-job.js';
```

Then inside `registerJobs()` (beside the other `registerJob({...})` calls — place it after the `kg-featured-topics` registration), add:

```js
  // Daily at 04:53 UTC — rebuild the Top Tutorials completions ranking sidecar (#1782).
  registerJob({
    jobName: 'top-tutorials',
    schedule: '53 4 * * *',
    ttlMs: 600000,
    description: 'Rebuild TopTutorials ranking from windowed completions',
    fn: (logId) => runTopTutorials(logId),
  });
```

- [ ] **Step 5: Run test to verify it passes + confirm no duplicate cron**

Run: `npx vitest run test/unit/top-tutorials-job.test.js`
Expected: PASS (2 tests).

Confirm the cron minute is unused (should print exactly one line — the one you added):
Run: `grep -n "'53 4 \* \* \*'" srv/jobs/scheduler.js`
Expected: one match (`top-tutorials`). If two, pick another free off-minute in the 04:xx cluster (e.g. `41 4 * * *`) and update.

- [ ] **Step 6: Commit**

```bash
git add srv/jobs/top-tutorials-job.js srv/jobs/scheduler.js test/unit/top-tutorials-job.test.js
git commit -m "feat(1782): nightly TopTutorials job at 04:53 UTC"
```

---

### Task 5: `HomepageService.topTutorials()` endpoint

**Files:**
- Modify: `srv/homepage-service.cds` (add types + function declaration next to `featuredTopics()`)
- Modify: `srv/homepage-service.js` (add `_state.tt` cache, `resetTtCache()`, `_getTopTutorialsPayload()`, and the `this.on('topTutorials', …)` handler; extend `_resetForTests()`)
- Test: `test/unit/homepage-top-tutorials-endpoint.test.js`

**Interfaces:**
- Consumes: `readSnapshotForFeed` (Task 3).
- Produces: OData function `topTutorials()` at `/homepage/topTutorials()` returning `TopTutorialsPayload { computedAt, etag, windows: many TopTutorialsWindow }`; 60s in-process cache; `If-None-Match` → 304 with `ETag` + `Cache-Control: public, max-age=60`. `resetTtCache()` exported.

- [ ] **Step 1: Add the CDS types + function** in `srv/homepage-service.cds`

Next to the `featuredTopics()` declaration (`function featuredTopics() returns FeaturedTopicsPayload;` ~line 162), add:

```cds
  // (#1782) Time-fenced Top Tutorials ranking. Public — no auth. 60s cache; ETag.
  // Returns all three windows (90/180/360) in one payload so the island's
  // window selector switches client-side with no refetch.
  type TopTutorialCard {
    slug: String; title: String; description: String; level: String;
    time: Integer; primaryTag: String; href: String; isNew: Boolean;
  }
  type TopTutorialItem   { rank: Integer; slug: String; completions: Integer; card: TopTutorialCard; }
  type TopTutorialsWindow { windowDays: Integer; items: many TopTutorialItem; }
  type TopTutorialsPayload { computedAt: Timestamp; etag: String; windows: many TopTutorialsWindow; }
  function topTutorials() returns TopTutorialsPayload;
```

- [ ] **Step 2: Write the failing test**

```js
// test/unit/homepage-top-tutorials-endpoint.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

const NS = 'com.sap.developers.ims';
const { GET, POST } = cds.test(__dirname + '/../..', '--in-memory');

async function seed() {
  const db = await cds.connect.to('db');
  const { Tutorials, TaskRecords, Users, TopTutorialsSnapshot } = cds.entities(NS);
  await db.run(DELETE.from(TopTutorialsSnapshot));
  await db.run(DELETE.from(TaskRecords));
  await db.run(DELETE.from(Tutorials));
  await db.run(INSERT.into(Tutorials).entries([
    { ID: cds.utils.uuid(), legacyId: 1, slug: 't-a', title: 'A', status: 'ACTIVE', description: 'da' },
  ]));
  const uid = cds.utils.uuid();
  await db.run(INSERT.into(Users).entries([{ ID: uid }]));
  await db.run(INSERT.into(TaskRecords).entries([
    { ID: cds.utils.uuid(), user_ID: uid, taskType: 'TUTORIAL', taskLegacyId: 1, status: 'COMPLETED', completionDate: new Date().toISOString() },
  ]));
}

describe('GET /homepage/topTutorials()', () => {
  beforeAll(async () => {
    await seed();
    const { runTopTutorials } = await import('../../srv/jobs/top-tutorials-job.js');
    const { resetTtCache } = await import('../../srv/homepage-service.js');
    await runTopTutorials('test');
    resetTtCache();
  });

  it('returns windows with hydrated cards + an ETag', async () => {
    const res = await GET`/homepage/topTutorials()`;
    expect(res.status).toBe(200);
    expect(res.headers.etag).toBeTruthy();
    const windows = res.data.windows ?? res.data.value?.[0]?.windows;
    const w180 = windows.find(w => w.windowDays === 180);
    expect(w180.items[0].slug).toBe('t-a');
    expect(w180.items[0].card.title).toBe('A');
    expect(w180.items[0].completions).toBe(1);
  });

  it('honors If-None-Match with a 304', async () => {
    const first = await GET`/homepage/topTutorials()`;
    const etag = first.headers.etag;
    await expect(GET(`/homepage/topTutorials()`, { headers: { 'If-None-Match': etag } }))
      .rejects.toMatchObject({ response: { status: 304 } });
  });
});
```

- [ ] **Step 3: Wire the handler** in `srv/homepage-service.js`

Add to `_state` (next to `ft:`):

```js
  // (#1782) 60s cache for topTutorials payload
  tt: { at: 0, payload: null },
```

Extend `_resetForTests()` with `_state.tt = { at: 0, payload: null };`.

Add beside `resetFtCache()`:

```js
/** (#1782) Invalidate the topTutorials in-process cache. */
export function resetTtCache() {
  _state.tt = { at: 0, payload: null };
}
```

Add the payload getter (beside `_getFeaturedTopicsPayload`), importing `readSnapshotForFeed` from `./lib/top-tutorials-snapshot.js` at the top of the file:

```js
const TT_CACHE_MS = 60_000;

async function _getTopTutorialsPayload() {
  const now = Date.now();
  if (_state.tt.payload && (now - _state.tt.at) < TT_CACHE_MS) return _state.tt.payload;
  const tx = cds.tx({});
  try {
    const { computedAt, etag, windows } = await readSnapshotForFeed(tx);
    const payload = { computedAt, etag, windows };
    _state.tt = { at: now, payload };
    return payload;
  } finally {
    await tx.commit();
  }
}
```

Register the handler beside the `featuredTopics` handler (`this.on('featuredTopics', …)`):

```js
    // (#1782) topTutorials() — unbound function with ETag + 304 support.
    // Public (inherits service @requires:'any'). 60s in-process cache via _state.tt.
    this.on('topTutorials', async (req) => {
      const payload = await _getTopTutorialsPayload();
      const inm = req.req?.headers?.['if-none-match'];
      if (inm && inm === payload.etag && req.res) {
        req.res.setHeader('ETag', payload.etag);
        req.res.setHeader('Cache-Control', 'public, max-age=60');
        req.res.status(304).end();
        return req.reject(-1);
      }
      if (req.res) {
        req.res.setHeader('ETag', payload.etag);
        req.res.setHeader('Cache-Control', 'public, max-age=60');
      }
      return payload;
    });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/homepage-top-tutorials-endpoint.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add srv/homepage-service.cds srv/homepage-service.js test/unit/homepage-top-tutorials-endpoint.test.js
git commit -m "feat(1782): /homepage/topTutorials() endpoint with ETag + 60s cache"
```

---

### Task 6: Hybrid (real HANA) aggregation test

**Files:**
- Create: `test/hybrid/top-tutorials-hybrid.test.js`

**Interfaces:**
- Consumes: `recomputeSnapshot`, `readSnapshotForFeed` (Task 3) against a real HANA binding.

This guards adapter/casing/data-volume surprises the SQLite unit harness can't (the `count(*) as completions` alias casing, the LOB-safe raw description SELECT path, and that the JS-`Date` window predicate binds correctly on HANA). Requires `cf login` + `cds bind`; the hybrid project self-skips otherwise.

- [ ] **Step 1: Write the hybrid test**

```js
// test/hybrid/top-tutorials-hybrid.test.js
import { describe, it, expect } from 'vitest';
import cds from '@sap/cds';
import { recomputeSnapshot, readSnapshotForFeed, WINDOWS } from '../../srv/lib/top-tutorials-snapshot.js';

describe('top-tutorials (hybrid / real HANA)', () => {
  it('recompute + readForFeed round-trip on HANA yields well-formed windows', async () => {
    const tx = cds.tx({});
    const { count } = await recomputeSnapshot(tx);
    await tx.commit();
    expect(count).toBeGreaterThanOrEqual(0);

    const feed = await readSnapshotForFeed(cds.tx({}));
    // Every window present has ≤ 8 items, each with a hydrated card (LOB-safe
    // description fetch) and a numeric completions count.
    for (const w of feed.windows) {
      expect(WINDOWS).toContain(w.windowDays);
      expect(w.items.length).toBeLessThanOrEqual(8);
      for (const it of w.items) {
        expect(typeof it.completions).toBe('number');
        expect(it.card.slug).toBe(it.slug);
        expect(typeof it.card.description).toBe('string'); // NCLOB decoded, not a Buffer JSON
      }
    }
    // Wider windows never have fewer completions for the same slug (monotonic).
    const byWin = Object.fromEntries(feed.windows.map(w => [w.windowDays, new Map(w.items.map(i => [i.slug, i.completions]))]));
    if (byWin[90] && byWin[360]) {
      for (const [slug, c90] of byWin[90]) {
        if (byWin[360].has(slug)) expect(byWin[360].get(slug)).toBeGreaterThanOrEqual(c90);
      }
    }
  });
});
```

- [ ] **Step 2: Run against real HANA** (requires `cf login`)

Run: `npx vitest run --project hybrid test/hybrid/top-tutorials-hybrid.test.js`
Expected: PASS (self-skips if no HANA binding). If the `completions` field is `undefined`, the alias came back upper-cased on HANA — fix by reading `r.completions ?? r.COMPLETIONS` in `selectTopN`, re-run unit + hybrid.

- [ ] **Step 3: Commit**

```bash
git add test/hybrid/top-tutorials-hybrid.test.js
git commit -m "test(1782): hybrid HANA round-trip for TopTutorials aggregation"
```

---

### Task 7: `srv-qa` cp-list audit for the new lib

**Files:**
- Modify (if needed): `.deploy/mta.yaml` (`srv-qa` module `cp` list)

`srv/lib/top-tutorials-snapshot.js` imports `./top-tutorials-selection.js` and `./featured-topics-snapshot.js`. QA boot crashes at MTA deploy time on a missing transitive `srv/lib/` dep. Verify all three are copied into the `srv-qa` build.

- [ ] **Step 1: Check whether srv-qa wires this code path at all**

Run: `grep -n "content-store\|top-tutorials\|featured-topics" .deploy/mta.yaml`
Expected: shows the `srv-qa` `cp` entries. `srv-qa` only wires `srv/lib/content-store.js` and its transitive `./` imports (per CLAUDE.md). The Top Tutorials snapshot lib is reached only from `srv/homepage-service.js` + `srv/jobs/`, which the QA container does NOT wire — so **no cp entry is required** unless `content-store.js` transitively imports it (it does not).

- [ ] **Step 2: Confirm content-store's transitive closure is unchanged**

Run: `grep -rn "top-tutorials\|require(\./\|from '\./" srv/lib/content-store.js | head`
Expected: no reference to `top-tutorials-*`. If (unexpectedly) a new `srv/lib/` file becomes reachable from `content-store.js`, add it to the `srv-qa` `cp` list. Otherwise this task is a verified no-op.

- [ ] **Step 3: Commit only if `.deploy/mta.yaml` changed**

```bash
git add .deploy/mta.yaml
git commit -m "chore(1782): add TopTutorials libs to srv-qa cp list"
```

(If no change was needed, record the audit outcome in the PR description instead.)

---

### Task 8: Window-selector localStorage helper

**Files:**
- Create: `hugo-apps/src/featured-topics-carousel/window-storage.ts`
- Test: `hugo-apps/src/featured-topics-carousel/window-storage.test.ts`

**Interfaces:**
- Produces: `WINDOW_OPTIONS = [90, 180, 360] as const`; `DEFAULT_WINDOW = 180`; `readLocalStorageWindow(): number | null` (returns a valid window or null); `writeLocalStorageWindow(w: number): void`.

- [ ] **Step 1: Write the failing test**

```ts
// hugo-apps/src/featured-topics-carousel/window-storage.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { readLocalStorageWindow, writeLocalStorageWindow, DEFAULT_WINDOW, WINDOW_OPTIONS } from './window-storage';

describe('window-storage', () => {
  beforeEach(() => localStorage.clear());

  it('exposes 90/180/360 with a 180 default', () => {
    expect([...WINDOW_OPTIONS]).toEqual([90, 180, 360]);
    expect(DEFAULT_WINDOW).toBe(180);
  });

  it('round-trips a valid window', () => {
    writeLocalStorageWindow(360);
    expect(readLocalStorageWindow()).toBe(360);
  });

  it('returns null for an unset or invalid value', () => {
    expect(readLocalStorageWindow()).toBeNull();
    localStorage.setItem('sap-devs-homepage-top-tutorials-window', '45');
    expect(readLocalStorageWindow()).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit hugo-apps/src/featured-topics-carousel/window-storage.test.ts`
Expected: FAIL — cannot find module `./window-storage`.

- [ ] **Step 3: Write the implementation** (mirrors `homepage-events-band/region-storage.ts`)

```ts
// hugo-apps/src/featured-topics-carousel/window-storage.ts
// #1782 — localStorage persistence for the Top Tutorials window selector.

const KEY = 'sap-devs-homepage-top-tutorials-window';
export const WINDOW_OPTIONS = [90, 180, 360] as const;
export const DEFAULT_WINDOW = 180;

export function readLocalStorageWindow(): number | null {
  try {
    const v = Number(localStorage.getItem(KEY));
    return (WINDOW_OPTIONS as readonly number[]).includes(v) ? v : null;
  } catch {
    return null;
  }
}

export function writeLocalStorageWindow(w: number): void {
  try { localStorage.setItem(KEY, String(w)); } catch { /* private mode */ }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project unit hugo-apps/src/featured-topics-carousel/window-storage.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/featured-topics-carousel/window-storage.ts hugo-apps/src/featured-topics-carousel/window-storage.test.ts
git commit -m "feat(1782): window-selector localStorage helper"
```

---

### Task 9: `useTopTutorials` composable — fetch + build source-labelled slides

**Files:**
- Create: `hugo-apps/src/featured-topics-carousel/composables/useTopTutorials.ts`
- Test: `hugo-apps/src/featured-topics-carousel/composables/useTopTutorials.test.ts`

**Interfaces:**
- Produces:
  - `buildTopTutorialSlides(windows, windowDays, chunkSize = 4): SlideData[]` — pure. Picks the requested window's items, builds a source-labelled tutorial card per item, chunks into slides of `chunkSize`, each slide `displayTitle = 'Top Tutorials · Last ${windowDays} days'`, `conceptSlug = 'top-${windowDays}-${chunkIndex}'`. `SlideData` is the existing `{ conceptSlug, displayTitle, missionsHtml }` shape (imported from `./useHydrate`).
  - `fetchTopTutorials(): Promise<Array<{windowDays, items}>>` — GET `/homepage/topTutorials()`, unwraps OData `{value:[…]}` or bare shape, returns `windows` (or `[]` on any error/304).

- [ ] **Step 1: Write the failing test**

```ts
// hugo-apps/src/featured-topics-carousel/composables/useTopTutorials.test.ts
import { describe, it, expect } from 'vitest';
import { buildTopTutorialSlides } from './useTopTutorials';

const windows = [
  { windowDays: 180, items: [
    { rank: 1, slug: 'a', completions: 1200, card: { slug: 'a', title: 'Build a CAP app', description: 'd', level: 'beginner', time: 30, primaryTag: 'CAP', href: '/tutorials/a', isNew: false } },
    { rank: 2, slug: 'b', completions: 900,  card: { slug: 'b', title: 'Deploy', description: 'd', level: 'intermediate', time: 45, primaryTag: 'BTP', href: '/tutorials/b', isNew: false } },
  ] },
];

describe('buildTopTutorialSlides', () => {
  it('builds a slide per chunk with a window-specific heading', () => {
    const slides = buildTopTutorialSlides(windows, 180, 4);
    expect(slides).toHaveLength(1);
    expect(slides[0].displayTitle).toBe('Top Tutorials · Last 180 days');
    expect(slides[0].conceptSlug).toBe('top-180-0');
  });

  it('renders a source label + completions count + escaped title in each card', () => {
    const html = buildTopTutorialSlides(windows, 180, 4)[0].missionsHtml;
    expect(html).toContain('Top Tutorial');            // per-card source label
    expect(html).toContain('1,200');                    // localized completions
    expect(html).toContain('Build a CAP app');
    expect(html).toContain('href="/tutorials/a"');
  });

  it('chunks into multiple slides beyond chunkSize', () => {
    const many = [{ windowDays: 90, items: Array.from({ length: 6 }, (_, i) => ({
      rank: i + 1, slug: `s${i}`, completions: 10 - i,
      card: { slug: `s${i}`, title: `T${i}`, description: '', level: 'beginner', time: 10, primaryTag: 'X', href: `/tutorials/s${i}`, isNew: false },
    })) }];
    expect(buildTopTutorialSlides(many, 90, 4)).toHaveLength(2); // 6 → [4,2]
  });

  it('returns [] for a window with no data', () => {
    expect(buildTopTutorialSlides(windows, 90, 4)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit hugo-apps/src/featured-topics-carousel/composables/useTopTutorials.test.ts`
Expected: FAIL — cannot find module `./useTopTutorials`.

- [ ] **Step 3: Write the implementation**

```ts
// hugo-apps/src/featured-topics-carousel/composables/useTopTutorials.ts
// #1782 — fetch the Top Tutorials payload and build source-labelled carousel
// slides. Card markup mirrors card-tutorial.html / useHydrate.buildTutorialHtml
// but adds a "Top Tutorial" source label + a localized completions count.
import type { SlideData } from './useHydrate';

export interface TopTutorialItem {
  rank: number; slug: string; completions: number;
  card: { slug: string; title: string; description: string; level: string | null; time: number | null; primaryTag: string | null; href: string; isNew: boolean };
}
export interface TopTutorialWindow { windowDays: number; items: TopTutorialItem[]; }

const FOLDER_SVG = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 13V3h4l2 2h6v8H2z"></path></svg>`;
const CLOCK_SVG  = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="8" cy="8" r="6.5"></circle><path d="M8 4.5V8l2.5 1.5"></path></svg>`;
const TAG_SVG    = `<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M2 3h5l7 7-5 5-7-7V3zm3 2a1 1 0 100 2 1 1 0 000-2z"></path></svg>`;

function esc(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function capFirst(s: string): string { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; }
function formatTime(mins: number): string {
  const m = Math.round(mins);
  if (m < 60) return `${m} min.`;
  const h = Math.floor(m / 60); const rem = m % 60;
  return rem > 0 ? `${h} hr. ${rem} min.` : `${h} hr.`;
}

/** Card markup for a Top Tutorial: source label + completions count. */
function buildTopTutorialCardHtml(it: TopTutorialItem): string {
  const c = it.card;
  const levelLabel = capFirst(c.level || '');
  const timeLabel  = formatTime(Number(c.time) || 0);
  const count      = Number(it.completions || 0).toLocaleString('en-US');
  return `<a href="${esc(c.href || (c.slug ? `/tutorials/${encodeURIComponent(c.slug)}/` : '#'))}" class="nav-card" data-vt-card="navigator">
<div class="nav-card__type nav-card__type--tutorial">TOP TUTORIAL</div>
<h3 class="nav-card__title">${esc(c.title || '')}</h3>
<p class="nav-card__desc">${esc(c.description || '')}</p>
<div class="nav-card__meta">
<span class="nav-card__meta-item">${FOLDER_SVG} ${esc(levelLabel)}</span>
<span class="nav-card__meta-sep">&middot;</span>
<span class="nav-card__meta-item">${CLOCK_SVG} ${esc(timeLabel)}</span>
<span class="nav-card__meta-sep">&middot;</span>
<span class="nav-card__meta-item">${esc(count)} completed</span>
</div>
<div class="nav-card__tag">${TAG_SVG} ${esc(c.primaryTag || '')}</div>
</a>`;
}

/** Pure — build carousel slides for one window from the fetched payload. */
export function buildTopTutorialSlides(windows: TopTutorialWindow[], windowDays: number, chunkSize = 4): SlideData[] {
  const win = (windows || []).find(w => w.windowDays === windowDays);
  const items = win?.items ?? [];
  const slides: SlideData[] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    slides.push({
      conceptSlug: `top-${windowDays}-${i / chunkSize}`,
      displayTitle: `Top Tutorials · Last ${windowDays} days`,
      missionsHtml: items.slice(i, i + chunkSize).map(buildTopTutorialCardHtml).join(''),
    });
  }
  return slides;
}

/** Fetch all three windows once. Returns [] on any error/304 (fail-open). */
export async function fetchTopTutorials(): Promise<TopTutorialWindow[]> {
  try {
    const res = await fetch('/homepage/topTutorials()', { headers: { Accept: 'application/json' }, credentials: 'include' });
    if (!res.ok) return [];
    const body = await res.json();
    return body.windows ?? body.value?.[0]?.windows ?? [];
  } catch {
    return [];
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project unit hugo-apps/src/featured-topics-carousel/composables/useTopTutorials.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/featured-topics-carousel/composables/useTopTutorials.ts hugo-apps/src/featured-topics-carousel/composables/useTopTutorials.test.ts
git commit -m "feat(1782): useTopTutorials composable — fetch + build labelled slides"
```

---

### Task 10: `Carousel.vue` — mode toggle + window selector

**Files:**
- Modify: `hugo-apps/src/featured-topics-carousel/Carousel.vue` (full replacement below)
- Test: `hugo-apps/src/featured-topics-carousel/Carousel.test.ts` (extend)

**Interfaces:**
- Consumes: `buildTopTutorialSlides`, `fetchTopTutorials` (Task 9); `readLocalStorageWindow`, `writeLocalStorageWindow`, `DEFAULT_WINDOW`, `WINDOW_OPTIONS` (Task 8); existing `useAutoAdvance`, `useHydrate`, `useDeepLink`.
- Produces: reactive `mode` (`'featured'|'top'`), `windowDays`; methods `switchMode(m)`, `setWindow(n)` (exposed for tests). Featured mode's slides + SSR path are unchanged.

- [ ] **Step 1: Write the failing test additions**

Append to `hugo-apps/src/featured-topics-carousel/Carousel.test.ts` (keep existing tests):

```ts
import { mount, flushPromises } from '@vue/test-utils';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Carousel from './Carousel.vue';

const TOP_PAYLOAD = { windows: [
  { windowDays: 90,  items: [{ rank: 1, slug: 'x', completions: 3, card: { slug: 'x', title: 'X90', description: '', level: 'beginner', time: 10, primaryTag: 'T', href: '/tutorials/x', isNew: false } }] },
  { windowDays: 180, items: [{ rank: 1, slug: 'y', completions: 7, card: { slug: 'y', title: 'Y180', description: '', level: 'beginner', time: 10, primaryTag: 'T', href: '/tutorials/y', isNew: false } }] },
  { windowDays: 360, items: [{ rank: 1, slug: 'z', completions: 9, card: { slug: 'z', title: 'Z360', description: '', level: 'beginner', time: 10, primaryTag: 'T', href: '/tutorials/z', isNew: false } }] },
] };

function mountCarousel() {
  const root = document.createElement('section');
  return mount(Carousel, { props: {
    root, initialEtag: '',
    initialSlides: [{ conceptSlug: 'feat-1', displayTitle: 'Featured Topic', missionsHtml: '<a class="nav-card">F</a>' }],
  } });
}

describe('Carousel — Top Tutorials mode (#1782)', () => {
  beforeEach(() => {
    localStorage.clear();
    // Featured hydrate + top-tutorials both go through fetch; return the top payload
    // for the topTutorials() call and a 304-ish empty for featured hydrate.
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('topTutorials')) {
        return { ok: true, status: 200, json: async () => TOP_PAYLOAD } as any;
      }
      return { ok: false, status: 304, json: async () => ({}) } as any;
    }));
  });

  it('defaults to Featured mode showing the SSR slide', () => {
    const wrapper = mountCarousel();
    expect(wrapper.vm.mode).toBe('featured');
    expect(wrapper.text()).toContain('Featured Topic');
  });

  it('flips to Top Tutorials, fetches once, defaults to the 180-day window', async () => {
    const wrapper = mountCarousel();
    await wrapper.vm.switchMode('top');
    await flushPromises();
    expect(wrapper.vm.windowDays).toBe(180);
    expect(wrapper.text()).toContain('Top Tutorials · Last 180 days');
    expect(wrapper.text()).toContain('Y180');
  });

  it('switching windows re-renders from cached data with no refetch', async () => {
    const wrapper = mountCarousel();
    await wrapper.vm.switchMode('top');
    await flushPromises();
    const calls = (globalThis.fetch as any).mock.calls.filter((c: any[]) => String(c[0]).includes('topTutorials')).length;
    await wrapper.vm.setWindow(360);
    await flushPromises();
    expect(wrapper.text()).toContain('Z360');
    const after = (globalThis.fetch as any).mock.calls.filter((c: any[]) => String(c[0]).includes('topTutorials')).length;
    expect(after).toBe(calls); // no second topTutorials fetch
    expect(localStorage.getItem('sap-devs-homepage-top-tutorials-window')).toBe('360');
  });

  it('honors a persisted window on first flip', async () => {
    localStorage.setItem('sap-devs-homepage-top-tutorials-window', '90');
    const wrapper = mountCarousel();
    await wrapper.vm.switchMode('top');
    await flushPromises();
    expect(wrapper.vm.windowDays).toBe(90);
    expect(wrapper.text()).toContain('X90');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit hugo-apps/src/featured-topics-carousel/Carousel.test.ts`
Expected: FAIL — `switchMode`/`mode` not defined.

- [ ] **Step 3: Replace `Carousel.vue` with the merged version**

```vue
<template>
  <div class="hp-featured-carousel__body">
    <!-- #1782 mode toggle -->
    <div class="hp-featured-carousel__modeswitch" role="group" aria-label="Ranking mode">
      <button type="button" class="hp-featured-carousel__mode"
              :class="{ 'is-active': mode === 'featured' }"
              :aria-pressed="mode === 'featured'" @click="switchMode('featured')">Featured</button>
      <button type="button" class="hp-featured-carousel__mode"
              :class="{ 'is-active': mode === 'top' }"
              :aria-pressed="mode === 'top'" @click="switchMode('top')">Top Tutorials</button>
    </div>
    <!-- #1782 window selector — only in Top Tutorials mode -->
    <div v-if="mode === 'top'" class="hp-featured-carousel__windows" role="group" aria-label="Time window">
      <button v-for="w in WINDOW_OPTIONS" :key="w" type="button"
              class="hp-featured-carousel__window" :class="{ 'is-active': windowDays === w }"
              :aria-pressed="windowDays === w" @click="setWindow(w)">{{ w }}d</button>
    </div>

    <div class="hp-featured-carousel__viewport" aria-live="polite" tabindex="0" @keydown="onKey">
      <div
        v-for="(slide, i) in displaySlides"
        :key="slide.conceptSlug"
        class="hp-featured-carousel__slide"
        :class="{ 'is-active': i === active, 'hidden': i !== active }"
        :id="'featured-' + slide.conceptSlug"
        role="group"
        aria-roledescription="slide"
        :aria-label="slide.displayTitle + ', slide ' + (i + 1) + ' of ' + displaySlides.length"
      >
        <h3 class="hp-featured-carousel__topic">{{ slide.displayTitle }}</h3>
        <!-- v-html is safe: content is server-sanitized SSR or esc()-escaped in the composables. -->
        <div class="hp-featured-carousel__grid cards" v-html="slide.missionsHtml"></div>
      </div>
      <p v-if="mode === 'top' && displaySlides.length === 0" class="hp-featured-carousel__empty">
        No tutorial completions in the last {{ windowDays }} days yet.
      </p>
    </div>

    <nav class="hp-featured-carousel__controls" aria-label="Carousel controls">
      <button type="button" @click="prev" aria-label="Previous topic">‹</button>
      <button type="button" @click="togglePlay" :aria-pressed="!autoAdvance"
              :aria-label="autoAdvance ? 'Pause auto-advance' : 'Resume auto-advance'">
        {{ autoAdvance ? '⏸' : '▶' }}
      </button>
      <button type="button" @click="next" aria-label="Next topic">›</button>
      <ol class="hp-featured-carousel__dots" role="tablist">
        <li v-for="(slide, i) in displaySlides" :key="slide.conceptSlug" role="presentation">
          <button type="button" role="tab"
                  :aria-selected="i === active ? 'true' : 'false'"
                  :aria-label="'Show ' + slide.displayTitle" @click="userJumpTo(i)"></button>
        </li>
      </ol>
    </nav>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { useAutoAdvance } from './composables/useAutoAdvance';
import { useHydrate } from './composables/useHydrate';
import { useDeepLink } from './composables/useDeepLink';
import { buildTopTutorialSlides, fetchTopTutorials, type TopTutorialWindow } from './composables/useTopTutorials';
import { readLocalStorageWindow, writeLocalStorageWindow, DEFAULT_WINDOW, WINDOW_OPTIONS } from './window-storage';

const props = defineProps<{
  root: HTMLElement;
  initialEtag: string;
  initialSlides: Array<{ conceptSlug: string; displayTitle: string; missionsHtml: string }>;
}>();

type Mode = 'featured' | 'top';
const mode = ref<Mode>('featured');
const windowDays = ref<number>(readLocalStorageWindow() ?? DEFAULT_WINDOW);

const featuredSlides = ref(props.initialSlides);
const topWindows = ref<TopTutorialWindow[]>([]);
const topLoaded = ref(false);

const active = ref(0);
const userPaused = ref(false);
const reducedMotion = ref(
  typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches,
);
const autoAdvance = computed(() => !userPaused.value && !reducedMotion.value);

const displaySlides = computed(() =>
  mode.value === 'featured'
    ? featuredSlides.value
    : buildTopTutorialSlides(topWindows.value, windowDays.value),
);

// Reveal the row as soon as either mode has slides (same fallback contract as #1032).
watch(displaySlides, (next) => {
  if (next.length > 0) props.root.classList.remove('hp-featured-carousel--pending');
}, { immediate: true });

async function switchMode(m: Mode): Promise<void> {
  mode.value = m;
  active.value = 0;
  userPaused.value = true; // a deliberate interaction pauses auto-advance
  if (m === 'top' && !topLoaded.value) {
    topLoaded.value = true;
    topWindows.value = await fetchTopTutorials();
  }
}

function setWindow(w: number): void {
  windowDays.value = w;
  writeLocalStorageWindow(w);
  active.value = 0;
}

function jumpTo(i: number): void {
  if (i < 0 || i >= displaySlides.value.length) return;
  active.value = i;
  if (typeof history !== 'undefined') {
    history.replaceState(null, '', `#featured/${displaySlides.value[i].conceptSlug}`);
  }
}
function next(): void { jumpTo((active.value + 1) % Math.max(1, displaySlides.value.length)); userPaused.value = true; }
function prev(): void { jumpTo((active.value - 1 + displaySlides.value.length) % Math.max(1, displaySlides.value.length)); userPaused.value = true; }
function togglePlay(): void { userPaused.value = !userPaused.value; }
function userJumpTo(i: number): void { jumpTo(i); userPaused.value = true; }
function onKey(e: KeyboardEvent): void {
  if (e.key === 'ArrowLeft') { prev(); e.preventDefault(); }
  else if (e.key === 'ArrowRight') { next(); e.preventDefault(); }
}

useAutoAdvance({
  intervalMs: 8_000,
  enabled: autoAdvance,
  container: () => props.root,
  tick: () => jumpTo((active.value + 1) % Math.max(1, displaySlides.value.length)),
});

// Featured hydration (unchanged): only feeds featuredSlides.
useHydrate({ etag: props.initialEtag, onFresh: (fresh) => { featuredSlides.value = fresh; } });

useDeepLink({
  slides: displaySlides,
  onResolve: (i) => { active.value = i; userPaused.value = true; },
});

defineExpose({ next, prev, jumpTo, userJumpTo, togglePlay, switchMode, setWindow, active, userPaused, autoAdvance, mode, windowDays });
</script>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project unit hugo-apps/src/featured-topics-carousel/Carousel.test.ts`
Expected: PASS — existing Featured tests + 4 new Top Tutorials tests. If `useDeepLink` rejects a computed `slides` ref, wrap it: `useDeepLink({ slides: displaySlides as any, … })` (it only reads `.value`).

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/featured-topics-carousel/Carousel.vue hugo-apps/src/featured-topics-carousel/Carousel.test.ts
git commit -m "feat(1782): carousel mode toggle + window selector"
```

---

### Task 11: Carousel toggle + selector CSS

**Files:**
- Modify: `hugo/assets/css/homepage.css` (add rules in the `.hp-featured-carousel` block)

The mode toggle and window chips are rendered by the Vue component (Task 10); `main.ts` mounts into `[data-vue-root]` after the SSR header, so no Hugo partial change is required. Only styling for the new elements is needed. No-JS visitors keep the SSR Featured slides (toggle is a progressive enhancement).

- [ ] **Step 1: Locate the anchor**

Run: `grep -n "hp-featured-carousel__header\|hp-featured-carousel__controls" hugo/assets/css/homepage.css`
Expected: line numbers for the existing carousel block — add the new rules alongside them.

- [ ] **Step 2: Add the CSS**

Append these rules within the `.hp-featured-carousel` section of `hugo/assets/css/homepage.css`:

```css
/* #1782 — Top Tutorials mode toggle + window selector */
.hp-featured-carousel__modeswitch {
  display: inline-flex;
  gap: 0;
  margin: 0 0 0.75rem;
  border: 1px solid var(--sapField_BorderColor, #89919a);
  border-radius: 0.5rem;
  overflow: hidden;
}
.hp-featured-carousel__mode {
  appearance: none;
  border: 0;
  background: var(--sapField_Background, #fff);
  color: var(--sapContent_LabelColor, #556b82);
  padding: 0.375rem 0.9rem;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}
.hp-featured-carousel__mode.is-active {
  background: var(--sapButton_Selected_Background, #0064d9);
  color: var(--sapButton_Selected_TextColor, #fff);
}
.hp-featured-carousel__windows {
  display: inline-flex;
  gap: 0.375rem;
  margin: 0 0 0.75rem 0.75rem;
}
.hp-featured-carousel__window {
  appearance: none;
  border: 1px solid var(--sapField_BorderColor, #89919a);
  background: var(--sapField_Background, #fff);
  color: var(--sapContent_LabelColor, #556b82);
  border-radius: 1rem;
  padding: 0.25rem 0.75rem;
  font: inherit;
  cursor: pointer;
}
.hp-featured-carousel__window.is-active {
  background: var(--sapButton_Selected_Background, #0064d9);
  color: var(--sapButton_Selected_TextColor, #fff);
  border-color: transparent;
}
.hp-featured-carousel__empty {
  color: var(--sapContent_LabelColor, #556b82);
  padding: 1rem 0;
  margin: 0;
}
```

- [ ] **Step 3: Verify the CSS builds**

Run: `npx vitest run --project unit hugo-apps/src/featured-topics-carousel/Carousel.test.ts`
Expected: still PASS (CSS-only change doesn't affect component logic). Visual confirmation happens in the e2e task / a local `npm run dev`.

- [ ] **Step 4: Commit**

```bash
git add hugo/assets/css/homepage.css
git commit -m "style(1782): mode toggle + window selector styling"
```

---

### Task 12: End-to-end spec (advisory coverage)

**Files:**
- Create: `test/e2e/top-tutorials-carousel.spec.ts`

Per the user-facing-UI e2e nudge, add a Playwright spec exercising the merged carousel. The homepage is anonymous, so no auth is needed. It self-skips when `PLAYWRIGHT_BASE_URL`/`SMOKE_BASE_URL` is absent (matches the existing post-deploy `e2e` job). Follow `test/e2e/README.md` conventions; check an existing spec for the exact `baseURL`/skip idiom before finalizing.

- [ ] **Step 1: Read one existing spec for the harness idiom**

Run: `ls test/e2e && sed -n '1,40p' test/e2e/*.spec.ts | head -60`
Expected: shows how specs read the base URL and self-skip. Mirror it exactly (the block below is the intended shape; align import paths/skip helper to what you find).

- [ ] **Step 2: Write the spec**

```ts
// test/e2e/top-tutorials-carousel.spec.ts
// #1782 — merged Featured / Top Tutorials carousel. Post-deploy only; self-skips
// without a base URL (same posture as the other e2e specs).
import { test, expect } from '@playwright/test';

const BASE = process.env.PLAYWRIGHT_BASE_URL || process.env.SMOKE_BASE_URL;

test.describe('Top Tutorials carousel (#1782)', () => {
  test.skip(!BASE, 'no PLAYWRIGHT_BASE_URL/SMOKE_BASE_URL configured');

  test('flips to Top Tutorials and switches windows', async ({ page }) => {
    await page.goto(BASE!);
    const carousel = page.locator('[data-app="featured-topics-carousel"]');
    await expect(carousel).toBeVisible();

    // Flip to Top Tutorials mode.
    await carousel.getByRole('button', { name: 'Top Tutorials' }).click();

    // Window chips appear; 180 is the default selection.
    const w180 = carousel.getByRole('button', { name: '180d' });
    await expect(w180).toHaveAttribute('aria-pressed', 'true');

    // A top-tutorial card (or the empty-state) renders — either is a valid,
    // non-erroring outcome on a freshly-seeded environment.
    await expect(
      carousel.locator('.nav-card__type--tutorial, .hp-featured-carousel__empty').first(),
    ).toBeVisible();

    // Switching to 90d updates the pressed state without a full navigation.
    await carousel.getByRole('button', { name: '90d' }).click();
    await expect(carousel.getByRole('button', { name: '90d' })).toHaveAttribute('aria-pressed', 'true');
    await expect(w180).toHaveAttribute('aria-pressed', 'false');
  });
});
```

- [ ] **Step 3: Sanity-run (self-skips locally without a base URL)**

Run: `npx playwright test test/e2e/top-tutorials-carousel.spec.ts`
Expected: the test is skipped (no base URL) — confirms the spec parses and the skip guard works. Real execution happens in the post-DEV-deploy `e2e` job.

- [ ] **Step 4: Commit**

```bash
git add test/e2e/top-tutorials-carousel.spec.ts
git commit -m "test(1782): e2e spec for merged Top Tutorials carousel"
```

---

## Deploy checklist (after all tasks green)

- [ ] `npx cds deploy --to sqlite::memory:` clean; `npm test` green (unit).
- [ ] `npx vitest run --project unit hugo-apps/src/featured-topics-carousel/` green.
- [ ] `cds build --production` emits the `TopTutorialsSnapshot` `.hdbtable` artifact (no hand-authored ALTER).
- [ ] Open PR to `DEV`. After DEV deploy, trigger the job once so the sidecar isn't empty on day one: admin `/admin-ui/` JobControls → run `top-tutorials` (or wait for 04:53 UTC).
- [ ] Hybrid + e2e run post-deploy (`--project hybrid`, `e2e` job) — not on the PR.

## Self-Review

**Spec coverage:**
- Merged carousel (flip Featured/Top, per-card source label, window selector 90/180/360 default 180) → Tasks 9, 10, 11.
- Metric: raw completions, `SUPERSEDED` included, active-tutorial filter, top-8 → Tasks 2, 3 (+ hybrid Task 6).
- Sidecar + nightly job @ 04:53 + endpoint → Tasks 1, 4, 5.
- JS-`Date` cutoff (cross-adapter, no `ADD_DAYS`) → Task 3, verified Task 6.
- Featured default / no regression; Top runtime-only → Tasks 10, 11 (SSR path untouched).
- srv-qa cp-list audit → Task 7. No `/api/*` route (stays under `/homepage/*`) → Task 5 (no approuter change).

**Placeholder scan:** no TBD/TODO; every code step carries full content. The two "verify then adjust" notes (alias casing in Tasks 3/6; `useDeepLink` computed ref in Task 10) are explicit contingencies with the exact fix, not placeholders.

**Type consistency:** `selectTopN(groupedRows, slugByLegacyId, topN)` signature identical in Tasks 2 & 3. `readSnapshotForFeed` → `{ computedAt, etag, windows:[{windowDays, items:[{rank,slug,completions,card}]}] }` consistent across Tasks 3, 5, 9, 10. `SlideData` `{conceptSlug,displayTitle,missionsHtml}` reused from `useHydrate` in Task 9/10. CDS `TopTutorialsPayload.windows` (array with `windowDays`) matches the JS payload (Task 5 ↔ Task 3).

