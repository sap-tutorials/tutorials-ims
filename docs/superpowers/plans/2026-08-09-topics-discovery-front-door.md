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

---

## Phase 2 — Gallery data feed + Hugo-baked pages

**Deliverable:** `/topics/` (gallery) and `/topics/<slug>/` (cluster detail with suggested path) render as baked static Hugo pages, data-driven from a `/build/topics-gallery` feed.

### Task 4: Suggested-order path (pure topo-ish sort)

**Files:**
- Create: `srv/lib/topic-path-order.js`
- Test: `test/unit/srv/topic-path-order.test.js`

**Interfaces:**
- Consumes: nothing (pure).
- Produces: `orderConcepts({ concepts, requiresEdges, rankBySlug })` -> `{ ordered, mode }`:
  - `concepts` = array `{ slug, name }` (a cluster's concept members).
  - `requiresEdges` = array `{ source, target }` (concept slug pairs; `source requires target` -> target is a prerequisite, comes first).
  - `rankBySlug` = Map(slug -> pagerank score) for tiebreak/fallback.
  - Returns `ordered` = concepts sorted so prerequisites precede dependents (Kahn topological sort over the requires DAG restricted to in-cluster concepts); cycles broken by higher PageRank first. `mode` = `'path'` when the requires subgraph has enough edges (>= `max(2, floor(concepts.length/4))`), else `'ranked'` — in `'ranked'` mode `ordered` is pure PageRank-desc and the UI drops the "suggested order" framing (per spec: no fake precision).

- [ ] **Step 1: Write the failing test**

```js
import { describe, it, expect } from 'vitest';
import { orderConcepts } from '../../../srv/lib/topic-path-order.js';

const rank = new Map([['a',0.9],['b',0.5],['c',0.3],['d',0.1]]);

describe('orderConcepts', () => {
  it('puts prerequisites before dependents (path mode)', () => {
    const concepts = [{slug:'a',name:'A'},{slug:'b',name:'B'},{slug:'c',name:'C'},{slug:'d',name:'D'}];
    // c requires a; d requires c; b requires a  => a before b/c, c before d
    const requiresEdges = [{source:'c',target:'a'},{source:'d',target:'c'},{source:'b',target:'a'}];
    const { ordered, mode } = orderConcepts({ concepts, requiresEdges, rankBySlug: rank });
    expect(mode).toBe('path');
    const pos = (s) => ordered.findIndex((x) => x.slug === s);
    expect(pos('a')).toBeLessThan(pos('c'));
    expect(pos('c')).toBeLessThan(pos('d'));
    expect(pos('a')).toBeLessThan(pos('b'));
  });

  it('falls back to PageRank order (ranked mode) when requires data is too thin', () => {
    const concepts = [{slug:'a',name:'A'},{slug:'b',name:'B'},{slug:'c',name:'C'},{slug:'d',name:'D'}];
    const requiresEdges = []; // no edges
    const { ordered, mode } = orderConcepts({ concepts, requiresEdges, rankBySlug: rank });
    expect(mode).toBe('ranked');
    expect(ordered.map((x) => x.slug)).toEqual(['a','b','c','d']); // pagerank desc
  });

  it('breaks cycles by higher PageRank first without dropping nodes', () => {
    const concepts = [{slug:'a',name:'A'},{slug:'b',name:'B'},{slug:'c',name:'C'}];
    const requiresEdges = [{source:'a',target:'b'},{source:'b',target:'a'},{source:'c',target:'a'}]; // a<->b cycle
    const { ordered } = orderConcepts({ concepts, requiresEdges, rankBySlug: rank });
    expect(ordered).toHaveLength(3); // all present despite cycle
    expect(new Set(ordered.map((x) => x.slug))).toEqual(new Set(['a','b','c']));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/srv/topic-path-order.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation** (`srv/lib/topic-path-order.js`)

```js
// Pure suggested-order sort for a cluster's concepts.
// Kahn topological sort over in-cluster `requires` edges; PageRank breaks ties
// and cycles; falls back to pure PageRank order when the requires subgraph is thin.

export function orderConcepts({ concepts = [], requiresEdges = [], rankBySlug = new Map() }) {
  const inCluster = new Set(concepts.map((c) => c.slug));
  const rank = (s) => rankBySlug.get(s) || 0;
  const bySlug = new Map(concepts.map((c) => [c.slug, c]));

  // Restrict edges to in-cluster concept pairs. source requires target => target first.
  const edges = requiresEdges.filter((e) => inCluster.has(e.source) && inCluster.has(e.target) && e.source !== e.target);
  const rankedFallback = [...concepts].sort((a, b) => rank(b.slug) - rank(a.slug));

  const threshold = Math.max(2, Math.floor(concepts.length / 4));
  if (edges.length < threshold) {
    return { ordered: rankedFallback, mode: 'ranked' };
  }

  // Build indegree from prerequisite -> dependent (target -> source).
  const dependents = new Map();  // prereq -> [dependents]
  const indeg = new Map(concepts.map((c) => [c.slug, 0]));
  for (const e of edges) {
    if (!dependents.has(e.target)) dependents.set(e.target, []);
    dependents.get(e.target).push(e.source);
    indeg.set(e.source, (indeg.get(e.source) || 0) + 1);
  }

  // Kahn with a PageRank-desc ready queue (stable, deterministic).
  const ready = concepts.filter((c) => (indeg.get(c.slug) || 0) === 0).map((c) => c.slug);
  const pick = (arr) => { arr.sort((x, y) => rank(y) - rank(x)); return arr.shift(); };
  const ordered = [];
  const placed = new Set();
  while (ready.length) {
    const slug = pick(ready);
    if (placed.has(slug)) continue;
    placed.add(slug);
    ordered.push(bySlug.get(slug));
    for (const dep of dependents.get(slug) || []) {
      indeg.set(dep, (indeg.get(dep) || 0) - 1);
      if ((indeg.get(dep) || 0) <= 0 && !placed.has(dep)) ready.push(dep);
    }
  }
  // Cycle remainder: append any unplaced concepts in PageRank-desc order.
  for (const c of rankedFallback) if (!placed.has(c.slug)) { ordered.push(c); placed.add(c.slug); }

  return { ordered, mode: 'path' };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/srv/topic-path-order.test.js`
Expected: PASS (all 3).

- [ ] **Step 5: Commit**

```bash
git add srv/lib/topic-path-order.js test/unit/srv/topic-path-order.test.js
git commit -m "feat(topics): suggested-order topo sort with PageRank fallback"
```

---

### Task 5: `/build/topics-gallery` feed builder

**Files:**
- Create: `srv/lib/build-topics-gallery.js`
- Modify: `srv/server.js` (import ~line 29; register ~line 285 among `/build/*`)
- Modify: `approuter/xs-app.json` (`/build/*` allowlist regex, ~line 383 — add `topics-gallery`)
- Test: `test/unit/srv/build-topics-gallery.test.js` + `test/hybrid/topics-gallery-hybrid.test.js`

**Interfaces:**
- Consumes: `cds.entities(NS)` for `TopicClusters`, `KgCommunity`, `Concepts`, `ConceptEdges`, `Tutorials`; `loadRankMaps` from `../knowledge-graph-service.js`; `orderConcepts` from `./topic-path-order.js`.
- Produces:
  - `buildTopicsGalleryPayload(db)` -> `Promise<{ gallery, clusters, buildAt, error }>` where:
    - `gallery` = array of cards `{ slug, label, rationale, memberCount, tutorialCount, topConcepts:[{slug,name}] }` (ACTIVE, non-hidden clusters, sorted by `tutorialCount * log(1+memberCount)` desc; top ~4 concepts by PageRank per card).
    - `clusters` = map `slug -> { slug, label, rationale, memberCount, tutorialCount, orderMode, concepts:[{slug,name,rank}], peers:[{slug,label,weight}] }` (full detail for baking each `/topics/<slug>/`).
    - `buildAt` = ISO string; `error` = null or `'topics_gallery_build_failed'`.
  - `buildTopicsGalleryHandler(_req, res)` -> Express handler, `Cache-Control: public, max-age=60`, `res.json(payload)`.
- Fail-open: any throw -> `{ gallery: [], clusters: {}, buildAt, error: 'topics_gallery_build_failed' }`.

**Mechanics (from recon):**
- `label = curatedLabel || label`. Concept members per cluster: `KgCommunity` where `communityFingerprint = cluster.fingerprint AND vertexType='concept'` (slugs lowercased). `rationale` from `KgCommunityLabel`.
- PageRank via `loadRankMaps()` (`rankMaps.conceptRank`), fail-open to `[]`/no-sort.
- Peer edges (for the detail page "topics that connect"): count `ConceptEdges` (status ACTIVE) whose source/target concepts fall in two different clusters; resolve concept `ID -> slug -> fingerprint -> cluster.slug`. Weight = crossing-edge count. Cap peers per cluster at 6, weight desc.
- Suggested path via `orderConcepts({ concepts, requiresEdges: <in-cluster requires ConceptEdges>, rankBySlug })`.
- Packet-safe: read `ConceptEdges`/`KgCommunity` unbounded and bucket in Node (5,946 concepts; matches `published-concepts-query.js` and coverage-chunk patterns) rather than `WHERE IN` over thousands of ids.

- [ ] **Step 1: Write the failing unit test** (`test/unit/srv/build-topics-gallery.test.js`)

Use `cds.test('serve','--project','.','--in-memory')` bootstrap (project rule). Seed a couple of `TopicClusters` + `KgCommunity` + `Concepts` rows, assert payload shape.

```js
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

describe('buildTopicsGalleryPayload', () => {
  let db, build;
  beforeAll(async () => {
    await cds.test('serve', '--project', '.', '--in-memory');
    db = await cds.connect.to('db');
    build = await import('../../../srv/lib/build-topics-gallery.js');
    const { TopicClusters, KgCommunity, Concepts } = cds.entities('com.sap.developers.ims');
    await INSERT.into(TopicClusters).entries([
      { slug: 'hana', label: 'HANA', curatedLabel: null, fingerprint: 'FP1', previousFingerprints: '', status: 'ACTIVE', hidden: false, memberCount: 2, tutorialCount: 5, computedAt: new Date().toISOString() },
      { slug: 'hidden-one', label: 'Hidden', fingerprint: 'FP2', previousFingerprints: '', status: 'ACTIVE', hidden: true, memberCount: 1, tutorialCount: 1, computedAt: new Date().toISOString() },
    ]);
    await INSERT.into(Concepts).entries([
      { ID: cds.utils.uuid(), slug: 'hana-sql', name: 'HANA SQL', status: 'ACTIVE' },
    ]);
    await INSERT.into(KgCommunity).entries([
      { communityId: 1, vertexKey: 'concept:hana-sql', vertexType: 'concept', slug: 'hana-sql', detectedAt: new Date().toISOString(), communityFingerprint: 'FP1' },
    ]);
  });

  it('returns ACTIVE non-hidden gallery cards with top concepts', async () => {
    const payload = await build.buildTopicsGalleryPayload(db);
    expect(payload.error).toBeNull();
    const slugs = payload.gallery.map((c) => c.slug);
    expect(slugs).toContain('hana');
    expect(slugs).not.toContain('hidden-one'); // hidden excluded
    const hana = payload.gallery.find((c) => c.slug === 'hana');
    expect(hana.topConcepts.map((x) => x.slug)).toContain('hana-sql');
    expect(payload.clusters.hana).toBeTruthy();
    expect(payload.clusters.hana.concepts.map((x) => x.slug)).toContain('hana-sql');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/srv/build-topics-gallery.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the builder** (`srv/lib/build-topics-gallery.js`)

Follow `build-topic-clusters.js` (the #1170 builder) for the `cds.entities(NS)` + fail-open shape. Key skeleton:

```js
import cds from '@sap/cds';
import { orderConcepts } from './topic-path-order.js';
import { loadRankMaps } from '../knowledge-graph-service.js';

const NS = 'com.sap.developers.ims';
const MAX_TOP_CONCEPTS = 4;
const MAX_PEERS = 6;

export async function buildTopicsGalleryPayload(db) {
  const buildAt = new Date().toISOString();
  try {
    const { TopicClusters, KgCommunity, Concepts, ConceptEdges } = cds.entities(NS);

    const clusters = await db.run(
      SELECT.from(TopicClusters).where({ status: 'ACTIVE', hidden: false })
    );
    if (!clusters.length) return { gallery: [], clusters: {}, buildAt, error: null };

    // fingerprint -> cluster
    const clusterByFp = new Map(clusters.map((c) => [c.fingerprint, c]));

    // concept memberships (all clusters at once, bucket in Node)
    const conceptMembers = await db.run(
      SELECT.from(KgCommunity).columns('communityFingerprint', 'slug').where({ vertexType: 'concept' })
    );
    const conceptSlugsByFp = new Map();
    const fpBySlug = new Map();
    for (const m of conceptMembers) {
      const fp = m.communityFingerprint;
      if (!clusterByFp.has(fp)) continue;
      const slug = (m.slug || '').toLowerCase();
      if (!slug) continue;
      (conceptSlugsByFp.get(fp) || conceptSlugsByFp.set(fp, []).get(fp)).push(slug);
      fpBySlug.set(slug, fp);
    }

    // concept names + rank
    const allConceptSlugs = [...fpBySlug.keys()];
    const conceptRows = allConceptSlugs.length
      ? await db.run(SELECT.from(Concepts).columns('ID', 'slug', 'name').where({ slug: { in: allConceptSlugs } }))
      : [];
    const nameBySlug = new Map(conceptRows.map((r) => [(r.slug || '').toLowerCase(), r.name]));
    const idToSlug = new Map(conceptRows.map((r) => [r.ID, (r.slug || '').toLowerCase()]));

    let rankMaps = { conceptRank: new Map() };
    try { rankMaps = await loadRankMaps(); } catch { /* fail-open: no ranks */ }
    const rankBySlug = rankMaps.conceptRank || new Map();

    // requires edges (ACTIVE) + inter-cluster peer weights
    const edges = await db.run(
      SELECT.from(ConceptEdges).columns('source_ID', 'target_ID', 'predicate').where({ status: 'ACTIVE' })
    );
    const requiresBySlugPair = [];
    const peerWeight = new Map(); // `${aSlug}|${bSlug}` -> count
    for (const e of edges) {
      const s = idToSlug.get(e.source_ID);
      const t = idToSlug.get(e.target_ID);
      if (!s || !t) continue;
      if (e.predicate === 'requires') requiresBySlugPair.push({ source: s, target: t });
      const fpS = fpBySlug.get(s);
      const fpT = fpBySlug.get(t);
      if (fpS && fpT && fpS !== fpT) {
        const cs = clusterByFp.get(fpS).slug;
        const ct = clusterByFp.get(fpT).slug;
        const key = cs < ct ? `${cs}|${ct}` : `${ct}|${cs}`;
        peerWeight.set(key, (peerWeight.get(key) || 0) + 1);
      }
    }

    // assemble per-cluster detail + gallery card
    const labelOf = (c) => c.curatedLabel || c.label;
    const clusterDetail = {};
    const gallery = [];
    for (const c of clusters) {
      const memberSlugs = conceptSlugsByFp.get(c.fingerprint) || [];
      const concepts = memberSlugs.map((s) => ({ slug: s, name: nameBySlug.get(s) || s, rank: rankBySlug.get(s) || 0 }));
      const clusterRequires = requiresBySlugPair.filter((p) => memberSlugs.includes(p.source) && memberSlugs.includes(p.target));
      const { ordered, mode } = orderConcepts({ concepts, requiresEdges: clusterRequires, rankBySlug });
      const topConcepts = [...concepts].sort((a, b) => b.rank - a.rank).slice(0, MAX_TOP_CONCEPTS).map((x) => ({ slug: x.slug, name: x.name }));

      const peers = [];
      for (const [key, weight] of peerWeight) {
        const [a, b] = key.split('|');
        if (a === c.slug || b === c.slug) {
          const otherSlug = a === c.slug ? b : a;
          const other = clusters.find((x) => x.slug === otherSlug);
          if (other) peers.push({ slug: otherSlug, label: labelOf(other), weight });
        }
      }
      peers.sort((x, y) => y.weight - x.weight);

      clusterDetail[c.slug] = {
        slug: c.slug, label: labelOf(c), rationale: c.rationale || '',
        memberCount: c.memberCount, tutorialCount: c.tutorialCount,
        orderMode: mode, concepts: ordered.map((x) => ({ slug: x.slug, name: x.name })),
        peers: peers.slice(0, MAX_PEERS),
      };
      gallery.push({
        slug: c.slug, label: labelOf(c), rationale: c.rationale || '',
        memberCount: c.memberCount, tutorialCount: c.tutorialCount, topConcepts,
      });
    }
    gallery.sort((a, b) => (b.tutorialCount * Math.log(1 + b.memberCount)) - (a.tutorialCount * Math.log(1 + a.memberCount)));

    return { gallery, clusters: clusterDetail, buildAt, error: null };
  } catch (err) {
    cds.log('build-topics-gallery').error('failed', err);
    return { gallery: [], clusters: {}, buildAt, error: 'topics_gallery_build_failed' };
  }
}

export async function buildTopicsGalleryHandler(_req, res) {
  const db = await cds.connect.to('db');
  const payload = await buildTopicsGalleryPayload(db);
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.json(payload);
}

export default { buildTopicsGalleryPayload, buildTopicsGalleryHandler };
```

> NOTE: `rationale` is on `KgCommunityLabel`, not `TopicClusters`. The implementer must either (a) add `rationale` to the `TopicClusters` sidecar in the Task 1 entity + Task 3 job (simplest — carry it forward nightly), or (b) join `KgCommunityLabel` by fingerprint here. **Prefer (a)** — add `rationale : String(500)` to `TopicClusters`, populate it in the job from `labelByFp`, and update the Task 1 test. Adjust this builder to read `c.rationale` directly. Make this entity/job change as the first sub-step of this task and re-run Task 1/3 tests.

- [ ] **Step 4: Register the route** (`srv/server.js`)

Import near the other `/build` imports (~line 16-29):
```js
import { buildTopicsGalleryHandler } from './lib/build-topics-gallery.js';
```
Register among the `/build/*` feeds (~line 285, after `/build/topic-clusters`):
```js
app.get('/build/topics-gallery', buildTopicsGalleryHandler);
```

- [ ] **Step 5: Allowlist in approuter** (`approuter/xs-app.json`, ~line 383)

Add `topics-gallery` to the `/build/(...)` alternation regex (the existing list includes `concepts`, `homepage-shelves`, etc. — add `|topics-gallery`). This lets the fetch script reach it through the approuter if ever needed; the local build calls CAP directly so this is belt-and-suspenders.

- [ ] **Step 6: Run unit test to verify it passes**

Run: `npx vitest run test/unit/srv/build-topics-gallery.test.js`
Expected: PASS.

- [ ] **Step 7: Write + run the hybrid test** (`test/hybrid/topics-gallery-hybrid.test.js`)

```js
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
import { buildTopicsGalleryPayload } from '../../srv/lib/build-topics-gallery.js';

describe('topics-gallery (hybrid)', () => {
  let db;
  beforeAll(async () => { db = await cds.connect.to('db'); });
  it('builds a non-empty gallery from real clusters', async () => {
    const payload = await buildTopicsGalleryPayload(db);
    expect(payload.error).toBeNull();
    expect(Array.isArray(payload.gallery)).toBe(true);
    expect(payload.gallery.length).toBeGreaterThan(0);
    const first = payload.gallery[0];
    expect(typeof first.label).toBe('string');
    expect(payload.clusters[first.slug].concepts.length).toBeGreaterThan(0);
    expect(['path','ranked']).toContain(payload.clusters[first.slug].orderMode);
  });
});
```
Run: `npx vitest run --project hybrid test/hybrid/topics-gallery-hybrid.test.js` (requires the Phase-1 job to have run against DEV; if empty, run the job first). Do not treat a self-skip as green.

- [ ] **Step 8: Commit**

```bash
git add srv/lib/build-topics-gallery.js srv/server.js approuter/xs-app.json test/unit/srv/build-topics-gallery.test.js test/hybrid/topics-gallery-hybrid.test.js db/knowledge-graph-topic-clusters.cds srv/jobs/kg-topic-clusters-job.js
git commit -m "feat(topics): /build/topics-gallery feed with paths + peer edges"
```

---

### Task 6: Build-time fetch script

**Files:**
- Create: `scripts/fetch-topics-gallery.ts`
- Modify: `package.json` (add `fetch-topics-gallery` script; wire into `build:all` after other `fetch-*`)
- Test: `test/unit/scripts/fetch-topics-gallery.test.ts`

**Interfaces:**
- Consumes: `/build/topics-gallery` (CAP feed).
- Produces: writes `hugo/data/topics_gallery.json` = the feed payload verbatim. Fail-open: on fetch error writes `{ gallery: [], clusters: {}, buildAt, error: 'fetch_failed' }`.

Model exactly on `scripts/fetch-topic-clusters.ts` (native `fetch`, `CAP_BASE` default `http://localhost:4004`, fail-open writing empty payload).

- [ ] **Step 1: Write the failing test** (`test/unit/scripts/fetch-topics-gallery.test.ts`)

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { writeTopicsGallery } from '../../../scripts/fetch-topics-gallery';
import * as fs from 'node:fs';

vi.mock('node:fs', async (orig) => ({ ...(await orig<typeof fs>()), writeFileSync: vi.fn(), mkdirSync: vi.fn() }));

describe('writeTopicsGallery', () => {
  beforeEach(() => vi.clearAllMocks());
  it('writes the fetched payload to hugo/data/topics_gallery.json', async () => {
    const payload = { gallery: [{ slug: 'x', label: 'X' }], clusters: {}, buildAt: 'now', error: null };
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => payload } as any);
    await writeTopicsGallery('http://localhost:4004');
    const call = (fs.writeFileSync as any).mock.calls[0];
    expect(String(call[0])).toMatch(/topics_gallery\.json$/);
    expect(JSON.parse(call[1]).gallery[0].slug).toBe('x');
  });
  it('writes an empty fail-open payload when the fetch throws', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('down'));
    await writeTopicsGallery('http://localhost:4004');
    const call = (fs.writeFileSync as any).mock.calls[0];
    expect(JSON.parse(call[1]).error).toBe('fetch_failed');
    expect(JSON.parse(call[1]).gallery).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/scripts/fetch-topics-gallery.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the script** (`scripts/fetch-topics-gallery.ts`)

```ts
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

const OUT = join('hugo', 'data', 'topics_gallery.json');

export async function writeTopicsGallery(capBase = process.env.CAP_BASE_URL || 'http://localhost:4004') {
  let payload: any;
  try {
    const res = await fetch(`${capBase}/build/topics-gallery`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    payload = await res.json();
  } catch (err) {
    console.warn(`[fetch-topics-gallery] fail-open: ${(err as Error).message}`);
    payload = { gallery: [], clusters: {}, buildAt: new Date().toISOString(), error: 'fetch_failed' };
  }
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(payload, null, 2));
  console.log(`[fetch-topics-gallery] wrote ${payload.gallery?.length ?? 0} cards -> ${OUT}`);
}

// CLI entry (tsx scripts/fetch-topics-gallery.ts)
if (import.meta.url === `file://${process.argv[1]}`) {
  writeTopicsGallery();
}
```

- [ ] **Step 4: Wire into package.json**

Add to `scripts` (sibling to `fetch-topic-clusters`):
```json
"fetch-topics-gallery": "tsx scripts/fetch-topics-gallery.ts",
```
Add `&& npm run fetch-topics-gallery` into the `build:all` chain immediately after the existing `fetch-topic-clusters` invocation (find it: `jq '.scripts["build:all"]' package.json`). Keep it before the Hugo build step so the data file exists when Hugo bakes.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/unit/scripts/fetch-topics-gallery.test.ts`
Expected: PASS (both).

- [ ] **Step 6: Commit**

```bash
git add scripts/fetch-topics-gallery.ts package.json test/unit/scripts/fetch-topics-gallery.test.ts
git commit -m "feat(topics): build-time fetch of topics gallery to hugo/data"
```

---

### Task 7: Hugo gallery + cluster-detail layouts

**Files:**
- Create: `hugo/content/topics/_index.md` (gallery page stub)
- Create: `hugo/layouts/topics/list.html` (gallery: cards + filter mount + map mount)
- Create: `hugo/layouts/topics/single.html` (cluster detail — used via a data-driven page-per-cluster, see Step 3)
- Create: `hugo/assets/css/topics.css` (or inline `<style>` in the layouts — match how `homepage.css`/`concepts` inline styling is done)
- Test: `test/unit/hugo/topics-layouts.test.ts` (template-source assertions, like `topic-clusters-band.test.ts`)

**Interfaces:**
- Consumes: `site.Data.topics_gallery` (`{ gallery, clusters, buildAt, error }`), `site.Data.topics_map_bundle` (island hash, Task 9).
- Produces: baked `/topics/index.html` + one `/topics/<slug>/index.html` per cluster.

**Cluster-detail pages via a Hugo data-driven approach:** Hugo won't auto-create a page per JSON entry. Two options — pick the one matching repo convention:
- **(a) Fetch script also writes content stubs** — extend `fetch-topics-gallery.ts` to write a thin `hugo/content/topics/<slug>.md` (front matter `{title, layout: "single", type: "topics", cluster: "<slug>"}`) per cluster, so Hugo bakes each via `topics/single.html`. Clean up stale stubs each run (delete `hugo/content/topics/*.md` except `_index.md` before writing).
- **(b) Single-page app** — bake only the gallery and render cluster detail client-side. Rejected: loses SSR/SEO for detail pages (a spec requirement).

**Choose (a).** Add stub-writing to the Task 6 script (make this Step 1 here, then re-run Task 6 test — add an assertion that per-cluster stubs are written and stale ones removed).

- [ ] **Step 1: Extend the fetch script to write per-cluster content stubs**

In `fetch-topics-gallery.ts`, after writing the JSON: remove existing `hugo/content/topics/*.md` except `_index.md`, then for each `slug` in `payload.clusters` write `hugo/content/topics/<slug>.md`:
```
---
title: "{label}"
type: topics
layout: single
cluster: "{slug}"
---
```
Add a unit assertion in `test/unit/scripts/fetch-topics-gallery.test.ts` that a stub path `hugo/content/topics/x.md` is written when `clusters` has key `x`. (Mock `readdirSync`/`unlinkSync` alongside `writeFileSync`.)

- [ ] **Step 2: Write the failing layout test** (`test/unit/hugo/topics-layouts.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

describe('topics layouts', () => {
  it('gallery list.html renders cards from site.Data.topics_gallery and guards empty', () => {
    const src = readFileSync('hugo/layouts/topics/list.html', 'utf-8');
    expect(src).toContain('site.Data.topics_gallery');
    expect(src).toMatch(/topics-gallery|topics-card/);
    expect(src).toContain('/topics/');           // card links
    expect(src).toMatch(/if .*gallery/);          // empty guard
    expect(src).toContain('id="topics-map"');     // map island mount
  });
  it('single.html renders suggested path + concepts + peers and honors orderMode', () => {
    const src = readFileSync('hugo/layouts/topics/single.html', 'utf-8');
    expect(src).toContain('orderMode');
    expect(src).toContain('/concepts/');          // concept links
    expect(src).toMatch(/peers|connect/i);        // peer clusters section
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/unit/hugo/topics-layouts.test.ts`
Expected: FAIL — files not found.

- [ ] **Step 4: Write `hugo/content/topics/_index.md`**

```
---
title: "Topics"
type: topics
layout: list
description: "Explore SAP developer topics — browse clusters of related concepts and follow a suggested learning path."
---
```

- [ ] **Step 5: Write `hugo/layouts/topics/list.html`** (gallery)

Render the hero gallery from `site.Data.topics_gallery.gallery`. Model chrome on the existing homepage band + `hugo/layouts/explore/single.html` (for the island-bundle include). Requirements:
- `{{ $g := site.Data.topics_gallery }}` then `{{ if and $g (gt (len $g.gallery) 0) }}` guard (empty → friendly message, no crash).
- `<h1>Explore topics</h1>` + intro.
- Understated search box (top-right) — a plain form posting to `/search/` (reuse existing site search; priority C, table stakes).
- Grid of cards: each card links `href="/topics/{{ .slug }}/"`, shows `{{ .label }}`, truncated `{{ .rationale }}`, `{{ .memberCount }} concepts · {{ .tutorialCount }} tutorials`, and up to 4 `.topConcepts` as chips.
- Below the grid: `<section id="topics-map" data-vue-island="topics-map"></section>` + the map island `<script>`/`<link>` include from `site.Data.topics_map_bundle` (guard if absent — island is progressive enhancement).
- Inline the `#topics-gallery` JSON for the filter island if reusing the concepts-filter pattern: `<script type="application/json" id="topics-data">{{ $g.gallery | jsonify }}</script>` + the `topics-filter.js` island (optional for v1 — the gallery is small; a simple client filter can be deferred. If deferred, omit the filter island and keep the static grid).

> Decision for the implementer: cluster count is small (~18-60), so a virtualized filter island is NOT required for v1. Ship the static SSR grid + the map island. A text-filter island can be a fast follow. (This keeps the phase lean — YAGNI.)

- [ ] **Step 6: Write `hugo/layouts/topics/single.html`** (cluster detail)

Look up the cluster by the page's `cluster` param: `{{ $c := index site.Data.topics_gallery.clusters .Params.cluster }}`. Guard `{{ if $c }}`. Render:
- Header: `{{ $c.label }}`, full `{{ $c.rationale }}`, `{{ $c.memberCount }} concepts · {{ $c.tutorialCount }} tutorials`.
- Suggested order: `{{ if eq $c.orderMode "path" }}<h2>A suggested order through this topic</h2>{{ else }}<h2>Concepts in this topic</h2>{{ end }}` then an ordered/unordered list of `$c.concepts`, each `<a href="/concepts/{{ .slug }}/">{{ .name }}</a>`. In `path` mode use `<ol>`; in `ranked` mode `<ul>`.
- Peer clusters: `{{ with $c.peers }}<h2>Topics that connect to this one</h2>...{{ end }}` linking `href="/topics/{{ .slug }}/"` showing `{{ .label }}`.
- A `<div data-vue-island="topics-map" data-focus-cluster="{{ .Params.cluster }}"></div>` optional mini-map (island reads `data-focus-cluster`).
- Breadcrumb: Home / Topics / label.

- [ ] **Step 7: Write `hugo/assets/css/topics.css`** (or inline)

Namespace `.topics-*`. Match Horizon CSS-var usage from `homepage.css` (`var(--sapLinkColor, #0070f2)` etc.). Card grid, chips, path list. Wire it into the layouts via the site's asset pipeline (follow how `homepage.css` is included).

- [ ] **Step 8: Run layout test to verify it passes**

Run: `npx vitest run test/unit/hugo/topics-layouts.test.ts`
Expected: PASS.

- [ ] **Step 9: Local bake smoke-check**

Run (needs CAP up + job data or a hand-seeded `hugo/data/topics_gallery.json`):
```bash
npm run fetch-topics-gallery && npm run dev
```
Visit `http://localhost:1313/topics/` and one `/topics/<slug>/`. Confirm gallery cards render, a cluster page shows the path + peers. (Per Tom's #1 rule: verify the real page in a browser, not just the unit test.)

- [ ] **Step 10: Commit**

```bash
git add hugo/content/topics/_index.md hugo/layouts/topics/ hugo/assets/css/topics.css scripts/fetch-topics-gallery.ts test/unit/hugo/topics-layouts.test.ts test/unit/scripts/fetch-topics-gallery.test.ts
git commit -m "feat(topics): Hugo gallery + cluster-detail layouts (baked static)"
```

**Phase 2 checkpoint:** `/topics/` gallery and `/topics/<slug>/` detail pages bake as static HTML with suggested paths and peer links. Fully functional without JS. Map island not yet built (Phase 3).

---

## Phase 3 — Cluster map endpoint + Sigma island + /explore/ deep-link

**Deliverable:** the cluster map renders below the gallery (super-nodes + inter-cluster edges, expand-in-place), and "See full graph →" deep-links into `/explore/` pre-focused on a cluster.

### Task 8: `/graph/clusters-data` endpoint

**Files:**
- Create: `srv/lib/kg-clusters-data.js` (pure builder)
- Create: `srv/lib/build-clusters-data.js` (cached Express wrapper)
- Modify: `srv/server.js` (import + register `GET /graph/clusters-data` ~line 286, alongside `/graph/explore-data`)
- Modify: `scripts/check-public-endpoints.ts` (allowlist `/graph/clusters-data`)
- Test: `test/unit/srv/kg-clusters-data.test.js` + `test/hybrid/clusters-data-hybrid.test.js`

**Interfaces:**
- Consumes: `buildTopicsGalleryPayload` (reuse — it already computes clusters + peer weights + top concepts).
- Produces:
  - `buildClustersDataPayload(db)` -> `{ nodes, edges, generatedAt }` where:
    - `nodes` = one super-node per ACTIVE non-hidden cluster: `{ id: 'c:<slug>', type: 'cluster', slug, label, size: memberCount }`.
    - `edges` = inter-cluster edges: `{ s: 'c:<slugA>', o: 'c:<slugB>', weight }` from peer weights.
    - Matches the `/graph/explore-data` field convention (`id`, `s`/`o`) so the island can reuse `/explore/`'s graphology-building code.
  - `buildClusterSubgraph(db, slug)` -> `{ nodes, edges }` for expand-in-place: the cluster's top concepts as nodes (`id: 't:<conceptSlug>'`) + intra-cluster `requires` edges.
  - `clustersDataHandler(req, res)` -> cached (TTL 5min, like `build-explore-data.js`), `Cache-Control: public, max-age=300`, `X-Cache: HIT|MISS`. Supports `?cluster=<slug>` → returns the subgraph; else the super-graph.
- Fail-open: 500 `{ error: 'clusters-data query failed' }` on throw; island degrades.

- [ ] **Step 1: Write the failing unit test** (`test/unit/srv/kg-clusters-data.test.js`)

```js
import { describe, it, expect, vi } from 'vitest';
import { buildClustersDataPayload } from '../../../srv/lib/kg-clusters-data.js';

vi.mock('../../../srv/lib/build-topics-gallery.js', () => ({
  buildTopicsGalleryPayload: vi.fn(async () => ({
    gallery: [
      { slug: 'hana', label: 'HANA', memberCount: 10, tutorialCount: 5, topConcepts: [] },
      { slug: 'cap', label: 'CAP', memberCount: 8, tutorialCount: 4, topConcepts: [] },
    ],
    clusters: {
      hana: { slug: 'hana', label: 'HANA', memberCount: 10, tutorialCount: 5, peers: [{ slug: 'cap', label: 'CAP', weight: 3 }], concepts: [] },
      cap:  { slug: 'cap',  label: 'CAP',  memberCount: 8,  tutorialCount: 4, peers: [{ slug: 'hana', label: 'HANA', weight: 3 }], concepts: [] },
    },
    buildAt: 'now', error: null,
  })),
}));

describe('buildClustersDataPayload', () => {
  it('emits one super-node per cluster and deduped inter-cluster edges', async () => {
    const { nodes, edges } = await buildClustersDataPayload({});
    expect(nodes.map((n) => n.id).sort()).toEqual(['c:cap', 'c:hana']);
    expect(nodes.find((n) => n.id === 'c:hana').size).toBe(10);
    // hana<->cap appears once, not twice
    expect(edges).toHaveLength(1);
    expect(edges[0].weight).toBe(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/srv/kg-clusters-data.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the pure builder** (`srv/lib/kg-clusters-data.js`)

```js
import cds from '@sap/cds';
import { buildTopicsGalleryPayload } from './build-topics-gallery.js';

export async function buildClustersDataPayload(db) {
  const { gallery, clusters } = await buildTopicsGalleryPayload(db);
  const nodes = gallery.map((c) => ({ id: `c:${c.slug}`, type: 'cluster', slug: c.slug, label: c.label, size: c.memberCount || 1 }));
  const seen = new Set();
  const edges = [];
  for (const c of gallery) {
    const detail = clusters[c.slug];
    for (const p of (detail?.peers || [])) {
      const key = c.slug < p.slug ? `${c.slug}|${p.slug}` : `${p.slug}|${c.slug}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ s: `c:${c.slug}`, o: `c:${p.slug}`, weight: p.weight });
    }
  }
  return { nodes, edges, generatedAt: new Date().toISOString() };
}

export async function buildClusterSubgraph(db, slug) {
  const { clusters } = await buildTopicsGalleryPayload(db);
  const detail = clusters[slug];
  if (!detail) return { nodes: [], edges: [] };
  const nodes = detail.concepts.slice(0, 30).map((c) => ({ id: `t:${c.slug}`, type: 'concept', slug: c.slug, label: c.name }));
  // Intra-cluster requires edges are already reflected in concept order; for v1 the subgraph
  // shows concepts as nodes (edges optional). Implementer may add requires edges here from
  // build-topics-gallery if the ordered path exposes them.
  return { nodes, edges: [] };
}

export default { buildClustersDataPayload, buildClusterSubgraph };
```

> NOTE: to draw intra-cluster edges in the subgraph, have `build-topics-gallery.js` also return each cluster's in-cluster `requires` slug-pairs on the `clusters[slug]` detail (add a `pathEdges` field). Optional for v1 — nodes-only is acceptable; if you add it, extend the Task 5 payload + its test.

- [ ] **Step 4: Write the cached handler** (`srv/lib/build-clusters-data.js`)

Mirror `build-explore-data.js` (TTL 5min module cache, `X-Cache` header, `_resetClustersDataCache()` test hook). Branch on `req.query.cluster`:
```js
import cds from '@sap/cds';
import { buildClustersDataPayload, buildClusterSubgraph } from './kg-clusters-data.js';

const TTL_MS = 5 * 60 * 1000;
let cached = null; let cachedAt = 0;

export async function clustersDataHandler(req, res) {
  try {
    const db = await cds.connect.to('db');
    const clusterSlug = typeof req.query.cluster === 'string' ? req.query.cluster.toLowerCase() : '';
    if (clusterSlug) {
      if (!/^[a-z0-9][a-z0-9-]*$/.test(clusterSlug)) return res.status(400).json({ error: 'bad cluster slug' });
      res.setHeader('Cache-Control', 'public, max-age=300');
      return res.json(await buildClusterSubgraph(db, clusterSlug));
    }
    const now = Date.now();
    if (cached && now - cachedAt < TTL_MS) { res.setHeader('X-Cache', 'HIT'); res.setHeader('Cache-Control', 'public, max-age=300'); return res.json(cached); }
    cached = await buildClustersDataPayload(db); cachedAt = now;
    res.setHeader('X-Cache', 'MISS'); res.setHeader('Cache-Control', 'public, max-age=300');
    return res.json(cached);
  } catch (err) {
    cds.log('build-clusters-data').error('failed', err);
    return res.status(500).json({ error: 'clusters-data query failed' });
  }
}
export function _resetClustersDataCache() { cached = null; cachedAt = 0; }
export default { clustersDataHandler, _resetClustersDataCache };
```

- [ ] **Step 5: Register the route** (`srv/server.js`, ~line 286)

```js
import { clustersDataHandler } from './lib/build-clusters-data.js';
// ...
app.get('/graph/clusters-data', clustersDataHandler);
```

- [ ] **Step 6: Allowlist the public endpoint**

Add `/graph/clusters-data` to `scripts/check-public-endpoints.ts` (it runs in `postbuild:apps`). The island fetches this client-side from a Hugo page, so it must be reachable — verify the intended auth posture matches `/graph/explore-data` (which is registered after `basicAuthMiddleware` but treated as public via the allowlist). Match whatever `/graph/explore-data` does exactly.

- [ ] **Step 7: Run unit test to verify it passes**

Run: `npx vitest run test/unit/srv/kg-clusters-data.test.js`
Expected: PASS.

- [ ] **Step 8: Write + run the hybrid test** (`test/hybrid/clusters-data-hybrid.test.js`)

```js
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
import { buildClustersDataPayload, buildClusterSubgraph } from '../../srv/lib/kg-clusters-data.js';

describe('clusters-data (hybrid)', () => {
  let db;
  beforeAll(async () => { db = await cds.connect.to('db'); });
  it('emits cluster super-nodes from real data', async () => {
    const { nodes, edges } = await buildClustersDataPayload(db);
    expect(nodes.length).toBeGreaterThan(0);
    expect(nodes[0].id).toMatch(/^c:/);
    expect(Array.isArray(edges)).toBe(true);
  });
  it('returns a subgraph for a real cluster slug', async () => {
    const { nodes } = await buildClustersDataPayload(db);
    const slug = nodes[0].slug;
    const sub = await buildClusterSubgraph(db, slug);
    expect(Array.isArray(sub.nodes)).toBe(true);
  });
});
```
Run: `npx vitest run --project hybrid test/hybrid/clusters-data-hybrid.test.js`

- [ ] **Step 9: Commit**

```bash
git add srv/lib/kg-clusters-data.js srv/lib/build-clusters-data.js srv/server.js scripts/check-public-endpoints.ts test/unit/srv/kg-clusters-data.test.js test/hybrid/clusters-data-hybrid.test.js
git commit -m "feat(topics): /graph/clusters-data super-graph + subgraph endpoint"
```

---

### Task 9: Sigma cluster-map island

**Files:**
- Create: `hugo-apps/src/topics-map/{main.ts,App.vue,ClusterMap.vue}`
- Modify: `hugo-apps/vite.config.ts` (add `topics-map` rollup input ~line 290; add a gzip-budget plugin mirroring `relatedGraphBudget`)
- Create: `scripts/build-topics-map-manifest.ts` + wire into build (only if the island needs a hash manifest like `/explore/`; if it emits to `/js/topics-map.js` via hugo-apps, it uses the standard `[name].js` output and NO manifest is needed — prefer this)
- Test: `hugo-apps/src/topics-map/App.test.ts` (mount + fetch-mock) + `test/unit/hugo/topics-map-vite-input.test.ts` (config assertion)

**Interfaces:**
- Consumes: `GET /graph/clusters-data` (super-graph) and `?cluster=<slug>` (subgraph); mounts on `[data-vue-island="topics-map"]`.
- Produces: `hugo/static/js/topics-map.js` bundle. Reads optional `data-focus-cluster` attribute to auto-expand a cluster (used by the cluster-detail mini-map).

**Reuse:** copy the graphology + Sigma + ForceAtlas2 setup from `app/explore/src/components/ExploreGraph.vue` (`MultiDirectedGraph`, `forceAtlas2.assign(graph, { iterations: 50 })`, `new Sigma(...)`, `nodeReducer`/`edgeReducer`). Add `sigma`, `graphology`, `graphology-layout-forceatlas2` to `hugo-apps/package.json` (same versions as `app/explore/package.json`: sigma 3.0.3, graphology 0.26.0, graphology-layout-forceatlas2 0.10.1).

**Interactions to implement:**
- Render super-nodes sized by `size`, colored per-cluster (stable hash of slug → hue). Edge thickness ∝ `weight`.
- Click super-node → fetch `?cluster=<slug>`, add its concept child-nodes, dim others (expand-in-place).
- A "See full graph →" link/button on an expanded cluster → navigate to `/explore/?focus=<topConceptSlug>` (Task 10 deep-link). Use the cluster's first concept slug as the focus target.
- Progressive enhancement: on fetch error, hide the island container (the baked gallery above remains).

- [ ] **Step 1: Write the failing config test** (`test/unit/hugo/topics-map-vite-input.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
describe('topics-map island is registered', () => {
  it('has a rollup input entry', () => {
    const cfg = readFileSync('hugo-apps/vite.config.ts', 'utf-8');
    expect(cfg).toMatch(/['"]topics-map['"]\s*:\s*resolve\(__dirname,\s*['"]src\/topics-map\/main\.ts['"]\)/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/hugo/topics-map-vite-input.test.ts`
Expected: FAIL.

- [ ] **Step 3: Add the rollup input** (`hugo-apps/vite.config.ts`)

Add after the `concepts-filter` entry (~line 290):
```js
'topics-map': resolve(__dirname, 'src/topics-map/main.ts'),
```
Add a gzip-budget plugin for it mirroring `relatedGraphBudget()` (Sigma is heavy — set budget ~150KB gzip like `/explore/`).

- [ ] **Step 4: Write the island** (`main.ts`, `App.vue`, `ClusterMap.vue`)

`main.ts` (discovery mount, like `related-graph/main.ts`):
```ts
import { createApp } from 'vue';
import App from './App.vue';
document.querySelectorAll('[data-vue-island="topics-map"]').forEach((el) => {
  createApp(App, { focusCluster: el.getAttribute('data-focus-cluster') || '' }).mount(el);
});
```
`App.vue` — fetch `/graph/clusters-data`, pass nodes/edges to `ClusterMap.vue`; on fetch failure emit nothing (container stays empty). `ClusterMap.vue` — the Sigma graph (copy `ExploreGraph.vue` structure), click-to-expand via `/graph/clusters-data?cluster=<slug>`, "See full graph" link to `/explore/?focus=<slug>`.

- [ ] **Step 5: Write the mount test** (`hugo-apps/src/topics-map/App.test.ts`)

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import App from './App.vue';

describe('topics-map App', () => {
  beforeEach(() => { globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ nodes: [{id:'c:hana',slug:'hana',label:'HANA',size:5}], edges: [] }) } as any); });
  it('fetches clusters-data on mount without throwing', async () => {
    const wrapper = mount(App, { props: { focusCluster: '' } });
    await new Promise((r) => setTimeout(r, 0));
    expect(globalThis.fetch).toHaveBeenCalledWith(expect.stringContaining('/graph/clusters-data'));
    expect(wrapper.exists()).toBe(true);
  });
  it('degrades quietly when fetch fails', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('down'));
    const wrapper = mount(App, { props: { focusCluster: '' } });
    await new Promise((r) => setTimeout(r, 0));
    expect(wrapper.exists()).toBe(true); // no throw
  });
});
```

> NOTE: mocking Sigma/WebGL in jsdom is painful. Keep `ClusterMap.vue`'s Sigma init behind an `onMounted` guard that no-ops if `container` has zero size (jsdom), so `App.test.ts` exercises fetch + data flow without a real WebGL context. The `/explore/` app tests take the same approach — check `app/explore` tests for the guard pattern before writing.

- [ ] **Step 6: Run tests + build the island**

Run: `npx vitest run test/unit/hugo/topics-map-vite-input.test.ts hugo-apps/src/topics-map/App.test.ts`
Then: `npm --prefix hugo-apps run build` and confirm `hugo/static/js/topics-map.js` emits within budget.
Expected: PASS + bundle emitted.

- [ ] **Step 7: Wire the bundle into the layouts**

In `hugo/layouts/topics/list.html` and `single.html`, include `<script type="module" src="/js/topics-map.js" defer></script>` near the island mount. (hugo-apps bundles are served at `/js/` — no hash manifest needed since output is `[name].js`.)

- [ ] **Step 8: Commit**

```bash
git add hugo-apps/src/topics-map/ hugo-apps/vite.config.ts hugo-apps/package.json hugo/layouts/topics/ test/unit/hugo/topics-map-vite-input.test.ts
git commit -m "feat(topics): Sigma cluster-map island with expand-in-place"
```

---

### Task 10: /explore/ deep-link pre-focus

**Files:**
- Modify: `app/explore/src/App.vue` (read `?focus=<slug>` on mount, resolve to node id, pre-focus camera)
- Test: extend an existing `app/explore` test or add `app/explore/src/App.focus.test.ts`

**Interfaces:**
- Consumes: URL `?focus=<conceptOrTutorialSlug>`.
- Produces: on load, `/explore/` centers/zooms the camera on that node (reuse the `applyPathOverlay` camera-fit block + `resolveNodeId(slug)` helper already in `App.vue:67-75`).

- [ ] **Step 1: Write the failing test** (`app/explore/src/App.focus.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import { parseFocusParam } from './focus-param';

describe('parseFocusParam', () => {
  it('extracts a valid focus slug from a query string', () => {
    expect(parseFocusParam('?focus=cap-handlers')).toBe('cap-handlers');
  });
  it('returns empty for missing or malformed focus', () => {
    expect(parseFocusParam('?x=1')).toBe('');
    expect(parseFocusParam('?focus=Bad Slug!')).toBe('');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/explore/src/App.focus.test.ts` (or via the explore project's test runner — check `app/explore/package.json` test script)
Expected: FAIL.

- [ ] **Step 3: Implement `parseFocusParam` + wire into App.vue**

Create `app/explore/src/focus-param.ts`:
```ts
export function parseFocusParam(search: string): string {
  const v = new URLSearchParams(search).get('focus') || '';
  return /^[a-z0-9][a-z0-9-]{0,80}$/.test(v) ? v : '';
}
```
In `App.vue`, on mount: `const focus = parseFocusParam(window.location.search); if (focus) { const id = resolveNodeId(focus); if (id) <center camera on id via the applyPathOverlay camera-fit block> }`. Keep it additive — do not disturb the existing find-path flow.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/explore/src/App.focus.test.ts`
Expected: PASS.

- [ ] **Step 5: Build + manual verify**

Run: `npm run build:explore` then load `/explore/?focus=<a-real-concept-slug>` and confirm the camera centers on that node.

- [ ] **Step 6: Commit**

```bash
git add app/explore/src/focus-param.ts app/explore/src/App.vue app/explore/src/App.focus.test.ts
git commit -m "feat(explore): ?focus= deep-link pre-focuses camera for topics handoff"
```

**Phase 3 checkpoint:** cluster map renders below the gallery, expands in place, and "See full graph" deep-links into a pre-focused `/explore/`. The continuous zoom (gallery → map → full graph) is complete.

---

## Phase 4 — Admin surface + homepage tie-in + e2e

**Deliverable:** admins can override a cluster's label and hide junk clusters; the #1170 homepage band links into the new front door; a committed e2e spec exercises the whole flow.

### Task 11: AdminService `TopicClusters` projection + actions

**Files:**
- Modify: `srv/admin-service.cds` (projection + actions; add bare `using` for the new db file if needed — but the entity is in `db/knowledge-graph-topic-clusters.cds`, a NEW split file, so **the #1531 rule applies: add `using from '../db/knowledge-graph-topic-clusters';` at the top of `srv/admin-service.cds`**)
- Modify: `srv/admin-service.js` (`after('READ')` virtual rollups + `overrideTopicLabel` / `setTopicClusterHidden` action handlers)
- Test: `test/unit/srv/admin-topic-clusters.test.js`

**Interfaces:**
- Produces (CDS):
  - `@readonly entity TopicClustersAdmin as projection on ims.TopicClusters { *, virtual null as effectiveLabel : String(120) };` (effectiveLabel = curatedLabel || label, computed in after('READ')).
  - `action overrideTopicLabel(slug: String(80), label: String(120)) returns Boolean;` (@requires 'Tutorial.Author' or 'SuperAdmin' — match the KgCommunities admin gate).
  - `action setTopicClusterHidden(slug: String(80), hidden: Boolean) returns Boolean;`
- Handlers write `curatedLabel` / `hidden` directly on `TopicClusters` via `UPDATE` (these two columns survive the nightly TRUNCATE only if the job preserves them — see NOTE).

> IMPORTANT NOTE (state survival): the nightly job TRUNCATE+INSERTs `TopicClusters`, which would wipe admin `curatedLabel`/`hidden` overrides. FIX: the job must read the PRIOR `curatedLabel`/`hidden` per slug (it already reads existing rows for reconciliation) and carry them forward into the new rows for slugs that persist. Add this to the Task 3 job: when building `existing`, also select `curatedLabel, hidden`; in the write step, for each upsert whose slug matched an existing row, use the prior `curatedLabel`/`hidden` instead of null/false. Update the Task 3 hybrid test to assert an override survives a re-run. **This task depends on that job change — make it here and re-run Task 3 tests.**

- [ ] **Step 1: Write the failing test** (`test/unit/srv/admin-topic-clusters.test.js`)

```js
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

describe('AdminService TopicClusters', () => {
  let admin;
  beforeAll(async () => {
    await cds.test('serve', '--project', '.', '--in-memory');
    admin = await cds.connect.to('AdminService');
    const { TopicClusters } = cds.entities('com.sap.developers.ims');
    await INSERT.into(TopicClusters).entries([{ slug: 'hana', label: 'HANA', curatedLabel: null, fingerprint: 'FP', previousFingerprints: '', status: 'ACTIVE', hidden: false, memberCount: 1, tutorialCount: 1, computedAt: new Date().toISOString() }]);
  });

  it('effectiveLabel falls back to label, prefers curatedLabel', async () => {
    const rows = await admin.run(SELECT.from('AdminService.TopicClustersAdmin').where({ slug: 'hana' }));
    expect(rows[0].effectiveLabel).toBe('HANA');
  });

  it('overrideTopicLabel sets curatedLabel', async () => {
    await admin.send('overrideTopicLabel', { slug: 'hana', label: 'SAP HANA Cloud' });
    const { TopicClusters } = cds.entities('com.sap.developers.ims');
    const row = await SELECT.one.from(TopicClusters).where({ slug: 'hana' });
    expect(row.curatedLabel).toBe('SAP HANA Cloud');
  });

  it('setTopicClusterHidden toggles hidden', async () => {
    await admin.send('setTopicClusterHidden', { slug: 'hana', hidden: true });
    const { TopicClusters } = cds.entities('com.sap.developers.ims');
    const row = await SELECT.one.from(TopicClusters).where({ slug: 'hana' });
    expect(row.hidden).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/srv/admin-topic-clusters.test.js`
Expected: FAIL.

- [ ] **Step 3: Add the `using` + projection + actions** (`srv/admin-service.cds`)

At the top, alongside the other `using from '../db/...'` lines:
```cds
using from '../db/knowledge-graph-topic-clusters';
```
In `extend service AdminService with { ... }` (near the KgCommunities projection ~line 1153):
```cds
@readonly
entity TopicClustersAdmin as projection on ims.TopicClusters {
  *,
  virtual null as effectiveLabel : String(120),
};

@requires: 'Tutorial.Author'
action overrideTopicLabel(slug : String(80), label : String(120)) returns Boolean;

@requires: 'Tutorial.Author'
action setTopicClusterHidden(slug : String(80), hidden : Boolean) returns Boolean;
```

- [ ] **Step 4: Implement handlers** (`srv/admin-service.js`)

```js
this.after('READ', 'TopicClustersAdmin', (rows) => {
  if (!rows) return;
  const list = Array.isArray(rows) ? rows : [rows];
  for (const r of list) r.effectiveLabel = r.curatedLabel || r.label;
});

this.on('overrideTopicLabel', async (req) => {
  const { slug, label } = req.data;
  const { TopicClusters } = cds.entities('com.sap.developers.ims');
  await UPDATE(TopicClusters).set({ curatedLabel: label }).where({ slug });
  return true;
});

this.on('setTopicClusterHidden', async (req) => {
  const { slug, hidden } = req.data;
  const { TopicClusters } = cds.entities('com.sap.developers.ims');
  await UPDATE(TopicClusters).set({ hidden }).where({ slug });
  return true;
});
```

- [ ] **Step 5: Update the Task 3 job to carry forward curatedLabel/hidden** (state survival)

In `_buildCommunitiesInput`, add `curatedLabel, hidden` to the existing-rows SELECT and expose an `overridesBySlug` Map. In `runKgTopicClusters`, when inserting an upsert whose slug matched an existing row, use the prior `curatedLabel`/`hidden`. Add to the Task 3 hybrid test: set an override, re-run the job, assert it survived.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run test/unit/srv/admin-topic-clusters.test.js`
Then re-run: `npx vitest run test/unit/srv/kg-topic-clusters-job.test.js`
Then: `npx cds deploy --to sqlite::memory: 2>&1 | tail -5`
Expected: PASS + clean deploy.

- [ ] **Step 7: Commit**

```bash
git add srv/admin-service.cds srv/admin-service.js srv/jobs/kg-topic-clusters-job.js test/unit/srv/admin-topic-clusters.test.js
git commit -m "feat(topics): admin label-override + hide actions with nightly carry-forward"
```

---

### Task 12: Admin FE app + shell nav

**Files:**
- Create: `app/admin/topicClusters/webapp/{Component.js,manifest.json,i18n/i18n.properties,ext/TopicClusterActionsController.controller.js}`
- Modify: `app/admin-annotations.cds` (`TopicClustersAdmin` LR/OP annotations)
- Modify: `app/admin-shell/webapp/model/navigation.json` (nav entry in `system` group)
- Modify: `app/admin-shell/scripts/admin-shell-overrides.js` (`order:` array + `prefix:` map — add `topicClusters: 'tc'`, verify no collision)
- Test: `test/unit/admin/topic-clusters-manifest.test.js` (manifest shape) — plus the shell manifest is generated, so also run the generator

**Interfaces:**
- Produces: `#topicClusters` admin route rendering a FE List Report over `AdminService.TopicClustersAdmin` with the two custom actions.

Scaffold by mirroring `app/admin/kgCommunities/` exactly (Component.js class name `sap.tutorials.admin.topicClusters.Component`, `dataSources.mainService.uri: "/admin/"`, LR route `TopicClustersList` + OP route `TopicClusters({key})`, contextPath `/TopicClustersAdmin`). Custom actions wired as manifest `controlConfiguration[...LineItem].actions` pressing `...ext.TopicClusterActionsController.onOverrideLabel` / `onToggleHidden` (JS-controller-driven dialogs — the label override needs an input dialog).

- [ ] **Step 1: Write the failing manifest test** (`test/unit/admin/topic-clusters-manifest.test.js`)

```js
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

describe('topicClusters admin manifest', () => {
  it('targets AdminService TopicClustersAdmin with LR + OP routes', () => {
    const m = JSON.parse(readFileSync('app/admin/topicClusters/webapp/manifest.json', 'utf-8'));
    expect(m['sap.app'].id).toBe('sap.tutorials.admin.topicClusters');
    expect(m['sap.app'].dataSources.mainService.uri).toBe('/admin/');
    const targets = m['sap.ui5'].routing.targets;
    const hasContextPath = JSON.stringify(targets).includes('/TopicClustersAdmin');
    expect(hasContextPath).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/admin/topic-clusters-manifest.test.js`
Expected: FAIL.

- [ ] **Step 3: Scaffold the app** (copy `app/admin/kgCommunities/webapp/` → `app/admin/topicClusters/webapp/`)

Rename ids to `topicClusters`, contextPath to `/TopicClustersAdmin`, routes to `TopicClustersList`/`TopicClusters({key})`. Add `ext/TopicClusterActionsController.controller.js` with `onOverrideLabel` (opens an input dialog, calls the `overrideTopicLabel` action) and `onToggleHidden` (calls `setTopicClusterHidden`). Follow the `KgCommunityActionsController` pattern for action invocation. Add `Component.js` + `i18n/i18n.properties`.

- [ ] **Step 4: Add annotations** (`app/admin-annotations.cds`)

`annotate AdminService.TopicClustersAdmin with @(UI: {...})` mirroring the KgCommunities block (HeaderInfo TypeName 'Topic Cluster', LineItem showing `effectiveLabel`, `tutorialCount`, `memberCount`, `status`, `hidden`; SelectionFields; FieldGroup). Add field-label annotations. **Heed the #986 gotcha:** do NOT put a default LR filter over a virtual column (`effectiveLabel` is virtual) — filter on the real `status='ACTIVE'` instead if a default filter is wanted.

- [ ] **Step 5: Register in the shell**

- `navigation.json`: add `{ "key": "topicClusters", "title": "Topic Clusters" }` in the `system` group.
- `admin-shell-overrides.js`: add `'topicClusters'` to the `order:` array and `topicClusters: 'tc'` to the `prefix:` map (verify `tc` is collision-free against existing prefixes).
- Regenerate the shell manifest: `node app/admin-shell/scripts/generate-manifest.js` (or the npm script that wraps it — check `jq '.scripts' package.json | grep -i manifest`).

- [ ] **Step 6: Run test + build the admin app**

Run: `npx vitest run test/unit/admin/topic-clusters-manifest.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add app/admin/topicClusters/ app/admin-annotations.cds app/admin-shell/webapp/model/navigation.json app/admin-shell/scripts/admin-shell-overrides.js app/admin-shell/webapp/manifest.json test/unit/admin/topic-clusters-manifest.test.js
git commit -m "feat(topics): admin FE app for topic-cluster label override + hide"
```

---

### Task 13: Homepage band "See all topics →" link

**Files:**
- Modify: `hugo/layouts/partials/homepage/topic-clusters-band.html`
- Test: `test/unit/hugo/topic-clusters-band.test.ts` (extend the existing #1170 test — add an assertion, do NOT change existing ones)

**Interfaces:** additive — the #1170 band gains a link to `/topics/`. Its 6-cluster content + #1170 hybrid contract are untouched.

- [ ] **Step 1: Extend the existing test** (add a case, keep all #1170 assertions)

```ts
it('links to the full /topics/ front door', () => {
  const src = readFileSync('hugo/layouts/partials/homepage/topic-clusters-band.html', 'utf-8');
  expect(src).toContain('/topics/');
  expect(src).toMatch(/See all topics|Explore all topics|View all/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/hugo/topic-clusters-band.test.ts`
Expected: FAIL on the new case only.

- [ ] **Step 3: Add the link** to the band's heading/footer

Inside the existing `{{ if gt (len $clusters) 0 }}` block, add near the `<h2>`:
```html
<a class="hp-topic-clusters__see-all" href="/topics/">See all topics &rarr;</a>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/hugo/topic-clusters-band.test.ts`
Expected: PASS (all, including #1170 originals).

- [ ] **Step 5: Commit**

```bash
git add hugo/layouts/partials/homepage/topic-clusters-band.html test/unit/hugo/topic-clusters-band.test.ts
git commit -m "feat(topics): link homepage topic-clusters band into /topics/ front door"
```

---

### Task 14: E2E spec + full-suite verification

**Files:**
- Create: `test/e2e/topics-discovery.spec.ts` (Playwright, self-skipping like the other e2e specs)
- Test: the spec itself

**Interfaces:** post-deploy Playwright, gated on `SMOKE_BASE_URL`/`PLAYWRIGHT_BASE_URL` (self-skips when absent, per the #1338 convention). Drives the real flow.

- [ ] **Step 1: Write the e2e spec** (`test/e2e/topics-discovery.spec.ts`)

Model on the existing `test/e2e/*.spec.ts` (auth via `SMOKE_TECH_USER`/`SMOKE_TECH_PASSWORD` basic auth; self-skip guard at top). Assert:
```ts
// 1. /topics/ renders gallery cards (main + h1; served pages use <main>+<h1>, NOT <article>)
// 2. clicking a card navigates to /topics/<slug>/ and shows the suggested-order/concepts list
// 3. a concept link goes to /concepts/<slug>
// 4. a peer-cluster link goes to another /topics/<slug>/
// 5. (best-effort) the cluster map island mounts (#topics-map has child nodes) — skip if WebGL unavailable in CI
```

- [ ] **Step 2: Run the e2e spec locally against DEV** (if creds available)

Run: `SMOKE_BASE_URL=https://tutorial-system-dev-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com npx playwright test test/e2e/topics-discovery.spec.ts`
Expected: PASS (or self-skip if creds/URL absent — note the skip for review, don't call it green).

- [ ] **Step 3: Run the full unit suite + lints**

Run:
```bash
npm test
npx cds deploy --to sqlite::memory: 2>&1 | tail -5
```
Expected: all unit tests green; clean SQLite deploy. Fix any regressions before proceeding.

- [ ] **Step 4: Commit**

```bash
git add test/e2e/topics-discovery.spec.ts
git commit -m "test(topics): e2e spec for gallery -> cluster -> concept -> explore flow"
```

**Phase 4 checkpoint:** admins can curate labels + hide clusters (surviving nightly re-runs); the homepage band funnels into the front door; a committed e2e spec guards the full flow.

---

## Final verification (before PR)

- [ ] Run the full unit suite: `npm test` — green.
- [ ] Run hybrid tests (needs `cf login` + `cds bind`): `npm run test:hybrid` — green or documented skips.
- [ ] `npx cds deploy --to sqlite::memory:` — clean.
- [ ] Run the nightly job once against DEV (`node -e "import('./srv/jobs/kg-topic-clusters-job.js').then(m=>m.runKgTopicClusters())"` via `cds bind --exec`), then `npm run fetch-topics-gallery`, then `npm run dev` and **manually verify `/topics/` + a cluster page + the map in a browser** (Tom's #1 rule — test the real user-facing thing through the real entry point).
- [ ] Open a PR with `gh pr create` (never direct-merge). Summarize: new front door, reconciliation pipeline, map + explore handoff, admin curation, homepage tie-in. Note the #1170 band is unchanged and the new feature is DEV-first.

## Deployment note

Per project rules: this touches `srv/`, `db/`, `hugo/`, `app/admin/**`, `app/explore/`, `hugo-apps/`, and the approuter allowlist. It requires a FULL deploy (`npm run deploy -- --env dev`, NO `--skip-build`/`-m`) — admin-UI + Hugo + approuter are all in scope. Deploy from a fresh `origin/main` after merge, not from this worktree. The nightly job runs at 04:47 UTC; on first deploy, trigger it once manually so `/topics/` has data before the first Hugo bake, or the gallery bakes empty until the next night.
