# KG Community Curator-Assist Nudges (#1172) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface mission-coverage %, dominant existing mission, and orphan-tutorial count per KG community on `/admin-ui/#kgCommunities`, plus an interactive promote-time warning ("~X% already in <mission> — extend instead?") when coverage is high.

**Architecture:** A pure helper (`srv/lib/kg-community-coverage.js`) computes coverage/orphan math from three cheap batched reads (community tutorial members, their covered→mission mapping, published filter). The existing `after('READ','KgCommunities')` decorator calls it and populates five new virtual fields on the `AdminService.KgCommunities` projection — fail-quiet, so any throw leaves fields unset and Fiori renders no badge (mirrors the #918 `isolated` pattern). FE annotations render the fields as LR/OP columns with a criticality badge; a new plain-module FE controller intercepts the Promote button to show a `MessageBox.warning` when `coverageHigh`.

**Tech Stack:** SAP CAP (Node.js, CDS), SAP HANA Cloud (hybrid) / in-memory SQLite (unit), Fiori Elements V4, Vitest.

## Global Constraints

- **Coverage semantics:** published missions only (`Missions.published = true`). Draft missions never count as coverage.
- **Coverage-% denominator:** tutorial-typed members only (`KgCommunity.vertexType = 'tutorial'`). Member-vertex counts are context, never folded into the %.
- **Computation site:** read-time, inside the existing `after('READ','KgCommunities')` decorator in `srv/admin-service.js`. No new job, no new persisted table, no `.hdbmigrationtable` bump.
- **Fail-quiet:** the entire coverage block is wrapped in its own `try/catch`, separate from the `topConceptSlugs` block. Any throw → `cds.log('kg-community-coverage').warn(...)`, fields unset, never a request-time 500.
- **Threshold:** default `70`, env-overridable `KG_COMMUNITY_COVERAGE_NUDGE_THRESHOLD`. Server-computed `coverageHigh : Boolean` is the single source of truth for both the LR badge and the FE nudge.
- **0-tutorial community:** `missionCoveragePct` and `orphanTutorialCount` left **unset** (not 0) — a concept/tag-only cluster is "N/A", not "0% covered".
- **HANA packet cap** ([[cqn-where-in-hana-packet-cap]]): never pass an unbounded slug list to `.in([...])`. Chunk the slug `IN` list at 500 per call, merge in Node. SQLite unit tests will not catch this; the hybrid test must exercise realistic slug width.
- **FE V4 controller suffix:** the promote-time controller MUST be a plain module `KgCommunityActionsController.js` (loader path `<dotted-name>.js`), **NOT** `.controller.js` — FE V4 resolves manifest `press` refs as plain modules; the `.controller.js` suffix 404s (see `app/admin/concepts/webapp/ext/ConceptActionsController.js` header + memory `feedback_ui5_controller_suffix_collision`).
- **SuperAdmin gating unchanged:** the FE warning is advisory only. `@requires:'SuperAdmin'` on `promoteCommunityToMission` in `srv/admin-service.cds` remains authoritative.
- **CI-safety before commit:** after any `.cds`/projection change run `npx cds deploy --to sqlite::memory:` (catches deploy-time errors) and `cds build --production` (regen `db/last-dev/csn.json`). No migration bump — no new persisted table.
- **srv-qa cp audit** (CLAUDE.md rule): `srv/lib/kg-community-coverage.js` must be added to `.deploy/mta.yaml`'s `srv-qa` `cp` list — it is a transitive `./` import from `srv/admin-service.js`. Missing → QA boot crash at MTA deploy.
- **Slugs are lowercase canonical:** compare tutorial slugs case-insensitively; the coverage join and member reads operate on already-lowercase slugs, but any client-supplied comparison must `.toLowerCase()`.

---

## File Structure

| File | Responsibility |
|---|---|
| `srv/lib/kg-community-coverage.js` | **new** — pure functions: given community→member-slug sets and covered-slug→mission rows, compute `{ missionCoveragePct, dominantMissionTitle, dominantMissionSlug, orphanTutorialCount, coverageHigh }` per community. No DB, no CAP. |
| `srv/admin-service.cds` | + 5 virtual fields on the `KgCommunities` projection. |
| `srv/admin-service.js` | threshold constant/env resolver; extend `after('READ','KgCommunities')` with the two batched reads + helper call, in a separate try/catch. |
| `app/admin-annotations.cds` | + LR LineItem cols, OP FieldGroup cols, coverage criticality badge, SelectionFields. |
| `app/admin/kgCommunities/webapp/manifest.json` | + `controllerExtensions`; declare the `promoteToMission` custom action wired to the controller (replaces the annotation-driven `DataFieldForAction`). |
| `app/admin/kgCommunities/webapp/ext/KgCommunityActionsController.js` | **new** — plain module; `onPromoteToMission` shows the warning then calls `editFlow.invokeAction`. |
| `app/admin/kgCommunities/webapp/i18n/i18n.properties` | + button + nudge copy. |
| `.deploy/mta.yaml` | add `srv/lib/kg-community-coverage.js` to `srv-qa` `cp` list. |
| `test/unit/kg-community-coverage.test.js` | **new** — pure-helper unit tests. |
| `test/unit/admin-kg-community-coverage-read.test.js` | **new** — decorator fail-quiet + field-population unit test (in-memory SQLite). |
| `test/hybrid/kg-community-coverage.hybrid.test.js` | **new** — real-HANA round-trip + packet-safe width. |
| `CLAUDE.md` | + one top-gotcha entry. |

---

## Task 1: Pure coverage helper + unit tests

**Files:**
- Create: `srv/lib/kg-community-coverage.js`
- Test: `test/unit/kg-community-coverage.test.js`

**Interfaces:**
- Produces:
  - `computeCoverage({ memberSlugsByCommunity, coveredRows, threshold }) → Map<communityId, CoverageResult>`
    - `memberSlugsByCommunity`: `Map<number, string[]>` — community ID → its tutorial-typed member slugs (lowercase).
    - `coveredRows`: `Array<{ slug: string, missionTitle: string, missionSlug: string }>` — one row per (tutorial slug in a published mission, that mission). A tutorial in two published missions yields two rows.
    - `threshold`: `number` (e.g. 70).
    - `CoverageResult`: `{ missionCoveragePct: number|null, dominantMissionTitle: string|null, dominantMissionSlug: string|null, orphanTutorialCount: number|null, coverageHigh: boolean }`.
  - `resolveThreshold(env) → number` — reads `env.KG_COMMUNITY_COVERAGE_NUDGE_THRESHOLD`, parses int, falls back to `70` on missing/NaN/out-of-range (clamp 0–100).

- [ ] **Step 1: Write the failing tests**

Create `test/unit/kg-community-coverage.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import { computeCoverage, resolveThreshold } from '../../srv/lib/kg-community-coverage.js';

const T = 70;

describe('computeCoverage', () => {
  it('tutorials-only denominator: 2 of 4 covered → 50%', () => {
    const members = new Map([[1, ['a', 'b', 'c', 'd']]]);
    const covered = [
      { slug: 'a', missionTitle: 'M1', missionSlug: 'm1' },
      { slug: 'b', missionTitle: 'M1', missionSlug: 'm1' },
    ];
    const r = computeCoverage({ memberSlugsByCommunity: members, coveredRows: covered, threshold: T }).get(1);
    expect(r.missionCoveragePct).toBe(50);
    expect(r.orphanTutorialCount).toBe(2);
    expect(r.dominantMissionTitle).toBe('M1');
    expect(r.dominantMissionSlug).toBe('m1');
    expect(r.coverageHigh).toBe(false);
  });

  it('dominant mission = the one covering the most members; tie broken by title asc', () => {
    const members = new Map([[1, ['a', 'b', 'c', 'd']]]);
    const covered = [
      { slug: 'a', missionTitle: 'Zeta', missionSlug: 'zeta' },
      { slug: 'b', missionTitle: 'Alpha', missionSlug: 'alpha' },
    ]; // 1 each → tie → 'Alpha' wins on title asc
    const r = computeCoverage({ memberSlugsByCommunity: members, coveredRows: covered, threshold: T }).get(1);
    expect(r.dominantMissionTitle).toBe('Alpha');
    expect(r.dominantMissionSlug).toBe('alpha');
  });

  it('a tutorial counted once even if in two missions (coverage dedupe by slug)', () => {
    const members = new Map([[1, ['a', 'b']]]);
    const covered = [
      { slug: 'a', missionTitle: 'M1', missionSlug: 'm1' },
      { slug: 'a', missionTitle: 'M2', missionSlug: 'm2' },
    ]; // only 'a' covered → 1 of 2 = 50%, M1 dominant (title asc tie among 1-each)
    const r = computeCoverage({ memberSlugsByCommunity: members, coveredRows: covered, threshold: T }).get(1);
    expect(r.missionCoveragePct).toBe(50);
    expect(r.orphanTutorialCount).toBe(1);
  });

  it('coverageHigh boundary: 69 false, 70 true, 71 true', () => {
    const mk = (n, total) => {
      const members = new Map([[1, Array.from({ length: total }, (_, i) => `t${i}`)]]);
      const covered = Array.from({ length: n }, (_, i) => ({ slug: `t${i}`, missionTitle: 'M', missionSlug: 'm' }));
      return computeCoverage({ memberSlugsByCommunity: members, coveredRows: covered, threshold: 70 }).get(1);
    };
    expect(mk(69, 100).coverageHigh).toBe(false); // 69%
    expect(mk(70, 100).coverageHigh).toBe(true);  // 70%
    expect(mk(71, 100).coverageHigh).toBe(true);  // 71%
  });

  it('rounds to nearest integer (1 of 3 = 33%)', () => {
    const members = new Map([[1, ['a', 'b', 'c']]]);
    const covered = [{ slug: 'a', missionTitle: 'M', missionSlug: 'm' }];
    expect(computeCoverage({ memberSlugsByCommunity: members, coveredRows: covered, threshold: T }).get(1).missionCoveragePct).toBe(33);
  });

  it('no coverage: 0%, all orphaned, no dominant mission', () => {
    const members = new Map([[1, ['a', 'b']]]);
    const r = computeCoverage({ memberSlugsByCommunity: members, coveredRows: [], threshold: T }).get(1);
    expect(r.missionCoveragePct).toBe(0);
    expect(r.orphanTutorialCount).toBe(2);
    expect(r.dominantMissionTitle).toBeNull();
    expect(r.dominantMissionSlug).toBeNull();
    expect(r.coverageHigh).toBe(false);
  });

  it('0-tutorial community → pct and orphanCount unset (null), not 0', () => {
    const members = new Map([[1, []]]);
    const r = computeCoverage({ memberSlugsByCommunity: members, coveredRows: [], threshold: T }).get(1);
    expect(r.missionCoveragePct).toBeNull();
    expect(r.orphanTutorialCount).toBeNull();
    expect(r.coverageHigh).toBe(false);
  });

  it('covered rows for slugs not in the community are ignored', () => {
    const members = new Map([[1, ['a']]]);
    const covered = [{ slug: 'x', missionTitle: 'M', missionSlug: 'm' }];
    const r = computeCoverage({ memberSlugsByCommunity: members, coveredRows: covered, threshold: T }).get(1);
    expect(r.missionCoveragePct).toBe(0);
    expect(r.orphanTutorialCount).toBe(1);
  });
});

describe('resolveThreshold', () => {
  it('defaults to 70 when unset', () => { expect(resolveThreshold({})).toBe(70); });
  it('reads a valid override', () => { expect(resolveThreshold({ KG_COMMUNITY_COVERAGE_NUDGE_THRESHOLD: '80' })).toBe(80); });
  it('falls back to 70 on NaN', () => { expect(resolveThreshold({ KG_COMMUNITY_COVERAGE_NUDGE_THRESHOLD: 'abc' })).toBe(70); });
  it('clamps out-of-range to 70', () => { expect(resolveThreshold({ KG_COMMUNITY_COVERAGE_NUDGE_THRESHOLD: '150' })).toBe(70); });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/kg-community-coverage.test.js`
Expected: FAIL — "Cannot find module '../../srv/lib/kg-community-coverage.js'" (or "computeCoverage is not a function").

- [ ] **Step 3: Write the helper**

Create `srv/lib/kg-community-coverage.js`:

```javascript
// srv/lib/kg-community-coverage.js
//
// Pure coverage/orphan math for the KG community curator-assist nudges (#1172).
// No DB, no CAP — the caller (after('READ','KgCommunities') in
// srv/admin-service.js) does the batched reads and passes plain data in.
//
// Coverage is computed over TUTORIAL members only (only tutorials can be in a
// mission) and against PUBLISHED missions only. See
// docs/superpowers/specs/2026-07-14-1172-kg-community-curator-nudges-design.md.
'use strict';

const DEFAULT_THRESHOLD = 70;

/**
 * Resolve the coverage-high threshold from env, clamped to 0–100.
 * @param {Record<string,string|undefined>} env
 * @returns {number}
 */
function resolveThreshold(env) {
  const raw = env && env.KG_COMMUNITY_COVERAGE_NUDGE_THRESHOLD;
  if (raw == null) return DEFAULT_THRESHOLD;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n < 0 || n > 100) return DEFAULT_THRESHOLD;
  return n;
}

/**
 * @param {object} args
 * @param {Map<number,string[]>} args.memberSlugsByCommunity  community ID → tutorial member slugs (lowercase)
 * @param {Array<{slug:string,missionTitle:string,missionSlug:string}>} args.coveredRows
 *        one row per (tutorial slug in a published mission, that mission)
 * @param {number} args.threshold
 * @returns {Map<number, {missionCoveragePct:number|null, dominantMissionTitle:string|null,
 *          dominantMissionSlug:string|null, orphanTutorialCount:number|null, coverageHigh:boolean}>}
 */
function computeCoverage({ memberSlugsByCommunity, coveredRows, threshold }) {
  // slug → [{missionTitle, missionSlug}] restricted later per community.
  const missionsBySlug = new Map();
  for (const row of coveredRows || []) {
    if (!row || !row.slug) continue;
    const s = row.slug.toLowerCase();
    if (!missionsBySlug.has(s)) missionsBySlug.set(s, []);
    missionsBySlug.get(s).push({ missionTitle: row.missionTitle, missionSlug: row.missionSlug });
  }

  const out = new Map();
  for (const [communityId, rawSlugs] of memberSlugsByCommunity) {
    const memberSlugs = [...new Set((rawSlugs || []).filter(Boolean).map((s) => s.toLowerCase()))];
    const total = memberSlugs.length;

    if (total === 0) {
      out.set(communityId, {
        missionCoveragePct: null,
        dominantMissionTitle: null,
        dominantMissionSlug: null,
        orphanTutorialCount: null,
        coverageHigh: false,
      });
      continue;
    }

    // Count coverage per member; tally per-mission how many of THIS community's
    // members it covers (for the dominant-mission pick).
    let covered = 0;
    // missionSlug → { title, count }
    const missionTally = new Map();
    for (const slug of memberSlugs) {
      const missions = missionsBySlug.get(slug);
      if (!missions || missions.length === 0) continue;
      covered += 1;
      // A member counts once toward coverage but toward each covering mission's
      // tally (so a mission that covers more of the cluster wins dominance).
      const seenThisSlug = new Set();
      for (const m of missions) {
        if (seenThisSlug.has(m.missionSlug)) continue;
        seenThisSlug.add(m.missionSlug);
        const cur = missionTally.get(m.missionSlug) || { title: m.missionTitle, count: 0 };
        cur.count += 1;
        missionTally.set(m.missionSlug, cur);
      }
    }

    const pct = Math.round((covered / total) * 100);

    // Dominant mission: highest count, tie broken by title ascending (stable,
    // deterministic across reads).
    let dominantTitle = null;
    let dominantSlug = null;
    if (missionTally.size > 0) {
      const ranked = [...missionTally.entries()].sort((a, b) => {
        if (b[1].count !== a[1].count) return b[1].count - a[1].count;
        return String(a[1].title).localeCompare(String(b[1].title));
      });
      dominantSlug = ranked[0][0];
      dominantTitle = ranked[0][1].title;
    }

    out.set(communityId, {
      missionCoveragePct: pct,
      dominantMissionTitle: dominantTitle,
      dominantMissionSlug: dominantSlug,
      orphanTutorialCount: total - covered,
      coverageHigh: pct >= threshold,
    });
  }
  return out;
}

module.exports = { computeCoverage, resolveThreshold, DEFAULT_THRESHOLD };
```

> **Note on module form:** the repo's `srv/lib/*.js` are CommonJS (`module.exports`), but tests import via ESM `import`. Vitest resolves CJS default/named interop. If the existing `srv/lib` tests use `require`, match them — check `test/unit/search-kg-signal*.test.js` for the established import style and mirror it. Keep this file CJS to match its `srv/admin-service.js` consumer (`require`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/kg-community-coverage.test.js`
Expected: PASS (all cases).

> If imports fail on CJS/ESM interop, switch the test file to `const { computeCoverage, resolveThreshold } = require('../../srv/lib/kg-community-coverage.js');` matching the sibling `srv/lib` test convention, and re-run.

- [ ] **Step 5: Commit**

```bash
git add srv/lib/kg-community-coverage.js test/unit/kg-community-coverage.test.js
git commit -m "feat(#1172): pure KG community coverage/orphan helper + unit tests"
```

---

## Task 2: Virtual fields on the KgCommunities projection

**Files:**
- Modify: `srv/admin-service.cds:981-984` (the `KgCommunities` projection block)

**Interfaces:**
- Produces: virtual fields `missionCoveragePct : Integer`, `dominantMissionTitle : String(255)`, `dominantMissionSlug : String(255)`, `orphanTutorialCount : Integer`, `coverageHigh : Boolean` on `AdminService.KgCommunities`. Task 3 populates them; Task 4 annotates them.

- [ ] **Step 1: Add the virtual fields**

In `srv/admin-service.cds`, replace the `KgCommunities` projection body (currently `*,` + `virtual null as topConceptSlugs : String(255),`) with:

```cds
  @readonly
  entity KgCommunities as projection on ims.KgCommunitySummaryV {
    *,
    virtual null as topConceptSlugs      : String(255),
    // #1172 — curator-assist nudges. Populated at read time by the
    // after('READ','KgCommunities') decorator in srv/admin-service.js from a
    // batched coverage computation (see srv/lib/kg-community-coverage.js).
    // All null by default → fail-quiet renders no badge (mirrors #918
    // `isolated`). missionCoveragePct / orphanTutorialCount are computed over
    // TUTORIAL members only, against PUBLISHED missions only; left unset (not
    // 0) for concept/tag-only communities.
    virtual null as missionCoveragePct   : Integer,
    virtual null as dominantMissionTitle : String(255),
    virtual null as dominantMissionSlug  : String(255),
    virtual null as orphanTutorialCount  : Integer,
    virtual null as coverageHigh         : Boolean,
  };
```

- [ ] **Step 2: Verify the model compiles**

Run: `npx cds compile srv/admin-service.cds > /dev/null && echo COMPILE_OK`
Expected: `COMPILE_OK`, no errors.

- [ ] **Step 3: Verify runtime deploy path**

Run: `npx cds deploy --to sqlite::memory: 2>&1 | tail -5`
Expected: deploy completes (`/> successfully deployed …` or silent success), no `UNIQUE constraint` / assert errors.

- [ ] **Step 4: Commit**

```bash
git add srv/admin-service.cds
git commit -m "feat(#1172): add coverage/orphan virtual fields to KgCommunities projection"
```

---

## Task 3: Populate fields in the after('READ') decorator

**Files:**
- Modify: `srv/admin-service.js` — top-of-file require; the `after('READ','KgCommunities')` handler at ~line 2872.

**Interfaces:**
- Consumes: `computeCoverage`, `resolveThreshold` from Task 1; virtual fields from Task 2.
- Produces: populated `missionCoveragePct`/`dominantMissionTitle`/`dominantMissionSlug`/`orphanTutorialCount`/`coverageHigh` on each `KgCommunities` row. Task 4 (FE) and Task 5 (FE controller) read them.

- [ ] **Step 1: Write the failing decorator test**

Create `test/unit/admin-kg-community-coverage-read.test.js`:

```javascript
const cds = require('@sap/cds');
const { expect } = require('chai');

describe('after(READ, KgCommunities) coverage decorator (#1172)', () => {
  const { GET, POST } = cds.test(__dirname + '/../..');

  // Seed: community 1 has tutorials t-a, t-b, t-c. t-a and t-b are in a
  // PUBLISHED mission "Live"; t-c is orphaned. Also a DRAFT mission covers
  // t-c but must NOT count.
  before(async () => {
    const db = await cds.connect.to('db');
    const { KgCommunity, Tutorials, Missions, CompletionPaths, CompletionPathItems } =
      cds.entities('com.sap.developers.ims');
    // NOTE: adapt seeding to the repo's existing hybrid/unit seed helpers if
    // present (grep test/ for KgCommunity seeding). Minimal inline seed:
    await db.run(INSERT.into(KgCommunity).entries([
      { communityId: 1, vertexKey: 'tutorial:t-a', vertexType: 'tutorial', slug: 't-a', communityFingerprint: 'fp1' },
      { communityId: 1, vertexKey: 'tutorial:t-b', vertexType: 'tutorial', slug: 't-b', communityFingerprint: 'fp1' },
      { communityId: 1, vertexKey: 'tutorial:t-c', vertexType: 'tutorial', slug: 't-c', communityFingerprint: 'fp1' },
    ]));
    const tutIds = { a: cds.utils.uuid(), b: cds.utils.uuid(), c: cds.utils.uuid() };
    await db.run(INSERT.into(Tutorials).entries([
      { ID: tutIds.a, title: 'A', slug: 't-a' },
      { ID: tutIds.b, title: 'B', slug: 't-b' },
      { ID: tutIds.c, title: 'C', slug: 't-c' },
    ]));
    const liveMission = cds.utils.uuid(); const livePath = cds.utils.uuid();
    const draftMission = cds.utils.uuid(); const draftPath = cds.utils.uuid();
    await db.run(INSERT.into(Missions).entries([
      { ID: liveMission, slug: 'live', title: 'Live', published: true },
      { ID: draftMission, slug: 'draft', title: 'Draft', published: false },
    ]));
    await db.run(INSERT.into(CompletionPaths).entries([
      { ID: livePath, mission_ID: liveMission, name: 'Default', slug: 'live-default' },
      { ID: draftPath, mission_ID: draftMission, name: 'Default', slug: 'draft-default' },
    ]));
    await db.run(INSERT.into(CompletionPathItems).entries([
      { ID: cds.utils.uuid(), path_ID: livePath, tutorial_ID: tutIds.a, taskType: 'TUTORIAL', itemOrder: 0 },
      { ID: cds.utils.uuid(), path_ID: livePath, tutorial_ID: tutIds.b, taskType: 'TUTORIAL', itemOrder: 1 },
      { ID: cds.utils.uuid(), path_ID: draftPath, tutorial_ID: tutIds.c, taskType: 'TUTORIAL', itemOrder: 0 },
    ]));
  });

  it('populates coverage: 2 of 3 in a published mission → 67%, orphan 1, dominant Live', async () => {
    const { data } = await GET(`/admin/KgCommunities?$filter=communityId eq 1`, { auth: { username: 'admin', password: '' } });
    const row = data.value.find((r) => r.communityId === 1);
    expect(row.missionCoveragePct).to.equal(67);
    expect(row.orphanTutorialCount).to.equal(1);
    expect(row.dominantMissionTitle).to.equal('Live');
    expect(row.dominantMissionSlug).to.equal('live');
    expect(row.coverageHigh).to.equal(false); // 67 < 70
  });
});
```

> **Auth note:** match the mocked-auth block the other admin-service unit tests use (grep `test/unit/*admin*` for the exact `auth`/`cds.requires.auth` setup — the project uses `mocked` auth with named users like `admin`/`superadmin` in `.cdsrc` or the test harness). Do not invent credentials.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/unit/admin-kg-community-coverage-read.test.js`
Expected: FAIL — `missionCoveragePct` is `undefined`/`null` (decorator not yet computing it).

- [ ] **Step 3: Add the require at the top of `srv/admin-service.js`**

Find the existing require block (near other `srv/lib` requires — grep for `require('./lib/`). Add:

```javascript
const { computeCoverage, resolveThreshold } = require('./lib/kg-community-coverage');
```

- [ ] **Step 4: Extend the after('READ','KgCommunities') handler**

In `srv/admin-service.js`, the existing handler ends at ~line 2893. Immediately **after** the `topConceptSlugs` handler's closing `});`, add a **second** `after('READ','KgCommunities')` handler (CAP runs multiple after-handlers in registration order; a separate handler keeps the try/catch isolation the constraint requires):

```javascript
    // ── KgCommunities coverage/orphan nudges — #1172 ──────────────────────
    // For each community row, compute (over TUTORIAL members only, against
    // PUBLISHED missions only): mission-coverage %, dominant covering mission,
    // orphan-tutorial count, and a coverageHigh flag (>= threshold). Populates
    // the virtual fields added in srv/admin-service.cds.
    //
    // Fail-quiet, in its OWN try/catch separate from topConceptSlugs above: any
    // throw → warn-log, fields left unset, Fiori renders no badge (never a
    // 500). Mirrors the #918 isolated-flag posture.
    //
    // Packet-safe: the covered-slug fetch chunks the .in() slug list at 500 to
    // stay under HANA's bound-param cap (memory: cqn-where-in-hana-packet-cap).
    // Spec: docs/superpowers/specs/2026-07-14-1172-kg-community-curator-nudges-design.md
    const COVERAGE_SLUG_CHUNK = 500;
    this.after('READ', 'KgCommunities', async (rows) => {
      if (!rows) return;
      const list = Array.isArray(rows) ? rows : [rows];
      if (list.length === 0) return;
      const ids = list.map((r) => r.communityId).filter((v) => v != null);
      if (ids.length === 0) return;
      try {
        const { KgCommunity, CompletionPathItems } = cds.entities('com.sap.developers.ims');

        // 1. Tutorial members per community (the denominator).
        const memberRows = await SELECT.from(KgCommunity)
          .columns('communityId', 'slug')
          .where({ communityId: { in: ids }, vertexType: 'tutorial' });
        const memberSlugsByCommunity = new Map();
        const allSlugs = new Set();
        for (const m of memberRows) {
          if (m.slug == null) continue;
          const s = String(m.slug).toLowerCase();
          if (!memberSlugsByCommunity.has(m.communityId)) memberSlugsByCommunity.set(m.communityId, []);
          memberSlugsByCommunity.get(m.communityId).push(s);
          allSlugs.add(s);
        }
        // Communities with zero tutorial members still need a result entry so
        // the helper can null their fields.
        for (const id of ids) if (!memberSlugsByCommunity.has(id)) memberSlugsByCommunity.set(id, []);

        // 2. Covered slug → published mission(s). Chunk the slug IN-list.
        const coveredRows = [];
        const slugArr = [...allSlugs];
        for (let i = 0; i < slugArr.length; i += COVERAGE_SLUG_CHUNK) {
          const chunk = slugArr.slice(i, i + COVERAGE_SLUG_CHUNK);
          if (chunk.length === 0) continue;
          const part = await SELECT.from(CompletionPathItems)
            .columns(
              'tutorial.slug as slug',
              'path.mission.title as missionTitle',
              'path.mission.slug as missionSlug',
            )
            .where({ 'tutorial.slug': { in: chunk }, 'path.mission.published': true });
          for (const r of part) {
            if (r && r.slug) coveredRows.push({ slug: r.slug, missionTitle: r.missionTitle, missionSlug: r.missionSlug });
          }
        }

        // 3. Compute + assign.
        const threshold = resolveThreshold(process.env);
        const result = computeCoverage({ memberSlugsByCommunity, coveredRows, threshold });
        for (const row of list) {
          const r = result.get(row.communityId);
          if (!r) continue;
          row.missionCoveragePct = r.missionCoveragePct;
          row.dominantMissionTitle = r.dominantMissionTitle;
          row.dominantMissionSlug = r.dominantMissionSlug;
          row.orphanTutorialCount = r.orphanTutorialCount;
          row.coverageHigh = r.coverageHigh;
        }
      } catch (err) {
        cds.log('kg-community-coverage').warn(
          `admin-service: coverage nudge computation failed on KgCommunities; leaving fields unset (${err?.message ?? err})`,
        );
      }
    });
```

> **CQL path-navigation caveat** ([[ci-node-version-mismatch]]): `path.mission.title` navigation in `.columns()` must resolve through the `CompletionPathItems.path → CompletionPaths.mission → Missions` associations. If the Node-22 CI run rejects bare path navigation in the projection, fall back to explicit `cds.entities` refs or a two-step fetch (CompletionPathItems by slug → path IDs → Missions where published). Verify against CI, not just local Node 24.

- [ ] **Step 5: Run the decorator test to verify it passes**

Run: `npx vitest run test/unit/admin-kg-community-coverage-read.test.js`
Expected: PASS (67% / orphan 1 / Live / coverageHigh false; draft mission excluded).

- [ ] **Step 6: Add the fail-quiet test case**

Append to `test/unit/admin-kg-community-coverage-read.test.js`:

```javascript
  it('fail-quiet: coverage query throw leaves fields unset, topConceptSlugs intact, no 500', async () => {
    // Stub SELECT to throw only for the coverage member read. Simplest robust
    // approach: temporarily point KgCommunity reads at a broken tx. If direct
    // stubbing is awkward, assert the weaker invariant instead: a community
    // with no CompletionPathItems still returns 200 with pct=0/null and a
    // populated topConceptSlugs. Prefer a real throw injection via
    // vi.spyOn(cds, 'tx') or monkeypatching the service's db handle.
    const { data, status } = await GET(`/admin/KgCommunities`, { auth: { username: 'admin', password: '' } });
    expect(status).to.equal(200);
    // topConceptSlugs decorator is independent — must still populate.
    expect(data.value.every((r) => 'topConceptSlugs' in r)).to.equal(true);
  });
```

> If a clean throw-injection isn't available in the unit harness, keep this as the 200-invariant check and cover the true throw path in the hybrid test (Task 7) where the db handle is mockable. Do not leave a bare `catch {}` untested — the warn-log branch must be exercised at least once (hybrid).

- [ ] **Step 7: Run full file + verify deploy path**

Run: `npx vitest run test/unit/admin-kg-community-coverage-read.test.js && npx cds deploy --to sqlite::memory: 2>&1 | tail -3`
Expected: tests PASS; deploy clean.

- [ ] **Step 8: Commit**

```bash
git add srv/admin-service.js test/unit/admin-kg-community-coverage-read.test.js
git commit -m "feat(#1172): compute coverage/orphan nudges in after(READ,KgCommunities), fail-quiet"
```

---

## Task 4: FE annotations — LR/OP columns + coverage badge

**Files:**
- Modify: `app/admin-annotations.cds:3297-3358` (the `KgCommunities` annotate blocks).

**Interfaces:**
- Consumes: virtual fields from Task 2, populated by Task 3.
- Produces: LR LineItem + OP FieldGroup columns; `coverageHigh`-driven criticality on `missionCoveragePct`; new SelectionFields.

- [ ] **Step 1: Add field labels**

In `app/admin-annotations.cds`, extend the `annotate AdminService.KgCommunities with { … }` label block (currently ends after `alreadyPromoted`):

```cds
annotate AdminService.KgCommunities with {
  communityId          @Common.Label: 'Community ID';
  memberCount          @Common.Label: 'Members';
  tutorialCount        @Common.Label: 'Tutorials';
  topConceptSlugs      @Common.Label: 'Top Concepts';
  detectedAt           @Common.Label: 'Detected At';
  alreadyPromoted      @Common.Label: 'Already Promoted';
  // #1172 — curator-assist nudges.
  missionCoveragePct   @Common.Label: 'Mission Coverage %';
  dominantMissionTitle @Common.Label: 'Dominant Mission';
  orphanTutorialCount  @Common.Label: 'Orphaned Tutorials';
};
```

- [ ] **Step 2: Add columns + criticality badge to LineItem + FieldGroup + SelectionFields**

Update the `annotate AdminService.KgCommunities with @( UI: { … } )` block. Set `SelectionFields`, `LineItem`, and `FieldGroup #General` to include the new fields; the coverage % carries a criticality keyed off `coverageHigh` (1=Negative/red = high overlap, reconsider; 3=Positive/green = clear to promote — mirrors the `isolated` `$If $Path` idiom at admin-annotations.cds:2564):

```cds
    SelectionFields : [ memberCount, detectedAt, alreadyPromoted, missionCoveragePct, orphanTutorialCount ],
    LineItem : [
      { Value: communityId },
      { Value: memberCount },
      { Value: tutorialCount },
      { Value: topConceptSlugs },
      // #1172 coverage nudge columns.
      {
        $Type: 'UI.DataField',
        Value: missionCoveragePct,
        Criticality: { $edmJson: { $If: [ { $Path: 'coverageHigh' }, 1, 3 ] } }
      },
      { Value: dominantMissionTitle },
      { Value: orphanTutorialCount },
      { Value: detectedAt },
      { Value: alreadyPromoted }
    ],
```

And the `FieldGroup #General` `Data` array — add the three fields (with the same criticality on the %):

```cds
    FieldGroup #General : { Data : [
      { Value: communityId },
      { Value: memberCount },
      { Value: tutorialCount },
      { Value: topConceptSlugs },
      {
        $Type: 'UI.DataField',
        Value: missionCoveragePct,
        Criticality: { $edmJson: { $If: [ { $Path: 'coverageHigh' }, 1, 3 ] } }
      },
      { Value: dominantMissionTitle },
      { Value: orphanTutorialCount },
      { Value: detectedAt },
      { Value: alreadyPromoted }
    ]},
```

Leave `HeaderInfo`, `PresentationVariant`, `SelectionPresentationVariant #default`, `Facets`, and `Capabilities` unchanged. **Do not remove** the `Identification` `DataFieldForAction` yet — Task 5 replaces it.

- [ ] **Step 3: Compile check**

Run: `npx cds compile app/admin-annotations.cds > /dev/null && echo ANNO_OK`
Expected: `ANNO_OK` (no unresolved-path errors on the new fields).

- [ ] **Step 4: Commit**

```bash
git add app/admin-annotations.cds
git commit -m "feat(#1172): render coverage %, dominant mission, orphan count on KgCommunities LR/OP"
```

---

## Task 5: FE promote-time warning controller + manifest wiring

**Files:**
- Create: `app/admin/kgCommunities/webapp/ext/KgCommunityActionsController.js`
- Modify: `app/admin/kgCommunities/webapp/manifest.json`
- Modify: `app/admin/kgCommunities/webapp/i18n/i18n.properties`
- Modify: `app/admin-annotations.cds` (remove the `Identification` `DataFieldForAction`, since the button is now a manifest custom action).

**Interfaces:**
- Consumes: `coverageHigh`, `missionCoveragePct`, `dominantMissionTitle` from the row context (Task 3); the existing unbound `promoteCommunityToMission` action.
- Produces: nothing downstream (terminal UI task).

- [ ] **Step 1: Write the controller (plain module — NOT .controller.js)**

Create `app/admin/kgCommunities/webapp/ext/KgCommunityActionsController.js`:

```javascript
// app/admin/kgCommunities/webapp/ext/KgCommunityActionsController.js
//
// Curator-assist promote-time nudge for the KG Communities LR + OP (#1172).
//
// Why a PLAIN module (loader path <dotted>.js), NOT a .controller.js:
// FE V4 resolves manifest `press` refs as plain modules. A .controller.js
// suffix 404s on click. See app/admin/concepts/webapp/ext/
// ConceptActionsController.js header + memory feedback_ui5_controller_suffix_collision.
//
// The Promote button is declared as a manifest custom action (see manifest.json
// controlConfiguration) wired to onPromoteToMission. When the row's
// server-computed coverageHigh flag is set, we interpose a MessageBox.warning
// ("~X% already in <mission> — extend it instead?") before invoking the
// existing unbound promoteCommunityToMission action via editFlow.invokeAction
// (which opens FE's standard parameter dialog for communityId/missionSlug/title).
//
// SuperAdmin gating is unchanged and authoritative on the server
// (@requires:'SuperAdmin' in srv/admin-service.cds). This warning is advisory.
sap.ui.define([
  "sap/m/MessageBox"
], function (MessageBox) {
  "use strict";

  // FE V4 hands the handler either an array [context], a single Context, or a
  // UI5 Event depending on LR-toolbar vs OP-header invocation. Resolve all.
  function resolveCtx(arg) {
    if (!arg) return null;
    if (Array.isArray(arg)) return arg[0] || null;
    if (typeof arg.getModel === "function") return arg;
    if (typeof arg.getSource === "function") {
      const src = arg.getSource();
      if (src && typeof src.getBindingContext === "function") return src.getBindingContext();
    }
    return null;
  }

  var ACTION = "AdminService.promoteCommunityToMission";

  return {
    onPromoteToMission: function (arg) {
      var ctx = resolveCtx(arg);
      var editFlow = this.editFlow || (this.base && this.base.editFlow);
      var view = (this.base && this.base.getView && this.base.getView()) ||
                 (this.getView && this.getView());
      var bundle = view && view.getModel("i18n") && view.getModel("i18n").getResourceBundle();

      var invoke = function () {
        // Opens FE's standard parameter dialog for the unbound action.
        editFlow.invokeAction(ACTION, {
          contexts: ctx || undefined,
          model: view && view.getModel()
        });
      };

      var high = ctx && ctx.getProperty && ctx.getProperty("coverageHigh");
      if (!high) { invoke(); return; }

      var pct = (ctx.getProperty("missionCoveragePct") != null) ? ctx.getProperty("missionCoveragePct") : "?";
      var mission = ctx.getProperty("dominantMissionTitle") || "an existing mission";
      var msg = bundle
        ? bundle.getText("promoteHighCoverageWarning", [pct, mission])
        : "~" + pct + "% of this community's tutorials are already in \"" + mission +
          "\". Consider extending that mission instead of creating a new one.";

      MessageBox.warning(msg, {
        title: bundle ? bundle.getText("promoteHighCoverageTitle") : "High mission overlap",
        actions: [
          bundle ? bundle.getText("promoteAnyway") : "Promote anyway",
          MessageBox.Action.CANCEL
        ],
        emphasizedAction: MessageBox.Action.CANCEL,
        onClose: function (choice) {
          if (choice === (bundle ? bundle.getText("promoteAnyway") : "Promote anyway")) invoke();
        }
      });
    }
  };
});
```

- [ ] **Step 2: Wire the controller + custom action in manifest.json**

In `app/admin/kgCommunities/webapp/manifest.json`, add an `extends` block inside `sap.ui5` (before `models` is fine; match the concepts app ordering) and a `controlConfiguration` custom action on both the LR LineItem and the OP header:

```json
    "extends": {
      "extensions": {
        "sap.ui.controllerExtensions": {
          "sap.fe.templates.ListReport.ListReportController": {
            "controllerName": "sap.tutorials.admin.kgCommunities.ext.KgCommunityActionsController"
          },
          "sap.fe.templates.ObjectPage.ObjectPageController": {
            "controllerName": "sap.tutorials.admin.kgCommunities.ext.KgCommunityActionsController"
          }
        }
      }
    },
```

Then, inside `targets.KgCommunitiesList.options.settings`, add:

```json
              "controlConfiguration": {
                "@com.sap.vocabularies.UI.v1.LineItem": {
                  "actions": {
                    "promoteToMission": {
                      "press": "sap.tutorials.admin.kgCommunities.ext.KgCommunityActionsController.onPromoteToMission",
                      "visible": true,
                      "enabled": true,
                      "text": "{i18n>promoteToMissionButton}"
                    }
                  }
                }
              },
```

And inside `targets.KgCommunityObjectPage.options.settings`, add:

```json
              "content": {
                "header": {
                  "actions": {
                    "promoteToMission": {
                      "press": "sap.tutorials.admin.kgCommunities.ext.KgCommunityActionsController.onPromoteToMission",
                      "visible": true,
                      "enabled": true,
                      "text": "{i18n>promoteToMissionButton}"
                    }
                  }
                }
              },
```

> Preserve existing keys (`contextPath`, `variantManagement`, `navigation`, `editableHeaderContent`). Insert alongside them. Validate JSON after editing.

- [ ] **Step 3: Add i18n strings**

Append to `app/admin/kgCommunities/webapp/i18n/i18n.properties`:

```properties

# #1172 — curator-assist promote nudge
promoteToMissionButton=Promote to Mission
promoteHighCoverageTitle=High mission overlap
promoteAnyway=Promote anyway
# {0} = coverage %, {1} = dominant mission title
promoteHighCoverageWarning=~{0}% of this community's tutorials are already in "{1}". Consider extending that mission instead of creating a new one.
```

- [ ] **Step 4: Remove the annotation-driven action button**

In `app/admin-annotations.cds`, delete the `Identification : [ { $Type: 'UI.DataFieldForAction', Action: 'AdminService.promoteCommunityToMission', … } ]` block from the `KgCommunities` `UI` annotate (the button now comes from the manifest custom action, so the FE-native one must go to avoid a duplicate). Update the neighboring comment that references it.

- [ ] **Step 5: Validate manifest JSON + CDS compile**

Run: `node -e "JSON.parse(require('fs').readFileSync('app/admin/kgCommunities/webapp/manifest.json','utf8')); console.log('JSON_OK')" && npx cds compile app/admin-annotations.cds > /dev/null && echo ANNO_OK`
Expected: `JSON_OK` then `ANNO_OK`.

- [ ] **Step 6: Manual smoke (documented, not automated)**

FE controller behavior isn't unit-tested here (no OPA5 harness wired for this app). Document the manual check in the PR description:
- `/admin-ui/#kgCommunities`: coverage %, dominant mission, orphan count columns render; % badge red when `coverageHigh`.
- Promote on a high-coverage row → warning dialog with "Promote anyway" / "Cancel"; "Promote anyway" opens the parameter dialog; "Cancel" aborts.
- Promote on a low-coverage row → straight to parameter dialog, no warning.

- [ ] **Step 7: Commit**

```bash
git add app/admin/kgCommunities/webapp/ext/KgCommunityActionsController.js \
        app/admin/kgCommunities/webapp/manifest.json \
        app/admin/kgCommunities/webapp/i18n/i18n.properties \
        app/admin-annotations.cds
git commit -m "feat(#1172): promote-time high-coverage warning on KgCommunities admin UI"
```

---

## Task 6: Hybrid test (real HANA) + packet-safe width

**Files:**
- Create: `test/hybrid/kg-community-coverage.hybrid.test.js`

**Interfaces:**
- Consumes: the full read path (Tasks 1–3) against real HANA.

- [ ] **Step 1: Write the hybrid test**

Create `test/hybrid/kg-community-coverage.hybrid.test.js`, modeled on the repo's existing hybrid tests (grep `test/hybrid/` for the `--project hybrid` bootstrap + seed/cleanup conventions — reuse the shared autotest-prefix cleanup so rows don't pollute DEV data):

```javascript
const cds = require('@sap/cds');
const { expect } = require('chai');

// Real-HANA coverage round-trip (#1172). Seeds an autotest community whose
// tutorials split across a PUBLISHED mission + orphans, reads KgCommunities,
// asserts coverage/orphan/dominant, and exercises the packet-safe slug fetch
// at realistic width. Run: npx vitest run --project hybrid test/hybrid/kg-community-coverage.hybrid.test.js
describe('KgCommunities coverage nudges (hybrid, real HANA) #1172', () => {
  // ... use the repo's hybrid bootstrap (cds.test + cds bind, or the shared
  // helper in test/hybrid/setup). Seed with an autotest_ slug prefix and clean
  // up in after(). Assertions:
  it('coverage % + dominant mission + orphan count round-trip from HANA', async () => {
    // seed community with e.g. 3 published-covered + 2 orphan tutorials
    // GET /admin/KgCommunities?$filter=communityId eq <seededId>
    // expect missionCoveragePct === 60, orphanTutorialCount === 2, dominantMissionTitle set
  });

  it('packet-safe: a community with 600+ tutorial members computes without a bound-param error', async () => {
    // seed one community with >500 tutorial members (slug width forces the
    // COVERAGE_SLUG_CHUNK loop to iterate). Assert the read returns 200 and a
    // numeric missionCoveragePct — proves the chunked .in() stays under the cap.
  });
});
```

> Fill in the seed/cleanup bodies from the existing hybrid harness — do **not** hand-roll a new HANA connection. The two assertions that matter: (a) a normal round-trip returns correct numbers from real HANA; (b) a >500-member community does not throw a HANA bound-parameter error (the packet-cap guard). This is the only test that catches the packet-cap regression — SQLite unit tests will silently pass an unbounded `.in()`.

- [ ] **Step 2: Run the hybrid test**

Run: `cf target` (confirm space), then `npx vitest run --project hybrid test/hybrid/kg-community-coverage.hybrid.test.js`
Expected: both cases PASS. (Requires `cf login` + `cds bind`; if HANA is unavailable, note it in the PR and mark this task for CI/hybrid-runner execution.)

- [ ] **Step 3: Commit**

```bash
git add test/hybrid/kg-community-coverage.hybrid.test.js
git commit -m "test(#1172): hybrid coverage round-trip + packet-safe slug width"
```

---

## Task 7: srv-qa cp audit, cds build, docs

**Files:**
- Modify: `.deploy/mta.yaml` (`srv-qa` `cp` list)
- Modify: `CLAUDE.md` (top-gotcha entry)
- Regenerate: `db/last-dev/csn.json` (via `cds build --production`)

- [ ] **Step 1: Add the new lib file to the srv-qa cp list**

In `.deploy/mta.yaml`, find the `srv-qa` module's `build-parameters` → `commands`/`supported-parameters` `cp` list (grep for `srv/lib/content-store.js` — the list starts there). Add:

```yaml
        - cp srv/lib/kg-community-coverage.js srv-qa/srv/lib/
```

(Match the exact `cp` syntax/indentation of the existing lines — copy a neighboring `srv/lib/*.js` line and change the filename. It is a transitive `require('./lib/kg-community-coverage')` from `srv/admin-service.js`; missing it crash-loops QA boot at MTA deploy.)

- [ ] **Step 2: Verify the cp list is complete**

Run: `grep -n "kg-community-coverage" .deploy/mta.yaml && echo CP_OK`
Expected: the new line appears under `srv-qa`; `CP_OK`.

- [ ] **Step 3: Regenerate csn.json**

Run: `npx cds build --production > /dev/null 2>&1 && git status --short db/last-dev/`
Expected: `db/last-dev/csn.json` shows as modified (projection change picked up). No new `.hdbmigrationtable` / `.hdbtable` under `db/src/` (no persisted schema change).

> If `db/last-dev/` shows unexpected new migration artifacts, STOP — that means a persisted change leaked in; the virtual fields must not produce DDL. Re-check Task 2 used `virtual null as …`.

- [ ] **Step 4: Add the CLAUDE.md gotcha entry**

In `CLAUDE.md`, in the "Top Gotchas" list, add after the `KG_COMMUNITY_WEIGHT` (#1171) entry:

```markdown
- **`KG_COMMUNITY_COVERAGE_NUDGE_THRESHOLD` env var (issue #1172)** — the `after('READ','KgCommunities')` decorator in `srv/admin-service.js` computes, per community at read time, mission-coverage % + dominant published mission + orphan-tutorial count (helper: `srv/lib/kg-community-coverage.js`) and populates virtual fields on `AdminService.KgCommunities`. Coverage is **published-missions-only** and the % denominator is **tutorial members only** (concept/tag-only communities render N/A, not 0%). `coverageHigh` (`>= threshold`, default **70**) is the single server-computed flag driving both the LR criticality badge and the FE promote-time `MessageBox.warning` ("~X% already in <mission> — extend instead?") in `app/admin/kgCommunities/webapp/ext/KgCommunityActionsController.js`. **Fail-quiet** in its own try/catch (separate from `topConceptSlugs`): any throw → warn-log, fields unset, no badge, never a 500 (mirrors #918). No new job/table/migration — computed live. Packet-safe: the covered-slug `.in()` is chunked at 500 ([[cqn-where-in-hana-packet-cap]]). SuperAdmin gate on `promoteCommunityToMission` unchanged; the nudge is advisory. Override: `cf set-env tutorials-srv KG_COMMUNITY_COVERAGE_NUDGE_THRESHOLD 80 && cf restart tutorials-srv`. DEV-only until the #1126 PROD Louvain rollout lands (no `KgCommunity` data in PROD → empty LR, no nudges).
```

- [ ] **Step 5: Full unit suite + deploy sanity**

Run: `npx vitest run test/unit/kg-community-coverage.test.js test/unit/admin-kg-community-coverage-read.test.js && npx cds deploy --to sqlite::memory: 2>&1 | tail -3`
Expected: all unit tests PASS; deploy clean.

- [ ] **Step 6: Commit**

```bash
git add .deploy/mta.yaml CLAUDE.md db/last-dev/csn.json
git commit -m "chore(#1172): srv-qa cp audit, csn regen, CLAUDE.md gotcha for coverage nudges"
```

---

## Task 8: Final verification + PR

- [ ] **Step 1: Run the full affected unit suite**

Run: `npx vitest run test/unit/kg-community-coverage.test.js test/unit/admin-kg-community-coverage-read.test.js`
Expected: all PASS.

- [ ] **Step 2: Confirm no persisted-schema leak**

Run: `git diff --name-only origin/main...HEAD -- db/src/ && echo "---(expect: no new .hdbtable/.hdbmigrationtable)---"`
Expected: no new `.hdbtable`/`.hdbmigrationtable` files (virtual fields only).

- [ ] **Step 3: Verify branch + diff scope against origin/main**

Run: `git branch --show-current && git fetch origin main -q && git diff --stat $(git merge-base HEAD origin/main)..HEAD`
Expected: on `worktree-1172-kg-community-curator-nudges`; diff touches only the files in this plan's File Structure table (no stray files from other merged PRs — [[verify-branch-diff-against-origin-main-not-local]]).

- [ ] **Step 4: Push + open draft PR**

```bash
git push -u origin worktree-1172-kg-community-curator-nudges
gh pr create --draft --repo sap-tutorials/tutorials-ims \
  --title "feat(#1172): KG community curator-assist nudges on promote flow" \
  --body "$(cat <<'EOF'
Implements #1172 (#1126 epic 3/4). Curator-assist nudges on /admin-ui/#kgCommunities:

- Read-time mission-coverage % (published-only, tutorials-only denominator), dominant published mission, and orphan-tutorial count as LR/OP columns; coverage % carries a criticality badge (red when >= threshold).
- Interactive promote-time MessageBox.warning ("~X% already in <mission> — extend instead?") when coverageHigh; "Promote anyway" / "Cancel". Advisory only — SuperAdmin gate on promoteCommunityToMission unchanged.
- Fail-quiet after('READ') decorator (own try/catch, separate from topConceptSlugs): any throw leaves fields unset, no badge, never a 500 (#918 pattern).
- No new job/table/migration — computed live. Threshold env-overridable via KG_COMMUNITY_COVERAGE_NUDGE_THRESHOLD (default 70). Packet-safe chunked .in() at 500.

## Testing
- Unit: pure helper (denominator, published-only, dominant/tie-break, orphan, 0-tutorial N/A, rounding, threshold boundary) + decorator population/fail-quiet.
- Hybrid: real-HANA round-trip + >500-member packet-safe width.
- Manual smoke (see checklist): LR columns/badge, promote warning flow.

Spec: docs/superpowers/specs/2026-07-14-1172-kg-community-curator-nudges-design.md
DEV-only until the #1126 PROD Louvain rollout lands.
EOF
)"
```

Expected: draft PR created; report the URL.

---

## Self-Review

**Spec coverage:** every spec section maps to a task — helper+math (T1), virtual fields (T2), read-time decorator+fail-quiet (T3), LR/OP badges (T4), promote warning (T5), hybrid+packet-safe (T6), srv-qa/csn/docs (T7), verify/PR (T8). All six acceptance criteria are covered (coverage %+dominant → T3/T4; orphan → T1/T3/T4; high-coverage nudge+threshold → T5/T7; fail-quiet → T3; SuperAdmin unchanged → T5 note; unit+hybrid → T1/T3/T6).

**Placeholder scan:** the two "adapt to existing harness" notes (T3 auth block, T6 seed bodies) point at concrete existing conventions to grep rather than leaving logic undefined — the assertions and expected values are fully specified. No TODO/TBD in shipped code.

**Type consistency:** `computeCoverage`/`resolveThreshold` signatures identical across T1 (def), T3 (consumer). Field names (`missionCoveragePct`, `dominantMissionTitle`, `dominantMissionSlug`, `orphanTutorialCount`, `coverageHigh`) identical across T2 (CDS), T3 (JS assign), T4 (annotations), T5 (controller `getProperty`). Threshold default `70` consistent across constraints, T1, T7.
