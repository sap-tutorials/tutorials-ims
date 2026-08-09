# Topics Discovery Front Door — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a new `/topics/` front door that turns the flat 5,946-concept list into a browsable gallery of labeled topic clusters, each with a suggested learning path, backed by a stable-slug reconciliation pipeline and a Sigma cluster map that hands off to `/explore/`.

**Architecture:** Hugo-bake model (like #1170 + `/explore/`). A nightly job reconciles Louvain communities into a stable-slug `TopicClusters` sidecar; a `/build/topics-gallery` feed exposes the gallery/detail data; a fetch script writes `hugo/data/topics_gallery.json`; Hugo layouts bake the gallery (`/topics/`) and every cluster-detail page (`/topics/<slug>/`) as static HTML. A Sigma-based Vue island renders the cluster map from a new `/graph/clusters-data` endpoint and deep-links into `/explore/`. An admin FE app allows label overrides and hiding clusters.

**Tech Stack:** CAP Node.js (`@sap/cds`), SAP HANA Cloud, Hugo, Vue 3 + Sigma.js v3 + graphology + ForceAtlas2, Vite (hugo-apps islands), Fiori Elements (admin), Vitest.

## Global Constraints

- **Node baseline** Node 20+ (project); CI runs Node 22, local Node 24 — avoid version-drift patterns (`cds.entities(NS)` not bare `SELECT.from('X')`).
- **Never write raw SQL in service/handler layer** — use `cds.ql` / CQL. EXCEPTION: nightly job sidecar TRUNCATE+INSERT uses raw quoted-uppercase SQL (established pattern: the job may run via `cf run-task node -e` where `cds.entities()` is undefined). HANA columns are UPPERCASE in raw SQL.
- **Route name** `/topics/` (front door) + `/topics/<slug>/` (detail). No approuter route change — served via catch-all → Hugo static.
- **Namespace** `com.sap.developers.ims` (constant `NS`). Entity handles via `cds.entities(NS)`.
- **Slugs are lowercase canonical** — always `.toLowerCase()` before comparing/writing.
- **Distinct names** from #1170/#1032 — use `topics-gallery`, `topics-map`, `.topics-*` CSS. Do NOT modify `build-topic-clusters.js`, `topic-clusters-band.html`, or `hugo/data/topic_clusters.json` (the #1170 band).
- **Fail-open everywhere** — nightly job throws (scheduler logs FAILED, keeps prior sidecar rows); build feeds return empty payload with an `error` field on throw; islands degrade to the baked static page.
- **New split `db/*.cds` entity projected in a service needs an explicit bare `using`** at the top of the service `.cds` (#1531) or `build:sdl` breaks even when `cds build --production` + CI pass.
- **Run `npx cds deploy --to sqlite::memory:`** before committing any `db/**/*.cds` change (`@assert.unique.*` is runtime-only).
- **New DB view / metric names** — metric names capped at 64 chars (`MetricSnapshots.metric String(64)`).
- **Commit frequently** — one commit per task minimum; conventional-commit messages (`feat:`, `test:`, `docs:`).
- **PR, never direct-merge to main** — even if told "merge it."

---

## File Structure

**Phase 1 — Data pipeline (entity + nightly reconciliation job):**
- Create: `db/knowledge-graph-topic-clusters.cds` — `TopicClusters` sidecar entity (stable slug ↔ fingerprint + history + status + curatedLabel).
- Create: `srv/lib/topic-cluster-reconcile.js` — pure Jaccard reconciliation logic (no I/O; testable in isolation).
- Create: `srv/jobs/kg-topic-clusters-job.js` — nightly job: read communities, reconcile, TRUNCATE+INSERT sidecar.
- Modify: `srv/jobs/scheduler.js` — register the job (`04:47`).

**Phase 2 — Gallery data feed + Hugo-baked pages:**
- Create: `srv/lib/build-topics-gallery.js` — `/build/topics-gallery` payload builder (gallery cards + per-cluster detail incl. suggested-order path).
- Create: `srv/lib/topic-path-order.js` — pure topo-ish sort over `requires` edges with PageRank tiebreak + thin-data fallback.
- Modify: `srv/server.js` — register `GET /build/topics-gallery`.
- Modify: `approuter/xs-app.json` — add `topics-gallery` to the `/build/*` allowlist regex (line ~383).
- Create: `scripts/fetch-topics-gallery.ts` — build-time fetch → `hugo/data/topics_gallery.json`.
- Modify: `package.json` — add `fetch-topics-gallery` script + wire into `build:all`.
- Create: `hugo/content/topics/_index.md` — gallery page stub.
- Create: `hugo/layouts/topics/list.html` — gallery layout (cards + filter island mount + map island mount).
- Create: `hugo/layouts/topics/single.html` — cluster-detail layout (suggested path + all concepts + peer clusters).
- Create: `hugo/assets/css/topics.css` (or inline) — `.topics-*` styles.

**Phase 3 — Cluster map endpoint + Sigma island + /explore/ deep-link:**
- Create: `srv/lib/kg-clusters-data.js` — pure builder for `{nodes, edges}` cluster super-graph + per-cluster subgraph.
- Create: `srv/lib/build-clusters-data.js` — cached Express handler wrapper.
- Modify: `srv/server.js` — register `GET /graph/clusters-data`.
- Modify: `scripts/check-public-endpoints.ts` — allowlist `/graph/clusters-data` if public.
- Create: `hugo-apps/src/topics-map/{main.ts,App.vue,ClusterMap.vue}` — Sigma island.
- Modify: `hugo-apps/vite.config.ts` — add `topics-map` rollup input + gzip budget.
- Modify: `app/explore/src/App.vue` (+ maybe a composable) — read `?focus=<slug>` / `?cluster=<slug>` and pre-focus camera.

**Phase 4 — Admin surface + homepage tie-in:**
- Modify: `srv/admin-service.cds` — `TopicClusters` projection (+ virtual rollup fields) + `overrideTopicLabel` / `hideTopicCluster` actions.
- Modify: `srv/admin-service.js` — `after('READ')` virtual compute + action handlers.
- Modify: `app/admin-annotations.cds` — `TopicClusters` LR/OP annotations.
- Create: `app/admin/topicClusters/webapp/{Component.js,manifest.json,i18n,ext/}` — admin FE app.
- Modify: `app/admin-shell/webapp/model/navigation.json` + `app/admin-shell/scripts/admin-shell-overrides.js` — nav + prefix `tc`.
- Modify: `hugo/layouts/partials/homepage/topic-clusters-band.html` — add "See all topics →" link.

---

## Phase 1 — Data pipeline: stable-slug reconciliation

**Deliverable:** a `TopicClusters` sidecar populated nightly, mapping stable human slugs to current Louvain fingerprints, surviving membership drift.

### Task 1: `TopicClusters` entity

**Files:**
- Create: `db/knowledge-graph-topic-clusters.cds`
- Test: `test/unit/srv/topic-clusters-model.test.js`

**Interfaces:**
- Produces: entity `com.sap.developers.ims.TopicClusters` with fields `slug` (key, String 80), `label` (String 120), `curatedLabel` (String 120, nullable), `fingerprint` (String 64), `previousFingerprints` (String 2000, newline-joined history), `status` (String 20, ACTIVE|RETIRED), `hidden` (Boolean default false), `memberCount` (Integer), `tutorialCount` (Integer), `computedAt` (Timestamp).

- [ ] **Step 1: Write the failing test** (`test/unit/srv/topic-clusters-model.test.js`)

```js
import { describe, it, expect } from 'vitest';
import cds from '@sap/cds';

describe('TopicClusters model', () => {
  it('compiles and exposes stable-slug key + fingerprint fields', async () => {
    const model = await cds.load(['db/knowledge-graph.cds', 'db/knowledge-graph-communities.cds', 'db/knowledge-graph-topic-clusters.cds']);
    const e = model.definitions['com.sap.developers.ims.TopicClusters'];
    expect(e).toBeTruthy();
    expect(e.elements.slug.key).toBe(true);
    expect(e.elements.fingerprint.length).toBe(64);
    expect(e.elements.status).toBeTruthy();
    expect(e.elements.curatedLabel).toBeTruthy();
    expect(e.elements.hidden).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/srv/topic-clusters-model.test.js`
Expected: FAIL — `TopicClusters` undefined / file not found.

- [ ] **Step 3: Write the entity** (`db/knowledge-graph-topic-clusters.cds`)

Model on the plain-derived-sidecar pattern (`ConceptRank` in `db/knowledge-graph.cds:188` — `@cds.autoexpose:false`, natural key, NOT managed; nightly TRUNCATE+INSERT overwrite semantics). Uses `namespace com.sap.developers.ims;` to match sibling files.

```cds
namespace com.sap.developers.ims;

// Stable-slug <-> current-Louvain-fingerprint mapping for the /topics/ front door.
// Nightly TRUNCATE+INSERT by srv/jobs/kg-topic-clusters-job.js. NOT managed
// (rebuilt-from-scratch aggregate; computedAt captures batch time).
@cds.autoexpose: false
entity TopicClusters {
  key slug                 : String(80);   // stable, derived from label once, never changes
      label                : String(120);  // current LLM label (from KgCommunityLabel)
      curatedLabel         : String(120);  // optional admin override; wins over label at render
      fingerprint          : String(64);   // CURRENT Louvain fingerprint this slug points to
      previousFingerprints : String(2000); // newline-joined history of prior fingerprints
      status               : String(20)  default 'ACTIVE';  // ACTIVE | RETIRED
      hidden               : Boolean      default false;     // admin can hide junk clusters from gallery
      memberCount          : Integer;
      tutorialCount        : Integer;
      computedAt           : Timestamp;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/srv/topic-clusters-model.test.js`
Expected: PASS.

- [ ] **Step 5: Verify SQLite deploy** (catches `@assert`/model errors early)

Run: `npx cds deploy --to sqlite::memory: 2>&1 | tail -5`
Expected: no compile error; deploy completes.

- [ ] **Step 6: Commit**

```bash
git add db/knowledge-graph-topic-clusters.cds test/unit/srv/topic-clusters-model.test.js
git commit -m "feat(topics): add TopicClusters stable-slug sidecar entity"
```

---

### Task 2: Pure reconciliation logic (Jaccard matching)

**Files:**
- Create: `srv/lib/topic-cluster-reconcile.js`
- Test: `test/unit/srv/topic-cluster-reconcile.test.js`

**Interfaces:**
- Consumes: nothing (pure).
- Produces:
  - `slugify(label)` -> stable lowercase slug (`String -> String`); collision-suffix handled internally per run.
  - `jaccard(setA, setB)` -> number in [0,1] over two arrays of member slugs.
  - `reconcile({ existing, communities, threshold })` -> `{ upserts, retired }`:
    - `existing` = array of prior rows `{ slug, fingerprint, previousFingerprints, status, memberSlugs[] }` (job augments each with the member slugs of the community currently carrying its stored fingerprint; `[]` if that fingerprint vanished).
    - `communities` = array of `{ fingerprint, label, memberSlugs[], memberCount, tutorialCount }` (current nightly Louvain).
    - `threshold` = Jaccard floor (default 0.5).
    - `upserts` = array of `{ slug, label, fingerprint, previousFingerprints, status:'ACTIVE', memberCount, tutorialCount }`.
    - `retired` = array of slugs (existing ACTIVE clusters matched by no current community).

Rule: for each current community, find the unused existing cluster with highest Jaccard >= threshold; if found -> keep slug, roll fingerprint, append old fingerprint to history. Else mint a new slug from the label (dedupe with numeric suffix). Existing ACTIVE clusters not matched -> retired.

- [ ] **Step 1: Write the failing test**

```js
import { describe, it, expect } from 'vitest';
import { slugify, jaccard, reconcile } from '../../../srv/lib/topic-cluster-reconcile.js';

describe('slugify', () => {
  it('lowercases, hyphenates, strips punctuation', () => {
    expect(slugify('RAP & Clean Core Development')).toBe('rap-clean-core-development');
    expect(slugify('SAP HANA Cloud Data Management')).toBe('sap-hana-cloud-data-management');
  });
});

describe('jaccard', () => {
  it('is 1 for identical sets, 0 for disjoint', () => {
    expect(jaccard(['a','b'], ['a','b'])).toBe(1);
    expect(jaccard(['a'], ['b'])).toBe(0);
  });
  it('computes intersection/union', () => {
    expect(jaccard(['a','b','c'], ['b','c','d'])).toBeCloseTo(2/4);
  });
});

describe('reconcile', () => {
  it('keeps slug and rolls fingerprint when a drifted community matches by overlap', () => {
    const existing = [{ slug: 'hana-cloud', fingerprint: 'OLD', previousFingerprints: '', status: 'ACTIVE', memberSlugs: ['t1','t2','t3'] }];
    const communities = [{ fingerprint: 'NEW', label: 'HANA Cloud', memberSlugs: ['t1','t2','t4'], memberCount: 3, tutorialCount: 3 }];
    const { upserts, retired } = reconcile({ existing, communities, threshold: 0.4 });
    expect(retired).toEqual([]);
    expect(upserts).toHaveLength(1);
    expect(upserts[0].slug).toBe('hana-cloud');
    expect(upserts[0].fingerprint).toBe('NEW');
    expect(upserts[0].previousFingerprints).toBe('OLD');
  });

  it('mints a new slug for a genuinely new community', () => {
    const existing = [];
    const communities = [{ fingerprint: 'F1', label: 'ABAP Cloud', memberSlugs: ['a'], memberCount: 1, tutorialCount: 1 }];
    const { upserts } = reconcile({ existing, communities, threshold: 0.5 });
    expect(upserts[0].slug).toBe('abap-cloud');
    expect(upserts[0].previousFingerprints).toBe('');
  });

  it('retires an existing cluster with no matching community', () => {
    const existing = [{ slug: 'gone', fingerprint: 'X', previousFingerprints: '', status: 'ACTIVE', memberSlugs: ['z'] }];
    const communities = [{ fingerprint: 'F', label: 'New', memberSlugs: ['a','b'], memberCount: 2, tutorialCount: 2 }];
    const { upserts, retired } = reconcile({ existing, communities, threshold: 0.5 });
    expect(retired).toContain('gone');
    expect(upserts.map(u => u.slug)).toContain('new');
  });

  it('dedupes minted slugs with a numeric suffix', () => {
    const communities = [
      { fingerprint: 'A', label: 'SAP Build', memberSlugs: ['a'], memberCount: 1, tutorialCount: 1 },
      { fingerprint: 'B', label: 'SAP Build', memberSlugs: ['b'], memberCount: 1, tutorialCount: 1 },
    ];
    const { upserts } = reconcile({ existing: [], communities, threshold: 0.5 });
    const slugs = upserts.map(u => u.slug).sort();
    expect(slugs).toEqual(['sap-build', 'sap-build-2']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/srv/topic-cluster-reconcile.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation** (`srv/lib/topic-cluster-reconcile.js`)

```js
// Pure reconciliation logic for the /topics/ stable-slug pipeline.
// No I/O — the nightly job resolves member sets and passes them in.

export function slugify(label) {
  return String(label || '')
    .toLowerCase()
    .replace(/&/g, ' ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

export function jaccard(a, b) {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === 0 && setB.size === 0) return 0;
  let inter = 0;
  for (const x of setA) if (setB.has(x)) inter += 1;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

export function reconcile({ existing = [], communities = [], threshold = 0.5 }) {
  const usedExisting = new Set();
  const assignedSlugs = new Set();
  const upserts = [];

  const mintSlug = (label) => {
    const base = slugify(label) || 'topic';
    let candidate = base;
    let n = 2;
    while (assignedSlugs.has(candidate)) candidate = `${base}-${n++}`;
    assignedSlugs.add(candidate);
    return candidate;
  };

  for (const c of communities) {
    let best = null;
    let bestScore = 0;
    for (const ex of existing) {
      if (usedExisting.has(ex.slug)) continue;
      const score = jaccard(c.memberSlugs || [], ex.memberSlugs || []);
      if (score > bestScore) { bestScore = score; best = ex; }
    }
    if (best && bestScore >= threshold) {
      usedExisting.add(best.slug);
      assignedSlugs.add(best.slug);
      const history = [best.previousFingerprints, best.fingerprint].filter(Boolean).join('\n').slice(0, 2000);
      upserts.push({
        slug: best.slug,
        label: c.label,
        fingerprint: c.fingerprint,
        previousFingerprints: history,
        status: 'ACTIVE',
        memberCount: c.memberCount,
        tutorialCount: c.tutorialCount,
      });
    } else {
      upserts.push({
        slug: mintSlug(c.label),
        label: c.label,
        fingerprint: c.fingerprint,
        previousFingerprints: '',
        status: 'ACTIVE',
        memberCount: c.memberCount,
        tutorialCount: c.tutorialCount,
      });
    }
  }

  const retired = existing
    .filter((ex) => ex.status === 'ACTIVE' && !usedExisting.has(ex.slug))
    .map((ex) => ex.slug);

  return { upserts, retired };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/srv/topic-cluster-reconcile.test.js`
Expected: PASS (all 6).

- [ ] **Step 5: Commit**

```bash
git add srv/lib/topic-cluster-reconcile.js test/unit/srv/topic-cluster-reconcile.test.js
git commit -m "feat(topics): pure Jaccard reconciliation for stable cluster slugs"
```

---

### Task 3: Nightly job + scheduler registration

**Files:**
- Create: `srv/jobs/kg-topic-clusters-job.js`
- Modify: `srv/jobs/scheduler.js` (import near line 55; `registerJob` block after the `kg-community-labels` block ~line 665)
- Test: `test/unit/srv/kg-topic-clusters-job.test.js` (logic-level, deps injected) + `test/hybrid/topic-clusters-job-hybrid.test.js` (real HANA)

**Interfaces:**
- Consumes: `reconcile`, `jaccard` from `topic-cluster-reconcile.js`; `cds.entities(NS)` for `KgCommunity`, `KgCommunityLabel`, `KgCommunitySummaryV`; metrics helper.
- Produces: `export async function runKgTopicClusters(logId)` returning `{ clusters, minted, reused, retired, durationMs }`; `export default { runKgTopicClusters }`. Also exports `_buildCommunitiesInput(db)` (testable read helper) returning `{ communities, existing }` shaped for `reconcile`.

**Key mechanics (from recon):**
- Table constant quoted-uppercase: `const TABLE = '"COM_SAP_DEVELOPERS_IMS_TOPICCLUSTERS"';`
- Read all `KgCommunity` memberships once, bucket by `communityFingerprint` in JS (label-job pattern). Member set for matching = tutorial-typed slugs (lowercased). Only communities that have a `KgCommunityLabel` row qualify (unlabeled/tiny clusters excluded — the gallery needs a label).
- `memberCount` = distinct members of all types; `tutorialCount` from `KgCommunitySummaryV`.
- Reconcile against the CURRENT `TopicClusters` rows. To supply `existing[].memberSlugs`, map each existing row's stored `fingerprint` back to this run's community member set (0-overlap if the fingerprint vanished — correctly forces remint/retire).
- Write: one `db.tx` — `TRUNCATE TABLE ${TABLE}`, then batched `INSERT` of every `upsert` (status ACTIVE) plus retired slugs re-inserted with `status='RETIRED'` (so retired clusters keep their slug for a 301, per spec). `computedAt = new Date().toISOString()`.
- Fail-open: on any throw, `metrics.counter('kg_topic_clusters_failures')` then `throw err` — the scheduler chassis logs `PipelineLog FAILED` and yesterday's rows remain (TRUNCATE only runs inside the tx which rolls back on throw).
- Metrics: `observe('kg_topic_clusters_duration_ms', ms)`, `gauge('kg_topic_clusters_count', n)`, `gauge('kg_topic_clusters_minted', m)`, `gauge('kg_topic_clusters_reused', r)`, `gauge('kg_topic_clusters_retired', x)`.

- [ ] **Step 1: Write the failing unit test** (`test/unit/srv/kg-topic-clusters-job.test.js`)

Test the reconcile-integration seam with a fake `db` that returns canned community rows, asserting the job computes the right upsert/retire split. Use `cds.test` in-memory per the project bootstrap rule (bare `cds.deploy(cds.model)` is broken here).

```js
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

describe('runKgTopicClusters (logic)', () => {
  let job;
  beforeAll(async () => { job = await import('../../../srv/jobs/kg-topic-clusters-job.js'); });

  it('builds reconcile input: one community per labeled fingerprint with tutorial member slugs', async () => {
    const fakeDb = {
      run: async (q) => {
        const s = String(q);
        if (s.includes('KgCommunityLabel') || q?.SELECT?.from?.ref?.[0]?.includes?.('KgCommunityLabel')) {
          return [{ communityFingerprint: 'FP1', label: 'HANA Cloud', rationale: 'r' }];
        }
        if (s.includes('KgCommunity')) {
          return [
            { communityFingerprint: 'FP1', vertexType: 'tutorial', slug: 'T1' },
            { communityFingerprint: 'FP1', vertexType: 'concept', slug: 'c1' },
          ];
        }
        if (s.includes('TopicClusters')) return [];
        return [];
      },
    };
    const { communities, existing } = await job._buildCommunitiesInput(fakeDb);
    expect(existing).toEqual([]);
    expect(communities).toHaveLength(1);
    expect(communities[0].fingerprint).toBe('FP1');
    expect(communities[0].memberSlugs).toContain('t1'); // lowercased tutorial slug
    expect(communities[0].label).toBe('HANA Cloud');
  });
});
```

> NOTE to implementer: the fake-`db` query discrimination above is illustrative — implement `_buildCommunitiesInput` with explicit `SELECT.from(KgCommunityLabel)` / `SELECT.from(KgCommunity)` / `SELECT.from(TopicClusters)` via `cds.entities(NS)` and adjust the test's fake to match how you branch (e.g. inspect `q.SELECT.from.ref`). Keep the assertions (lowercasing, one-community-per-labeled-fingerprint, empty existing) intact.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/srv/kg-topic-clusters-job.test.js`
Expected: FAIL — module/`_buildCommunitiesInput` not found.

- [ ] **Step 3: Write the job** (`srv/jobs/kg-topic-clusters-job.js`)

```js
import cds from '@sap/cds';
import * as metrics from '../lib/metrics.js';
import { reconcile } from '../lib/topic-cluster-reconcile.js';

const LOG = cds.log('kg-topic-clusters');
const NS = 'com.sap.developers.ims';
const TABLE = '"COM_SAP_DEVELOPERS_IMS_TOPICCLUSTERS"';
const INSERT_BATCH_SIZE = 500;
const JACCARD_THRESHOLD = Number(process.env.KG_TOPIC_CLUSTERS_JACCARD || '0.5');

// Read KgCommunityLabel + KgCommunity + KgCommunitySummaryV + current TopicClusters,
// shape into { communities, existing } for reconcile(). Exported for unit testing.
export async function _buildCommunitiesInput(db) {
  const { KgCommunity, KgCommunityLabel, KgCommunitySummaryV, TopicClusters } = cds.entities(NS);

  const labels = await db.run(SELECT.from(KgCommunityLabel).columns('communityFingerprint', 'label'));
  const labelByFp = new Map(labels.map((l) => [l.communityFingerprint, l.label]));

  const members = await db.run(SELECT.from(KgCommunity).columns('communityFingerprint', 'vertexType', 'slug'));
  const tutMembersByFp = new Map();   // fp -> Set(tutorial slugs, lowercased)
  const allMembersByFp = new Map();   // fp -> Set(all slugs)
  for (const m of members) {
    if (!m.communityFingerprint || !m.slug) continue;
    const fp = m.communityFingerprint;
    (allMembersByFp.get(fp) || allMembersByFp.set(fp, new Set()).get(fp)).add(m.slug.toLowerCase());
    if (m.vertexType === 'tutorial') {
      (tutMembersByFp.get(fp) || tutMembersByFp.set(fp, new Set()).get(fp)).add(m.slug.toLowerCase());
    }
  }

  const summaries = await db.run(SELECT.from(KgCommunitySummaryV).columns('communityFingerprint', 'tutorialCount'));
  const tutCountByFp = new Map();
  for (const s of summaries) {
    const prev = tutCountByFp.get(s.communityFingerprint) || 0;
    if ((s.tutorialCount || 0) > prev) tutCountByFp.set(s.communityFingerprint, s.tutorialCount || 0);
  }

  // Only labeled fingerprints qualify for the gallery.
  const communities = [];
  for (const [fp, label] of labelByFp) {
    const tutSet = tutMembersByFp.get(fp) || new Set();
    const allSet = allMembersByFp.get(fp) || new Set();
    communities.push({
      fingerprint: fp,
      label,
      memberSlugs: [...tutSet],            // matching uses tutorial slugs (stable fingerprint basis)
      memberCount: allSet.size,
      tutorialCount: tutCountByFp.get(fp) || tutSet.size,
    });
  }

  const existingRows = await db.run(
    SELECT.from(TopicClusters).columns('slug', 'fingerprint', 'previousFingerprints', 'status')
  );
  const existing = existingRows.map((r) => ({
    ...r,
    memberSlugs: [...(tutMembersByFp.get(r.fingerprint) || new Set())],
  }));

  return { communities, existing };
}

export async function runKgTopicClusters() {
  const started = Date.now();
  const db = await cds.connect.to('db');
  try {
    const { communities, existing } = await _buildCommunitiesInput(db);
    const { upserts, retired } = reconcile({ existing, communities, threshold: JACCARD_THRESHOLD });
    const now = new Date().toISOString();
    const minted = upserts.filter((u) => !u.previousFingerprints).length;
    const reused = upserts.length - minted;

    await db.tx(async (tx) => {
      await tx.run(`TRUNCATE TABLE ${TABLE}`);
      const insertSql = `INSERT INTO ${TABLE}
        ("SLUG","LABEL","CURATEDLABEL","FINGERPRINT","PREVIOUSFINGERPRINTS","STATUS","HIDDEN","MEMBERCOUNT","TUTORIALCOUNT","COMPUTEDAT")
        VALUES (?,?,?,?,?,?,?,?,?,?)`;
      const rows = [
        ...upserts.map((u) => [u.slug, u.label, null, u.fingerprint, u.previousFingerprints, 'ACTIVE', false, u.memberCount, u.tutorialCount, now]),
        ...retired.map((slug) => [slug, '', null, '', '', 'RETIRED', false, 0, 0, now]),
      ];
      for (let i = 0; i < rows.length; i += INSERT_BATCH_SIZE) {
        await tx.run(insertSql, rows.slice(i, i + INSERT_BATCH_SIZE));
      }
    });

    const durationMs = Date.now() - started;
    metrics.observe('kg_topic_clusters_duration_ms', durationMs);
    metrics.gauge('kg_topic_clusters_count', upserts.length);
    metrics.gauge('kg_topic_clusters_minted', minted);
    metrics.gauge('kg_topic_clusters_reused', reused);
    metrics.gauge('kg_topic_clusters_retired', retired.length);
    LOG.info(`[kg-topic-clusters] ${upserts.length} clusters (${minted} minted, ${reused} reused), ${retired.length} retired in ${durationMs}ms`);
    return { clusters: upserts.length, minted, reused, retired: retired.length, durationMs };
  } catch (err) {
    metrics.counter('kg_topic_clusters_failures');
    LOG.error('[kg-topic-clusters] failed', err);
    throw err;
  }
}

export default { runKgTopicClusters };
```

> NOTE: the `(map.get(k) || map.set(k, new Set()).get(k))` idiom is compact but subtle — the implementer may prefer an explicit `if (!map.has(k)) map.set(k, new Set())` for readability. Either is fine; keep the lowercasing.

- [ ] **Step 4: Register in the scheduler** (`srv/jobs/scheduler.js`)

Add the import next to the other job imports (~line 52-55):

```js
import { runKgTopicClusters } from './kg-topic-clusters-job.js';
```

Add the registration block immediately after the `kg-community-labels` block (~line 665). `04:47` is a free off-minute after Louvain (03:57) and labeling (04:12):

```js
registerJob({
  jobName: 'kg-topic-clusters',
  schedule: '47 4 * * *',
  ttlMs: 600000,
  description: 'Reconcile Louvain communities into stable-slug TopicClusters for /topics/ (#topics-discovery)',
  fn: () => runKgTopicClusters(),
});
```

- [ ] **Step 5: Run the unit test to verify it passes**

Run: `npx vitest run test/unit/srv/kg-topic-clusters-job.test.js`
Expected: PASS.

- [ ] **Step 6: Write the hybrid test** (`test/hybrid/topic-clusters-job-hybrid.test.js`)

Runs the real job against real HANA (DEV community data). Assert the sidecar populates and slugs are stable.

```js
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
import { runKgTopicClusters } from '../../srv/jobs/kg-topic-clusters-job.js';

describe('kg-topic-clusters job (hybrid)', () => {
  beforeAll(async () => { await cds.connect.to('db'); });

  it('populates TopicClusters with ACTIVE stable slugs', async () => {
    const summary = await runKgTopicClusters();
    expect(summary.clusters).toBeGreaterThan(0);
    const { TopicClusters } = cds.entities('com.sap.developers.ims');
    const rows = await SELECT.from(TopicClusters).where({ status: 'ACTIVE' });
    expect(rows.length).toBe(summary.clusters);
    for (const r of rows) {
      expect(r.slug).toMatch(/^[a-z0-9][a-z0-9-]*$/);
      expect(r.fingerprint).toHaveLength(64);
    }
  });

  it('is idempotent: a second run keeps the same slugs (Jaccard=1 self-match)', async () => {
    const { TopicClusters } = cds.entities('com.sap.developers.ims');
    const before = new Set((await SELECT.from(TopicClusters).where({ status: 'ACTIVE' })).map((r) => r.slug));
    await runKgTopicClusters();
    const after = new Set((await SELECT.from(TopicClusters).where({ status: 'ACTIVE' })).map((r) => r.slug));
    expect([...after]).toEqual(expect.arrayContaining([...before]));
  });
});
```

- [ ] **Step 7: Run the hybrid test** (requires `cf login` + `cds bind`)

Run: `npx vitest run --project hybrid test/hybrid/topic-clusters-job-hybrid.test.js`
Expected: PASS. (If HANA/bind unavailable, the hybrid project self-skips — do not treat a skip as green; note it for review.)

- [ ] **Step 8: Verify SQLite deploy still clean**

Run: `npx cds deploy --to sqlite::memory: 2>&1 | tail -5`
Expected: no error.

- [ ] **Step 9: Commit**

```bash
git add srv/jobs/kg-topic-clusters-job.js srv/jobs/scheduler.js test/unit/srv/kg-topic-clusters-job.test.js test/hybrid/topic-clusters-job-hybrid.test.js
git commit -m "feat(topics): nightly TopicClusters reconciliation job (04:47 UTC)"
```

**Phase 1 checkpoint:** `TopicClusters` populates nightly with stable slugs. Reconciliation is unit-tested (pure) and hybrid-tested (real data + idempotency). No user-facing surface yet.
