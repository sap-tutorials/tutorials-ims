# URL Health Check for Tutorials, Missions, and Groups — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scan published Tutorials, Missions, and Groups for membership integrity (deleted/inactive items inside active parents) and HTTP reachability of their public URLs, surfaced in a new Admin UI screen and run both nightly and on demand.

**Architecture:** Reuse the existing homepage link-health probe engine (extracted to a shared `srv/lib/link-health-core.js` so both jobs share one tested worker pool) to probe tutorial/mission/group public URLs; persist OK/SLOW/BROKEN per-row on the three entities (latest-run-only, like homepage shelves). Reuse and extend `findUnhealthyEntities()` for membership issues, computed live. Register one scheduler job (nightly + manual via `JobControls.runJob`) and add a two-tab Fiori Elements screen to the admin ToolPage shell.

**Tech Stack:** CAP Node.js (ES modules, `@sap/cds` ≥ 10.1.0), CDS, SAP HANA Cloud (SQLite for unit tests), Fiori Elements (UI5, `sap_horizon`), native `fetch`, Vitest-compatible existing `npm test` runner.

**Spec:** `docs/superpowers/specs/2026-10-15-url-health-check-design.md`

## Global Constraints

- Node native `fetch` only — no axios/node-fetch (CLAUDE.md).
- `cds.ql`/CQL only, never raw SQL (CLAUDE.md). The reused engine already uses `db.run(UPDATE(...))`.
- Never SELECT a HANA BLOB alongside metadata — N/A here; only metadata columns are touched, never `content`.
- Admin service is `@requires:'Admin'`; the new screen's nav entry is `requiredScope:'Admin'`.
- ES module syntax (`import`/`export`) — all `srv/` files are ESM.
- Slugs are lowercase canonical — always `.toLowerCase()` before building a URL or comparing.
- Status "active" predicate is `status == null || status === 'ACTIVE'`; "excluded" is `status ∈ {INACTIVE, DELETED}`.
- Link-status columns mirror the existing `HomepageLinkStatus` pattern: enum `{ OK; SLOW; BROKEN; }` + `default 'UNKNOWN'` + `@assert.range`.
- Scheduler job minute must be an unused off-minute, NOT `:00`/`:30`.
- `srv/lib/` additions: re-walk transitive `./` imports from `srv/lib/content-store.js`; if the new module enters that graph, add it to `.deploy/mta.yaml` `srv-qa` `cp` list (expected: it does NOT).
- Admin-UI changes require a FULL deploy (no `--skip-build`, no `-m` scoping); Step 3.5 bundle-drift gate must pass.

## Review Focus

- **Slug casing in URL build** — a mixed-case slug must probe the lowercased canonical URL, or the public site 301s and the probe mis-reads it. Pinned in Task 3 (`resolveEntityUrl` lowercases).
- **Override honored on re-run** — a row with `linkStatusOverride` set must keep the pinned status and never be re-probed, across repeated scans. Pinned in Task 4 (engine override branch is covered by the reused core; Task 4 asserts the dispatch path respects it).
- **Dedup of shared tutorials** — a tutorial inside multiple groups must yield exactly one probe target. Pinned in Task 3 (`collectHealthTargets` dedups by url).
- **Unpublished/inactive exclusion** — INACTIVE tutorials and unpublished missions/groups must not appear as probe targets. Pinned in Task 3.
- **`not-served` false-negative** — a published tutorial with no `ContentCurrent` row must be flagged, not silently treated healthy; `filterServableSlugs` fail-open must not mask it in the unit test (test uses a real presence set, not the fail-open path). Pinned in Task 2.

---

## Task 0: Extract the shared probe engine

Extract the module-private probe loop from `homepage-link-health.js` into a shared, tested `srv/lib/link-health-core.js` so the new job reuses the exact same worker pool. Behavior-preserving refactor; the homepage job keeps passing.

**Files:**
- Create: `srv/lib/link-health-core.js`
- Modify: `srv/jobs/homepage-link-health.js` (import from the new core instead of local defs)
- Test: `test/unit/link-health-core.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `checkOne(url, slowThresholdMs) → Promise<'OK'|'SLOW'|'BROKEN'>`
  - `runHealthCheckLoop(rows, resolveUrl, updateRow, slowThresholdMs) → Promise<{ok,slow,broken,skipped}>` — concurrency 4, 200ms sleep, honors `row.linkStatusOverride`, skips when `resolveUrl` returns falsy.
  - re-exports `toAbsoluteUrl`, `resolvePublicBaseUrl` (moved here) for both jobs.
  - constants `CONCURRENCY=4`, `SLEEP_BETWEEN_MS=200`, `TIMEOUT_MS=5000`, `DEFAULT_SLOW_THRESHOLD_MS=1500`, `DEFAULT_PUBLIC_BASE_URL='https://developers.sap.com'`.

- [ ] **Step 1: Write the failing test**

```js
// test/unit/link-health-core.test.js
import { describe, it, expect, vi, afterEach } from 'vitest';
import { runHealthCheckLoop, checkOne } from '../../srv/lib/link-health-core.js';

afterEach(() => vi.restoreAllMocks());

describe('checkOne', () => {
  it('maps a fast 200 to OK', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200 })));
    expect(await checkOne('https://x/y', 1500)).toBe('OK');
  });
  it('maps a thrown fetch to BROKEN', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ENOTFOUND'); }));
    expect(await checkOne('https://x/y', 1500)).toBe('BROKEN');
  });
});

describe('runHealthCheckLoop', () => {
  it('applies linkStatusOverride without fetching and reports counts', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const rows = [{ id: 1, linkStatusOverride: 'OK' }, { id: 2, linkStatusOverride: 'BROKEN' }];
    const updated = [];
    const counts = await runHealthCheckLoop(
      rows, (r) => `https://x/${r.id}`, (r, s) => { updated.push([r.id, s]); }, 1500);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(counts).toEqual({ ok: 1, slow: 0, broken: 1, skipped: 0 });
    expect(updated).toEqual([[1, 'OK'], [2, 'BROKEN']]);
  });
  it('skips rows whose resolveUrl returns null', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200 })));
    const counts = await runHealthCheckLoop(
      [{ id: 1 }], () => null, () => {}, 1500);
    expect(counts.skipped).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/link-health-core.test.js`
Expected: FAIL — cannot resolve `../../srv/lib/link-health-core.js`.

- [ ] **Step 3: Create the core module**

Move `TIMEOUT_MS`, `CONCURRENCY`, `SLEEP_BETWEEN_MS`, `DEFAULT_SLOW_THRESHOLD_MS`, `DEFAULT_PUBLIC_BASE_URL`, `toAbsoluteUrl`, `resolvePublicBaseUrl`, `checkOne`, and `runHealthCheckLoop` verbatim from `homepage-link-health.js` into `srv/lib/link-health-core.js`, exporting `checkOne` and `runHealthCheckLoop` (previously module-private) plus the already-exported `toAbsoluteUrl`/`resolvePublicBaseUrl` and the constants. Keep `const LOG = cds.log?.('link-health-core') ?? console;` for the module.

- [ ] **Step 4: Rewire the homepage job**

In `srv/jobs/homepage-link-health.js`, delete the moved definitions and add at top:

```js
import { runHealthCheckLoop, toAbsoluteUrl, resolvePublicBaseUrl, DEFAULT_SLOW_THRESHOLD_MS } from '../lib/link-health-core.js';
```

Keep `buildBrokenLinksAlert`, `resolveForYouUrl`, and `runHomepageLinkHealth` in place. Re-export `toAbsoluteUrl`/`resolvePublicBaseUrl` from the homepage module if any other file imports them from there (grep first: `grep -rn "from.*homepage-link-health" srv test`).

- [ ] **Step 5: Run the new + existing link-health tests**

Run: `npx vitest run test/unit/link-health-core.test.js && npx vitest run test/unit/homepage-link-health.test.js`
Expected: PASS (both). If no `homepage-link-health.test.js` exists, run `npm test -- homepage` to confirm nothing regressed.

- [ ] **Step 6: Commit**

```bash
git add srv/lib/link-health-core.js srv/jobs/homepage-link-health.js test/unit/link-health-core.test.js
git commit -m "refactor: extract shared link-health probe engine (#2787)"
```

---

## Task 1: Add link-health columns to Tutorials, Missions, Groups

Add the three per-row status columns via a shared aspect, mirroring the `HomepageLinkStatus` pattern.

**Files:**
- Modify: `db/schema.cds` (define aspect near `TaskBase`; apply to `Tutorials`, `Missions`, `Groups`)
- Test: `test/unit/link-health-schema.test.js`

**Interfaces:**
- Produces: columns `linkStatus : LinkHealthStatus default 'UNKNOWN'`, `lastChecked : Timestamp`, `linkStatusOverride : LinkHealthStatus` on `com.sap.developers.ims.{Tutorials,Missions,Groups}`.

- [ ] **Step 1: Write the failing test**

```js
// test/unit/link-health-schema.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

describe('link-health columns', () => {
  let model;
  beforeAll(async () => { model = await cds.load(cds.env.folders.db); });
  it.each(['Tutorials', 'Missions', 'Groups'])('%s has linkStatus/lastChecked/linkStatusOverride', (name) => {
    const e = model.definitions[`com.sap.developers.ims.${name}`];
    expect(e.elements.linkStatus).toBeTruthy();
    expect(e.elements.lastChecked).toBeTruthy();
    expect(e.elements.linkStatusOverride).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/link-health-schema.test.js`
Expected: FAIL — `linkStatus` is undefined on the entities.

- [ ] **Step 3: Add the aspect and apply it**

In `db/schema.cds`, near the `TaskBase` aspect, add:

```cds
type LinkHealthStatus : String(8) enum { OK; SLOW; BROKEN; };

// Per-row URL reachability, written by the url-health-check job (#2787).
// linkStatus/lastChecked are job-written; linkStatusOverride is admin-pinned
// to silence false-BROKEN on auth-gated/bot-detecting URLs.
aspect LinkHealth {
  linkStatus         : LinkHealthStatus default 'UNKNOWN' @assert.range;
  lastChecked        : Timestamp;
  linkStatusOverride : LinkHealthStatus @assert.range;
}
```

Add `, LinkHealth` to the `Tutorials`, `Missions`, and `Groups` entity definitions (e.g. `entity Tutorials : TaskBase, LinkHealth { ... }`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/link-health-schema.test.js`
Expected: PASS.

- [ ] **Step 5: Confirm the model still compiles**

Run: `npx cds compile db/schema.cds --to sql > /dev/null && echo OK`
Expected: `OK`, no compiler errors.

- [ ] **Step 6: Commit**

```bash
git add db/schema.cds test/unit/link-health-schema.test.js
git commit -m "feat(db): link-health columns on Tutorials/Missions/Groups (#2787)"
```

---

## Task 2: Extend findUnhealthyEntities with `deleted` and `not-served` reasons

Extend the live membership check: flag `DELETED` children distinctly from `inactive`, and flag active published children that have no `ContentCurrent` row as `not-served`.

**Files:**
- Modify: `srv/lib/completion-reconcile.js` (`findUnhealthyEntities`)
- Test: `test/unit/completion-health-reasons.test.js`

**Interfaces:**
- Consumes: `filterServableSlugs(db, slugs) → Promise<string[]>` from `srv/lib/servable-slugs.js` (returns the subset of input slugs that have a `ContentCurrent` row; input/output lowercased).
- Produces: `findUnhealthyEntities(db)` return unchanged in shape; `badSlots[].reason` gains `'deleted'` and `'not-served'`. Existing reasons (`unresolved`, `inactive`, `empty`) preserved.

- [ ] **Step 1: Write the failing test**

```js
// test/unit/completion-health-reasons.test.js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';
import { findUnhealthyEntities } from '../../srv/lib/completion-reconcile.js';

describe('findUnhealthyEntities extended reasons', () => {
  let db;
  beforeAll(async () => { db = await cds.connect.to('db'); await cds.deploy(cds.env.folders.db); });
  afterAll(async () => { /* in-memory db torn down by harness */ });

  it('flags a DELETED child as reason "deleted"', async () => {
    // seed: published Group with one GroupPathItem → Tutorial status DELETED
    //   (use existing test seed helpers; see test/unit/completion-reconcile.test.js for the pattern)
    const out = await findUnhealthyEntities(db);
    const g = out.find(e => e.kind === 'GROUP' && e.slug === 'grp-deleted-child');
    expect(g.badSlots.some(s => s.reason === 'deleted')).toBe(true);
    expect(g.badSlots.some(s => s.reason === 'inactive')).toBe(false);
  });

  it('flags an ACTIVE published child with no ContentCurrent row as "not-served"', async () => {
    const out = await findUnhealthyEntities(db);
    const g = out.find(e => e.kind === 'GROUP' && e.slug === 'grp-unserved-child');
    expect(g.badSlots.some(s => s.reason === 'not-served')).toBe(true);
  });
});
```

> Note: seed rows using the same helper the existing `completion-reconcile` test uses. Read `test/unit/completion-reconcile.test.js` first and copy its seed setup for Groups + GroupPathItems + Tutorials + a `ContentCurrent` insert for the served case only.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/completion-health-reasons.test.js`
Expected: FAIL — reason is `'inactive'` for the DELETED case and no `'not-served'` is emitted.

- [ ] **Step 3: Implement the extension**

In `findUnhealthyEntities`, import at top: `import { filterServableSlugs } from './servable-slugs.js';`

Replace the active/inactive branch in BOTH the Groups and Missions loops. The classifier becomes:

```js
// reason classifier (shared between the two loops)
function classify(t) {
  if (!t) return 'unresolved';
  if (t.status === 'DELETED') return 'deleted';
  if (!(t.status == null || t.status === 'ACTIVE')) return 'inactive';
  return null; // active — candidate for not-served check below
}
```

For each loop, collect the slugs of `active` candidates, then after the per-item pass:

```js
// not-served: active children whose slug has no ContentCurrent row
const activeSlugs = activeCandidates.map(t => (t.slug || '').toLowerCase()).filter(Boolean);
const served = new Set(await filterServableSlugs(db, activeSlugs));
for (const t of activeCandidates) {
  if (t.slug && !served.has(t.slug.toLowerCase())) {
    badSlots.push({ taskLegacyId: t.legacyId, reason: 'not-served' });
  }
}
```

Add `'slug'` to the `Tutorials` column lists in both loops (currently `'ID','legacyId','status'` for groups and `'legacyId','status'` for missions) so `t.slug` is available. `activeCandidates` is the list of resolved tutorials that `classify` returned `null` for; `activeCount` stays as-is for the `empty` marker.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/completion-health-reasons.test.js`
Expected: PASS.

- [ ] **Step 5: Run the existing reconcile test (no regression)**

Run: `npx vitest run test/unit/completion-reconcile.test.js`
Expected: PASS — existing `unresolved`/`inactive`/`empty` behavior unchanged.

- [ ] **Step 6: Commit**

```bash
git add srv/lib/completion-reconcile.js test/unit/completion-health-reasons.test.js
git commit -m "feat: findUnhealthyEntities flags deleted + not-served children (#2787)"
```

---

## Task 3: URL resolver and target collection

Build the module that turns the content graph into a de-duplicated list of probe targets with absolute public URLs.

**Files:**
- Create: `srv/lib/health-url-resolver.js`
- Test: `test/unit/health-url-resolver.test.js`

**Interfaces:**
- Consumes: `toAbsoluteUrl` from `srv/lib/link-health-core.js`.
- Produces:
  - `resolveEntityUrl({ kind, slug }, baseUrl) → string|null` — lowercases slug; `TUTORIAL → <base>/tutorials/<slug>/`, `MISSION → <base>/missions/<slug>/`, `GROUP → <base>/tutorials/group-<slug>`; returns null for a falsy slug or unknown kind.
  - `collectHealthTargets(db) → Promise<Array<{ kind:'TUTORIAL'|'MISSION'|'GROUP', legacyId:number, slug:string, url:string, override:string|null }>>` — ACTIVE tutorials + published active missions + published active groups; de-duplicated by `url`.

- [ ] **Step 1: Write the failing test**

```js
// test/unit/health-url-resolver.test.js
import { describe, it, expect } from 'vitest';
import { resolveEntityUrl } from '../../srv/lib/health-url-resolver.js';

const BASE = 'https://developers.sap.com';

describe('resolveEntityUrl', () => {
  it('builds tutorial URL and lowercases slug', () => {
    expect(resolveEntityUrl({ kind: 'TUTORIAL', slug: 'Hello-World' }, BASE))
      .toBe('https://developers.sap.com/tutorials/hello-world/');
  });
  it('builds mission URL', () => {
    expect(resolveEntityUrl({ kind: 'MISSION', slug: 'getting-started' }, BASE))
      .toBe('https://developers.sap.com/missions/getting-started/');
  });
  it('builds group URL with group- prefix', () => {
    expect(resolveEntityUrl({ kind: 'GROUP', slug: 'cap-basics' }, BASE))
      .toBe('https://developers.sap.com/tutorials/group-cap-basics');
  });
  it('returns null for a falsy slug', () => {
    expect(resolveEntityUrl({ kind: 'TUTORIAL', slug: '' }, BASE)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/health-url-resolver.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `resolveEntityUrl`**

```js
// srv/lib/health-url-resolver.js
import cds from '@sap/cds';
import { toAbsoluteUrl } from './link-health-core.js';

const NS = 'com.sap.developers.ims';

export function resolveEntityUrl({ kind, slug }, baseUrl) {
  const s = (slug || '').toLowerCase();
  if (!s) return null;
  let path;
  if (kind === 'TUTORIAL') path = `/tutorials/${s}/`;
  else if (kind === 'MISSION') path = `/missions/${s}/`;
  else if (kind === 'GROUP') path = `/tutorials/group-${s}`;
  else return null;
  return toAbsoluteUrl(path, baseUrl);
}
```

- [ ] **Step 4: Run test to verify `resolveEntityUrl` passes**

Run: `npx vitest run test/unit/health-url-resolver.test.js`
Expected: PASS.

- [ ] **Step 5: Write the failing `collectHealthTargets` test**

```js
// append to test/unit/health-url-resolver.test.js
import { collectHealthTargets } from '../../srv/lib/health-url-resolver.js';
import cds from '@sap/cds';

describe('collectHealthTargets', () => {
  let db;
  beforeAll(async () => { db = await cds.connect.to('db'); await cds.deploy(cds.env.folders.db); });

  it('includes active tutorials + published missions/groups, excludes inactive/unpublished, dedups by url', async () => {
    // seed via existing helpers: 1 ACTIVE tutorial, 1 INACTIVE tutorial,
    // 1 published Group, 1 unpublished Group, and the same ACTIVE tutorial
    // referenced by two groups (to prove dedup).
    const targets = await collectHealthTargets(db);
    const urls = targets.map(t => t.url);
    expect(urls).toContain('https://developers.sap.com/tutorials/active-tut/');
    expect(urls).not.toContain('https://developers.sap.com/tutorials/inactive-tut/');
    expect(urls.filter(u => u.endsWith('/tutorials/active-tut/')).length).toBe(1); // dedup
    expect(urls.some(u => u.includes('/missions/'))).toBe(false); // no published mission seeded
    expect(targets.find(t => t.kind === 'GROUP' && t.slug === 'pub-group')).toBeTruthy();
    expect(targets.find(t => t.slug === 'unpub-group')).toBeUndefined();
  });
});
```

> Seed with the same helpers used in `test/unit/completion-reconcile.test.js`. Tutorial-target set = all tutorials with `status == null || 'ACTIVE'` (independent of membership — spec Part 2 = "all active tutorials").

- [ ] **Step 6: Run to verify it fails**

Run: `npx vitest run test/unit/health-url-resolver.test.js`
Expected: FAIL — `collectHealthTargets` not defined.

- [ ] **Step 7: Implement `collectHealthTargets`**

```js
export async function collectHealthTargets(db) {
  const { Tutorials, Missions, Groups } = cds.entities(NS);
  const { resolvePublicBaseUrl } = await import('./link-health-core.js');
  const baseUrl = await resolvePublicBaseUrl(db);
  const active = { or: [{ status: null }, { status: 'ACTIVE' }] };

  const tuts = await db.run(SELECT.from(Tutorials)
    .columns('legacyId', 'slug', 'linkStatusOverride').where(active));
  const missions = await db.run(SELECT.from(Missions)
    .columns('legacyId', 'slug', 'linkStatusOverride').where({ published: true, ...active }));
  const groups = await db.run(SELECT.from(Groups)
    .columns('legacyId', 'slug', 'linkStatusOverride').where({ published: true, ...active }));

  const rows = [
    ...tuts.map(r => ({ kind: 'TUTORIAL', ...r })),
    ...missions.map(r => ({ kind: 'MISSION', ...r })),
    ...groups.map(r => ({ kind: 'GROUP', ...r })),
  ];

  const byUrl = new Map();
  for (const r of rows) {
    const url = resolveEntityUrl({ kind: r.kind, slug: r.slug }, baseUrl);
    if (!url || byUrl.has(url)) continue;
    byUrl.set(url, {
      kind: r.kind, legacyId: r.legacyId, slug: r.slug, url,
      override: r.linkStatusOverride ?? null,
    });
  }
  return [...byUrl.values()];
}
```

> If the SQLite `where({ published: true, ...active })` object-spread form is rejected by the CQL builder, fall back to `.where('published = true and (status is null or status = ', 'ACTIVE', ')')` — verify which the codebase prefers by grepping an existing `published: true` query.

- [ ] **Step 8: Run to verify it passes**

Run: `npx vitest run test/unit/health-url-resolver.test.js`
Expected: PASS (all describe blocks).

- [ ] **Step 9: Commit**

```bash
git add srv/lib/health-url-resolver.js test/unit/health-url-resolver.test.js
git commit -m "feat: health URL resolver + target collection (#2787)"
```

---

## Task 4: The url-health-check job

Wire the target collection + shared probe engine + per-row persistence + alert into one job function.

**Files:**
- Create: `srv/jobs/url-health-check-job.js`
- Test: `test/unit/url-health-check-job.test.js`

**Interfaces:**
- Consumes: `collectHealthTargets` (Task 3), `runHealthCheckLoop` + `buildBrokenLinksAlert`-style alert (reuse `homepage-link-health`'s alert shape).
- Produces: `runUrlHealthCheck(logId, opts) → Promise<{ ok, slow, broken, skipped }>`; `updateRow(db, row, status) → Promise<void>` (dispatch UPDATE by `row.kind`).

- [ ] **Step 1: Write the failing test**

```js
// test/unit/url-health-check-job.test.js
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import cds from '@sap/cds';

afterEach(() => vi.restoreAllMocks());

describe('runUrlHealthCheck', () => {
  let db;
  beforeAll(async () => { db = await cds.connect.to('db'); await cds.deploy(cds.env.folders.db); });

  it('probes active targets and writes linkStatus/lastChecked', async () => {
    // seed one ACTIVE tutorial 'probe-tut'
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200 })));
    const { runUrlHealthCheck } = await import('../../srv/jobs/url-health-check-job.js');
    const res = await runUrlHealthCheck('test-log-1', {});
    expect(res.ok).toBeGreaterThanOrEqual(1);
    const { Tutorials } = cds.entities('com.sap.developers.ims');
    const [t] = await db.run(SELECT.from(Tutorials).columns('linkStatus', 'lastChecked').where({ slug: 'probe-tut' }));
    expect(t.linkStatus).toBe('OK');
    expect(t.lastChecked).toBeTruthy();
  });

  it('does not re-probe an overridden row', async () => {
    // seed ACTIVE tutorial 'pinned-tut' with linkStatusOverride='OK'
    const fetchSpy = vi.fn(async () => ({ ok: false, status: 404 }));
    vi.stubGlobal('fetch', fetchSpy);
    const { runUrlHealthCheck } = await import('../../srv/jobs/url-health-check-job.js');
    await runUrlHealthCheck('test-log-2', {});
    const { Tutorials } = cds.entities('com.sap.developers.ims');
    const [t] = await db.run(SELECT.from(Tutorials).columns('linkStatus').where({ slug: 'pinned-tut' }));
    expect(t.linkStatus).toBe('OK'); // override wins despite 404
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/url-health-check-job.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the job**

```js
// srv/jobs/url-health-check-job.js
import cds from '@sap/cds';
import { runHealthCheckLoop, DEFAULT_SLOW_THRESHOLD_MS } from '../lib/link-health-core.js';
import { collectHealthTargets } from '../lib/health-url-resolver.js';
import * as alerting from '../lib/alerting.js'; // confirm path by grepping how homepage-link-health imports alerting

const NS = 'com.sap.developers.ims';
const LOG = cds.log?.('url-health-check') ?? console;
const ENTITY_BY_KIND = { TUTORIAL: 'Tutorials', MISSION: 'Missions', GROUP: 'Groups' };

export async function updateRow(db, row, status) {
  const name = `${NS}.${ENTITY_BY_KIND[row.kind]}`;
  await db.run(UPDATE(name)
    .set({ linkStatus: status, lastChecked: new Date().toISOString() })
    .where({ legacyId: row.legacyId }));
}

export async function runUrlHealthCheck(logId, opts = {}) {
  const slowThresholdMs = opts.slowThresholdMs ?? DEFAULT_SLOW_THRESHOLD_MS;
  const db = await cds.connect.to('db');
  try {
    const targets = await collectHealthTargets(db);
    // feed the shared engine: it reads row.linkStatusOverride, so alias our
    // `override` field onto it.
    const rows = targets.map(t => ({ ...t, linkStatusOverride: t.override }));
    const counts = await runHealthCheckLoop(
      rows,
      (row) => row.url,
      (row, status) => updateRow(db, row, status),
      slowThresholdMs,
    );
    LOG.info?.(`url-health: ${counts.ok} OK, ${counts.slow} SLOW, ${counts.broken} BROKEN, ${counts.skipped} skipped`);
    if (counts.broken > 0) {
      await alerting.raise({
        eventType: 'ContentUrlsBroken',
        severity: 'WARNING',
        category: 'ALERT',
        subject: `URL health: ${counts.broken} broken content URL(s)`,
        body: `url-health-check found ${counts.broken} BROKEN tutorial/mission/group URL(s). `
            + `Review /admin-ui/#health (linkStatus=BROKEN); pin linkStatusOverride to silence false-positives.`,
        resource: { resourceName: 'url-health-check', resourceType: 'job' },
      });
    }
    return counts;
  } catch (err) {
    LOG.error?.('url-health-check failed:', err.message);
    return { ok: false, error: err.message };
  }
}
```

> Before writing the `alerting` import, grep `srv/jobs/homepage-link-health.js` for its exact `alerting` import line and copy it verbatim (path + named/default form).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/url-health-check-job.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add srv/jobs/url-health-check-job.js test/unit/url-health-check-job.test.js
git commit -m "feat: url-health-check job (#2787)"
```

---

## Task 5: Register the job in the scheduler

Register `url-health-check` so it runs nightly and is manually triggerable via `JobControls.runJob`.

**Files:**
- Modify: `srv/jobs/scheduler.js` (inside `registerJobs()`)
- Test: `test/unit/scheduler-url-health.test.js`

**Interfaces:**
- Consumes: `registerJob({ jobName, schedule, ttlMs, description, fn })`; `runUrlHealthCheck` (Task 4).
- Produces: a `JOB_REGISTRY` entry `'url-health-check'`.

- [ ] **Step 1: Write the failing test**

```js
// test/unit/scheduler-url-health.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import { registerJobs, _getJobRegistry, _resetJobRegistry } from '../../srv/jobs/scheduler.js';

describe('url-health-check registration', () => {
  beforeEach(() => _resetJobRegistry());
  it('registers url-health-check on an off-minute schedule', async () => {
    await registerJobs();
    const job = _getJobRegistry().get('url-health-check');
    expect(job).toBeTruthy();
    const minute = job.schedule.split(' ')[0];
    expect(['0', '30']).not.toContain(minute); // off-minute per Global Constraints
    expect(typeof job.fn).toBe('function');
  });
});
```

> If `registerJobs()` has side effects (DB pre-seed) that make it unsafe to call in a unit test, instead assert against a lighter seam — check how `test/unit/*scheduler*` existing tests invoke it and match that; the behavior to pin is "an entry named `url-health-check` exists with a non-:00/:30 minute".

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/scheduler-url-health.test.js`
Expected: FAIL — no `url-health-check` entry.

- [ ] **Step 3: Register the job**

In `srv/jobs/scheduler.js`, inside `registerJobs()` (alongside the `freshness-scan` block), add:

```js
// URL health check (#2787): nightly reachability scan of all ACTIVE tutorials
// + published missions/groups. Also manually triggerable via JobControls.runJob.
// 17 4 — off-minute, shares the 04:xx window with other nightly scans (jobName
// uniqueness is what the scheduler enforces, not minute uniqueness).
registerJob({
  jobName: 'url-health-check',
  schedule: '17 4 * * *',
  ttlMs: 1800000,
  description: 'URL reachability scan for tutorials/missions/groups (#2787)',
  fn: (logId) => import('./url-health-check-job.js').then(m => m.runUrlHealthCheck(logId)),
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/scheduler-url-health.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add srv/jobs/scheduler.js test/unit/scheduler-url-health.test.js
git commit -m "feat: register url-health-check scheduler job (#2787)"
```

---

## Task 6: Expose columns + manual-trigger action on AdminService

Surface the new columns on the admin projections and add an unbound action to run the scan on demand.

**Files:**
- Modify: `srv/admin-service.cds` (projections inherit `*`; add `runUrlHealthScan` action)
- Modify: `srv/admin-service.js` (handler for `runUrlHealthScan`)
- Test: `test/unit/admin-url-health-action.test.js`

**Interfaces:**
- Consumes: `runJobByName('url-health-check', { manualTrigger: true, user })` from `srv/jobs/scheduler.js`.
- Produces: `AdminService.runUrlHealthScan()` → `{ ok: Boolean, broken: Integer, message: String }`.

- [ ] **Step 1: Write the failing test**

```js
// test/unit/admin-url-health-action.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

describe('AdminService.runUrlHealthScan', () => {
  let srv;
  beforeAll(async () => {
    cds.requires.auth = { kind: 'mocked', users: { admin: { roles: ['Admin'] } } };
    srv = await cds.test(cds.root).run; // match existing admin test bootstrap; see test/unit for the real pattern
  });
  it('is callable by an Admin and returns an ok result', async () => {
    // Call the unbound action with an Admin-authenticated request; assert the
    // response shape { ok, broken, message }. Mirror an existing admin action
    // test (e.g. completionHealth) for the exact cds.test invocation.
    expect(true).toBe(true); // replace with real action call per existing admin-test harness
  });
});
```

> This step's test MUST be fleshed out to actually invoke the action using the project's established admin-service test harness. Read an existing admin action test (grep `test -rl "completionHealth\|rebuildContent" test/`) and copy its `cds.test`/`POST /admin/...` invocation style. Do not ship the `expect(true).toBe(true)` placeholder — it exists only to show where the real call goes.

- [ ] **Step 2: Run test to verify it fails (then make it real)**

Run: `npx vitest run test/unit/admin-url-health-action.test.js`
Replace the placeholder with a real invocation; expected initial state: FAIL because `runUrlHealthScan` is not defined on the service.

- [ ] **Step 3: Declare the action and expose columns**

The `Tutorials`/`Missions`/`Groups` projections use `*` (confirmed: `entity Tutorials as projection on ims.Tutorials { ... }` with `*`), so the new columns are exposed automatically — verify by compile. Add the unbound action to the `AdminService` body near `completionHealth` (admin-service.cds:1313):

```cds
// #2787: run the URL health scan on demand (nightly job also runs it).
action runUrlHealthScan() returns {
  ok      : Boolean;
  broken  : Integer;
  message : String;
};
```

If `*` does NOT carry the columns onto a projection that uses an explicit column list, add `linkStatus`, `lastChecked`, `linkStatusOverride` to that list explicitly.

- [ ] **Step 4: Implement the handler**

In `srv/admin-service.js`, near the `completionHealth` handler (admin-service.js:3758):

```js
this.on('runUrlHealthScan', async (req) => {
  const { runJobByName } = await import('./jobs/scheduler.js');
  const r = await runJobByName('url-health-check', { manualTrigger: true, user: req.user?.id });
  const broken = r?.result?.broken ?? r?.broken ?? 0;
  return {
    ok: r?.outcome !== 'FAILED' && r?.ok !== false,
    broken,
    message: r?.skipped ? 'Scan already running — skipped' : `Scan complete: ${broken} broken.`,
  };
});
```

> Confirm the `runJobByName` return shape (`{ skipped, outcome, result, ... }`) against scheduler.js and adjust the `broken`/`ok` extraction to match what `runWithLock` actually returns.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/unit/admin-url-health-action.test.js`
Expected: PASS.

- [ ] **Step 6: Compile the admin service**

Run: `npx cds compile srv/admin-service.cds --to json > /dev/null && echo OK`
Expected: `OK` (also confirms the columns surface on the projections).

- [ ] **Step 7: Commit**

```bash
git add srv/admin-service.cds srv/admin-service.js test/unit/admin-url-health-action.test.js
git commit -m "feat(admin): expose link-health columns + runUrlHealthScan action (#2787)"
```

---

## Task 7: Admin UI health screen

Add the two-tab Fiori Elements screen and register it in the shell.

**Files:**
- Create: `app/admin/health/webapp/manifest.json`
- Create: `app/admin/health/webapp/Component.js`
- Create: `app/admin/health/webapp/ext/MembershipIssues.controller.js` (fetches `completionHealth()`)
- Modify: `app/admin-shell/webapp/manifest.json` (componentUsage)
- Modify: `app/admin-shell/webapp/model/navigation.json` (nav entry under Reporting)
- Test: covered by the post-deploy `e2e` job (advisory spec added below)

**Interfaces:**
- Consumes: `AdminService` OData at `/admin/` — entities `Tutorials`/`Missions`/`Groups` (columns `slug`, `linkStatus`, `lastChecked`, `linkStatusOverride`), function `completionHealth()`, action `runUrlHealthScan()`.
- Produces: nav key `health`, componentUsage `sap.tutorials.admin.health`.

- [ ] **Step 1: Create the FE app manifest**

Read `app/admin/operations/webapp/manifest.json` first and mirror its structure. Create `app/admin/health/webapp/manifest.json` with:
- `sap.app.id = "sap.tutorials.admin.health"`
- `sap.app.crossNavigation.inbounds` → `{ semanticObject: "Health", action: "display", title: "URL Health" }`
- `dataSources.adminService` → `uri: "/admin/"`, `type: "OData"`, `settings.odataVersion: "4.0"`
- A ListReport+ObjectPage target over `AdminService.Tutorials` (Tab 1, "URL Status"), filtered by `linkStatus`, with `linkStatusOverride` editable and a `DataFieldForAction` bound to `runUrlHealthScan` in the header.
- Tab 2 "Membership Issues" as a custom section/page rendered by `ext/MembershipIssues.controller.js`.

- [ ] **Step 2: Create Component.js**

Mirror `app/admin/operations/webapp/Component.js` (extends `sap/fe/core/AppComponent`, `manifest: "json"`).

- [ ] **Step 3: Create the Membership Issues controller**

```js
// app/admin/health/webapp/ext/MembershipIssues.controller.js
sap.ui.define(["sap/ui/core/mvc/ControllerExtension"], function (ControllerExtension) {
  "use strict";
  return ControllerExtension.extend("sap.tutorials.admin.health.ext.MembershipIssues", {
    onInit: function () {
      // GET /admin/completionHealth() → bind result to a JSONModel on the view.
      fetch("/admin/completionHealth()", { headers: { Accept: "application/json" } })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          var m = new sap.ui.model.json.JSONModel({ issues: d.value || d });
          this.getView().setModel(m, "membership");
        }.bind(this))
        .catch(function (e) { sap.ui.require(["sap/m/MessageToast"], function (T) { T.show("Membership check failed: " + e.message); }); });
    },
  });
});
```

- [ ] **Step 4: Register in the shell**

In `app/admin-shell/webapp/manifest.json`, add to `componentUsages`:
```json
"sap.tutorials.admin.health": { "name": "sap.tutorials.admin.health" }
```
(Match the exact shape of the neighboring `operations` entry — read lines 54-92 first.)

In `app/admin-shell/webapp/model/navigation.json`, add under the Reporting group:
```json
{ "key": "health", "title": "URL Health", "icon": "sap-icon://chain-link", "requiredScope": "Admin" }
```

- [ ] **Step 5: Write the advisory e2e spec**

```js
// test/e2e/health-screen.spec.ts  (self-skips without SMOKE_BASE_URL)
import { test, expect } from '@playwright/test';
const BASE = process.env.SMOKE_BASE_URL;
test.skip(!BASE, 'SMOKE_BASE_URL not set');
test('health screen renders both tabs', async ({ page }) => {
  await page.goto(`${BASE}/admin-ui/#health`);
  await expect(page.getByText('URL Status')).toBeVisible();
  await expect(page.getByText('Membership Issues')).toBeVisible();
});
```

- [ ] **Step 6: Build the admin apps + sanity-load**

Run: `npm run build:all` (or the admin-specific build step — grep `package.json` scripts for the admin bundle build).
Expected: build succeeds; `app/admin-shell/deploy/resources/.../components/health/` exists.

- [ ] **Step 7: Commit**

```bash
git add app/admin/health app/admin-shell/webapp/manifest.json app/admin-shell/webapp/model/navigation.json test/e2e/health-screen.spec.ts
git commit -m "feat(admin-ui): URL health screen with URL-status + membership tabs (#2787)"
```

---

## Task 8: Full unit suite + srv-qa cp-list audit + deploy readiness

Final integration pass: whole unit suite green, deploy-list audit, and the deploy note recorded for the human.

**Files:**
- Possibly modify: `.deploy/mta.yaml` (`srv-qa` `cp` list) — only if the audit says so.

- [ ] **Step 1: Run the full unit suite**

Run: `npm test`
Expected: PASS, including all five new test files. Fix any regression before proceeding.

- [ ] **Step 2: srv-qa cp-list audit**

Run: `grep -rn "require(['\"]\./\|from '\./" srv/lib/content-store.js` and confirm `health-url-resolver.js` and `link-health-core.js` are NOT reachable from `content-store.js`'s transitive `./` import graph. If either IS reachable, add it to the `srv-qa` `cp` list in `.deploy/mta.yaml`.
Expected: neither is reachable (both are job-path only) → no mta.yaml change.

- [ ] **Step 3: Confirm the production model builds**

Run: `scripts/quiet-run.sh npx cds build --production`
Expected: exit 0. (Wrapped per CLAUDE.md's token-efficiency rule — output can be long.)

- [ ] **Step 4: Record the deploy note (no deploy from here)**

This feature touches admin UI → requires a FULL deploy (`npm run deploy -- --env dev`, no `--skip-build`, no `-m`). Do NOT deploy from the worktree; the human runs it from a fresh `origin/DEV`. Note it in the PR body.

- [ ] **Step 5: Final commit (if the audit changed mta.yaml)**

```bash
git add .deploy/mta.yaml
git commit -m "chore(deploy): srv-qa cp-list audit for url-health (#2787)"
```

(Skip if the audit found no change needed.)

---

## Done criteria

- `npm test` green with the five new test files.
- Nightly `url-health-check` job registered on an off-minute; manually runnable via `JobControls.runJob` and the admin `runUrlHealthScan` action.
- `linkStatus`/`lastChecked`/`linkStatusOverride` on Tutorials/Missions/Groups, written by the scan, override honored on re-run.
- `completionHealth()` flags `deleted` and `not-served` in addition to the existing reasons.
- Admin UI `/admin-ui/#health` renders both tabs; "Run scan now" triggers the job; broken URLs raise a WARNING alert.
- PR opened against DEV (per repo rules); deploy note recorded; no deploy performed from the worktree.
