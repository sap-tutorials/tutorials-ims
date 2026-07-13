# Homepage "topic cluster" band Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render a nightly-refreshed homepage band of Louvain topic clusters (from `KgCommunityLabel`), each labeled and linking to its member tutorials.

**Architecture:** A read-only CAP handler joins `KgCommunityLabel` → `KgCommunitySummaryV` → `KgCommunity` members → live `Tutorials`, exposed at a public `/build/topic-clusters` Express route. A build-time fetch script bakes the payload into `hugo/data/topic_clusters.json`, and a static Hugo partial renders it (SSR-only, empty-safe by omission). Mirrors the featured-topics carousel pipeline (#1032) minus the Vue island.

**Tech Stack:** SAP CAP (Node.js, `@sap/cds`), CDS QL, Express, TypeScript (tsx build scripts), Hugo templates, Vitest (in-memory SQLite + hybrid HANA).

## Global Constraints

- **Slugs are lowercase canonical** — every slug compared against a `Tutorials` row MUST be `.toLowerCase()`d first. Mismatches manifest as "0 tutorials" for a cluster.
- **Tutorials publish filter** is `status = 'ACTIVE' OR status IS NULL` (Tutorials has no `published` column — `status` is the `TaskStatus` enum `{ ACTIVE; INACTIVE; }`). Copy this predicate verbatim.
- **Tutorial URL** is `/tutorials/${slug}` (lowercase slug), matching `srv/lib/featured-topics-snapshot.js:198`.
- **`/build/*` routes are public + unauthenticated**, read direct from `cds.connect.to('db')` (NOT through a `@requires`-gated service), and set `Cache-Control: public, max-age=60`.
- **Fail-open, never 500 a build** — every handler/script path degrades to `{ clusters: [] }` on error.
- **No BLOB/LargeString columns** appear in any query in this plan — plain CDS QL is safe.
- **No schema change** — this is read-only over existing entities. No `.hdbmigrationtable` bump, no `cds build --production` required.
- **Selection heuristic (fixed values):** rank labeled clusters by `tutorialCount` desc; require `>= 3` resolved live tutorials to qualify; show at most **6** clusters; cap **4** member tutorials per card, sorted `title ASC`.
- **Band title copy:** `Explore topic clusters`.

---

### Task 1: Read model — `build-topic-clusters.js` + `/build/topic-clusters` route

**Files:**
- Create: `srv/lib/build-topic-clusters.js`
- Modify: `srv/server.js` (add import near line 8; add route near line 199)
- Test: `test/unit/srv/build-topic-clusters.test.js`

**Interfaces:**
- Consumes: entities `com.sap.developers.ims.KgCommunityLabel` (`communityFingerprint`, `label`, `rationale`), `com.sap.developers.ims.KgCommunitySummaryV` (`communityFingerprint`, `tutorialCount`), `com.sap.developers.ims.KgCommunity` (`communityFingerprint`, `slug`, `vertexType`), `com.sap.developers.ims.Tutorials` (`slug`, `title`, `status`).
- Produces:
  - `export async function buildTopicClustersPayload(db): Promise<{ clusters: Cluster[], buildAt: string, error: string|null }>`
  - `export async function buildTopicClustersHandler(req, res): Promise<void>` (Express handler)
  - `Cluster = { label: string, rationale: string, communityFingerprint: string, tutorialCount: number, tutorials: { slug: string, title: string, url: string }[] }`
  - Route: `GET /build/topic-clusters`

- [ ] **Step 1: Write the failing test**

Create `test/unit/srv/build-topic-clusters.test.js`:

```javascript
// test/unit/srv/build-topic-clusters.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');
const NS = 'com.sap.developers.ims';

// Seed a controlled fixture graph: 8 labeled communities of varying sizes,
// one unlabeled community, one mixed-case member slug, one INACTIVE tutorial,
// one member whose slug does not resolve to any Tutorials row.
beforeAll(async () => {
  await project; // ensure server up
  const db = await cds.connect.to('db');
  const { KgCommunity, KgCommunityLabel, Tutorials } = cds.entities(NS);

  // Helper: create a community fingerprint with `n` tutorial members
  // slugged clu<c>-t<i>, plus matching ACTIVE Tutorials rows.
  const communities = [];
  const tutorials = [];
  const labels = [];
  // 7 labeled communities sized 6,5,5,4,4,3,3  → all qualify (>=3)
  const sizes = [6, 5, 5, 4, 4, 3, 3];
  sizes.forEach((n, c) => {
    const fp = `fp-${c}`.padEnd(8, '0');
    labels.push({ communityFingerprint: fp, label: `Cluster ${c}`, rationale: `why ${c}`, memberSlugsHash: `h${c}`, labeledAt: new Date().toISOString(), model: 'test' });
    for (let i = 0; i < n; i++) {
      const slug = `clu${c}-t${i}`;
      communities.push({ communityId: c, vertexKey: `t:${slug}`, vertexType: 'tutorial', slug, communityFingerprint: fp, detectedAt: new Date().toISOString() });
      tutorials.push({ ID: cds.utils.uuid(), slug, title: `Z Cluster ${c} Tut ${i}`, status: 'ACTIVE' });
    }
  });

  // Labeled community that only has 2 resolvable tutorials → must be dropped by the >=3 gate.
  const fpThin = 'fp-thin0';
  labels.push({ communityFingerprint: fpThin, label: 'Thin Cluster', rationale: 'thin', memberSlugsHash: 'ht', labeledAt: new Date().toISOString(), model: 'test' });
  ['thin-a', 'thin-b'].forEach((slug) => {
    communities.push({ communityId: 90, vertexKey: `t:${slug}`, vertexType: 'tutorial', slug, communityFingerprint: fpThin, detectedAt: new Date().toISOString() });
    tutorials.push({ ID: cds.utils.uuid(), slug, title: `Thin ${slug}`, status: 'ACTIVE' });
  });

  // Unlabeled community (3 tutorials) → must NOT appear (no label row).
  const fpUnlabeled = 'fp-unl00';
  for (let i = 0; i < 3; i++) {
    const slug = `unl-t${i}`;
    communities.push({ communityId: 91, vertexKey: `t:${slug}`, vertexType: 'tutorial', slug, communityFingerprint: fpUnlabeled, detectedAt: new Date().toISOString() });
    tutorials.push({ ID: cds.utils.uuid(), slug, title: `Unlabeled ${i}`, status: 'ACTIVE' });
  }

  // Community with a mixed-case member slug + an INACTIVE tutorial + an
  // unresolvable member. Labeled, has 3 ACTIVE resolvable → qualifies at exactly 3.
  const fpEdge = 'fp-edge0';
  labels.push({ communityFingerprint: fpEdge, label: 'Edge Cluster', rationale: 'edge', memberSlugsHash: 'he', labeledAt: new Date().toISOString(), model: 'test' });
  // mixed-case member; Tutorials row is stored lowercase
  communities.push({ communityId: 92, vertexKey: 't:Edge-Mixed', vertexType: 'tutorial', slug: 'Edge-Mixed', communityFingerprint: fpEdge, detectedAt: new Date().toISOString() });
  tutorials.push({ ID: cds.utils.uuid(), slug: 'edge-mixed', title: 'A Edge Mixed', status: 'ACTIVE' });
  communities.push({ communityId: 92, vertexKey: 't:edge-active2', vertexType: 'tutorial', slug: 'edge-active2', communityFingerprint: fpEdge, detectedAt: new Date().toISOString() });
  tutorials.push({ ID: cds.utils.uuid(), slug: 'edge-active2', title: 'B Edge Active', status: 'ACTIVE' });
  communities.push({ communityId: 92, vertexKey: 't:edge-null', vertexType: 'tutorial', slug: 'edge-null', communityFingerprint: fpEdge, detectedAt: new Date().toISOString() });
  tutorials.push({ ID: cds.utils.uuid(), slug: 'edge-null', title: 'C Edge Null Status', status: null });
  communities.push({ communityId: 92, vertexKey: 't:edge-inactive', vertexType: 'tutorial', slug: 'edge-inactive', communityFingerprint: fpEdge, detectedAt: new Date().toISOString() });
  tutorials.push({ ID: cds.utils.uuid(), slug: 'edge-inactive', title: 'D Edge Inactive', status: 'INACTIVE' });
  communities.push({ communityId: 92, vertexKey: 't:edge-ghost', vertexType: 'tutorial', slug: 'edge-ghost', communityFingerprint: fpEdge, detectedAt: new Date().toISOString() });
  // no Tutorials row for edge-ghost

  await db.run(INSERT.into(Tutorials).entries(tutorials));
  await db.run(INSERT.into(KgCommunity).entries(communities));
  await db.run(INSERT.into(KgCommunityLabel).entries(labels));
});

describe('build-topic-clusters read model (#1170)', () => {
  it('returns top-6 qualifying labeled clusters, ranked by tutorialCount desc', async () => {
    const { buildTopicClustersPayload } = await import('../../../srv/lib/build-topic-clusters.js');
    const db = await cds.connect.to('db');
    const { clusters } = await buildTopicClustersPayload(db);
    expect(clusters.length).toBe(6);
    const counts = clusters.map(c => c.tutorialCount);
    expect(counts).toEqual([...counts].sort((a, b) => b - a)); // descending
    expect(counts[0]).toBe(6);
  });

  it('excludes unlabeled communities', async () => {
    const { buildTopicClustersPayload } = await import('../../../srv/lib/build-topic-clusters.js');
    const db = await cds.connect.to('db');
    const { clusters } = await buildTopicClustersPayload(db);
    const titles = clusters.flatMap(c => c.tutorials.map(t => t.title));
    expect(titles.some(t => t.startsWith('Unlabeled'))).toBe(false);
  });

  it('drops labeled clusters with fewer than 3 resolvable live tutorials', async () => {
    const { buildTopicClustersPayload } = await import('../../../srv/lib/build-topic-clusters.js');
    const db = await cds.connect.to('db');
    const { clusters } = await buildTopicClustersPayload(db);
    expect(clusters.find(c => c.label === 'Thin Cluster')).toBeUndefined();
  });

  it('caps member tutorials at 4 per card, sorted title ASC, with correct url', async () => {
    const { buildTopicClustersPayload } = await import('../../../srv/lib/build-topic-clusters.js');
    const db = await cds.connect.to('db');
    const { clusters } = await buildTopicClustersPayload(db);
    const biggest = clusters[0]; // tutorialCount 6
    expect(biggest.tutorials.length).toBe(4);
    const titles = biggest.tutorials.map(t => t.title);
    expect(titles).toEqual([...titles].sort());
    expect(biggest.tutorials[0].url).toBe(`/tutorials/${biggest.tutorials[0].slug}`);
  });

  it('joins slugs case-insensitively and excludes INACTIVE / unresolvable, keeps status NULL', async () => {
    const { buildTopicClustersPayload } = await import('../../../srv/lib/build-topic-clusters.js');
    const db = await cds.connect.to('db');
    const { clusters } = await buildTopicClustersPayload(db);
    const edge = clusters.find(c => c.label === 'Edge Cluster');
    expect(edge).toBeDefined();
    const slugs = edge.tutorials.map(t => t.slug).sort();
    // mixed-case 'Edge-Mixed' resolves to lowercased 'edge-mixed';
    // edge-active2 + edge-null (NULL status) included; edge-inactive + edge-ghost excluded.
    expect(slugs).toEqual(['edge-active2', 'edge-mixed', 'edge-null']);
  });

  it('handler responds 200 with clusters + Cache-Control', async () => {
    const res = await project.get('/build/topic-clusters');
    expect(res.status).toBe(200);
    expect(res.data).toHaveProperty('clusters');
    expect(res.data).toHaveProperty('buildAt');
    expect(res.headers['cache-control']).toContain('max-age=60');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/srv/build-topic-clusters.test.js`
Expected: FAIL — `Cannot find module '../../../srv/lib/build-topic-clusters.js'` (and the `/build/topic-clusters` request 404s).

- [ ] **Step 3: Write the read-model module**

Create `srv/lib/build-topic-clusters.js`:

```javascript
// srv/lib/build-topic-clusters.js
//
// Express middleware backing GET /build/topic-clusters (#1170).
// Pattern matches srv/lib/build-concepts.js: unauthenticated, read direct
// from the db service, consumed by scripts/fetch-topic-clusters.ts at Hugo
// build time.
//
// Joins Louvain topic clusters (KgCommunityLabel, #1126) to their live
// tutorial members and returns the top-N labeled clusters for the homepage
// "topic cluster" band.  Fail-open: any throw yields { clusters: [] } so a
// backend hiccup never 500s a build.

import cds from '@sap/cds';

const log = cds.log('build-topic-clusters');

const MAX_CLUSTERS = 6;        // clusters shown in the band
const MIN_TUTORIALS = 3;       // gate: a cluster needs >= this many live tutorials
const MAX_TUTORIALS_PER_CARD = 4;
const NS = 'com.sap.developers.ims';

export async function buildTopicClustersPayload(db) {
  const buildAt = new Date().toISOString();
  try {
    const { KgCommunityLabel, KgCommunitySummaryV, KgCommunity, Tutorials } = cds.entities(NS);

    // 1. All labeled communities (small table).
    const labels = await db.run(
      SELECT.from(KgCommunityLabel).columns('communityFingerprint', 'label', 'rationale')
    );
    if (!labels || labels.length === 0) return { clusters: [], buildAt, error: null };

    // 2. fingerprint -> tutorialCount, to rank + gate.
    const summary = await db.run(
      SELECT.from(KgCommunitySummaryV).columns('communityFingerprint', 'tutorialCount')
    );
    const countByFp = new Map();
    for (const r of summary) {
      // KgCommunitySummaryV aggregates per communityId; a fingerprint can span
      // multiple ids across a Louvain pass — keep the max tutorialCount seen.
      const prev = countByFp.get(r.communityFingerprint) ?? 0;
      if ((r.tutorialCount ?? 0) > prev) countByFp.set(r.communityFingerprint, r.tutorialCount ?? 0);
    }

    // 3. Keep labeled fingerprints that clear the min gate; rank; take top-N.
    //    (Over-fetch a few extra so the post-resolution re-gate in step 6 can
    //    still fill MAX_CLUSTERS if a borderline cluster loses tutorials.)
    const ranked = labels
      .map(l => ({ ...l, tutorialCount: countByFp.get(l.communityFingerprint) ?? 0 }))
      .filter(l => l.tutorialCount >= MIN_TUTORIALS)
      .sort((a, b) => b.tutorialCount - a.tutorialCount)
      .slice(0, MAX_CLUSTERS * 2);

    const clusters = [];
    for (const cluster of ranked) {
      if (clusters.length >= MAX_CLUSTERS) break;

      // 4. Tutorial-typed members for this fingerprint; lowercase slugs
      //    (canonical-slug gotcha).
      const members = await db.run(
        SELECT.from(KgCommunity)
          .columns('slug')
          .where({ communityFingerprint: cluster.communityFingerprint, vertexType: 'tutorial' })
      );
      const memberSlugs = [...new Set(members.map(m => (m.slug || '').toLowerCase()).filter(Boolean))];
      if (memberSlugs.length < MIN_TUTORIALS) continue;

      // 5. Resolve to live tutorials (ACTIVE or NULL status), title ASC.
      const live = await db.run(
        SELECT.from(Tutorials)
          .columns('slug', 'title')
          .where(`slug in (${memberSlugs.map(() => '?').join(',')})`, ...memberSlugs)
          .and(`status = 'ACTIVE' or status is null`)
          .orderBy('title asc')
      );

      // 6. Re-gate on resolved live count; cap per-card; build url.
      if (live.length < MIN_TUTORIALS) continue;
      clusters.push({
        label: cluster.label,
        rationale: cluster.rationale,
        communityFingerprint: cluster.communityFingerprint,
        tutorialCount: cluster.tutorialCount,
        tutorials: live.slice(0, MAX_TUTORIALS_PER_CARD).map(t => ({
          slug: t.slug,
          title: t.title,
          url: `/tutorials/${t.slug}`,
        })),
      });
    }

    return { clusters, buildAt, error: null };
  } catch (err) {
    log.error('failed to build /build/topic-clusters payload', err);
    return { clusters: [], buildAt, error: err.message };
  }
}

export async function buildTopicClustersHandler(_req, res) {
  const db = await cds.connect.to('db');
  const payload = await buildTopicClustersPayload(db);
  res.set('Cache-Control', 'public, max-age=60');
  res.json(payload);
}
```

> **CDS QL note for the implementer:** the `.where('slug in (?, ?, …)', ...args)` string+params form is used (not `.where({ slug: { in: [...] } })`) because it composes cleanly with the raw `status` predicate and matches how `build-catalog.js:25` writes the same `status = 'ACTIVE' or status is null` clause. Communities are small (≤ tens of members), so the bound-param count is well within HANA limits.

- [ ] **Step 4: Register the route in `srv/server.js`**

Add the import after line 8 (`import { buildConceptsHandler } from './lib/build-concepts.js';`):

```javascript
import { buildTopicClustersHandler } from './lib/build-topic-clusters.js';
```

Add the route registration right after the `/build/concepts` line (currently `srv/server.js:199`):

```javascript
  app.get('/build/topic-clusters', buildTopicClustersHandler);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/unit/srv/build-topic-clusters.test.js`
Expected: PASS (all 6 tests).

- [ ] **Step 6: Commit**

```bash
git add srv/lib/build-topic-clusters.js srv/server.js test/unit/srv/build-topic-clusters.test.js
git commit -m "feat(#1170): /build/topic-clusters read model for homepage cluster band"
```

---

### Task 2: Build-time fetch script → `hugo/data/topic_clusters.json`

**Files:**
- Create: `scripts/fetch-topic-clusters.ts`
- Modify: `package.json` (add `fetch-topic-clusters` script; insert into `build:all` after `fetch-featured-topics`)
- Test: `test/unit/scripts/fetch-topic-clusters.test.ts`

**Interfaces:**
- Consumes: `GET ${CAP_BASE_URL}/build/topic-clusters` returning `{ clusters, buildAt, error }` from Task 1.
- Produces: `hugo/data/topic_clusters.json` with shape `{ clusters: Cluster[], buildAt: string, error: string|null }`; npm scripts `fetch-topic-clusters` and its slot in `build:all`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/scripts/fetch-topic-clusters.test.ts`:

```typescript
// test/unit/scripts/fetch-topic-clusters.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const OUT = join('hugo', 'data', 'topic_clusters.json');

describe('fetch-topic-clusters script (#1170)', () => {
  beforeEach(() => {
    mkdirSync(join('hugo', 'data'), { recursive: true });
    if (existsSync(OUT)) rmSync(OUT);
    vi.resetModules();
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('writes clusters from a successful fetch', async () => {
    const body = { clusters: [{ label: 'X', rationale: 'r', communityFingerprint: 'fp', tutorialCount: 4, tutorials: [] }], buildAt: '2026-07-13T00:00:00Z', error: null };
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => body })));
    await import('../../../scripts/fetch-topic-clusters.ts');
    const written = JSON.parse(readFileSync(OUT, 'utf-8'));
    expect(written.clusters).toHaveLength(1);
    expect(written.clusters[0].label).toBe('X');
  });

  it('writes an empty payload on fetch failure (never throws)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })));
    await import('../../../scripts/fetch-topic-clusters.ts');
    const written = JSON.parse(readFileSync(OUT, 'utf-8'));
    expect(written.clusters).toEqual([]);
    expect(written.error).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/scripts/fetch-topic-clusters.test.ts`
Expected: FAIL — `Cannot find module '../../../scripts/fetch-topic-clusters.ts'`.

- [ ] **Step 3: Write the fetch script**

Create `scripts/fetch-topic-clusters.ts` (mirrors `scripts/fetch-featured-topics.ts`):

```typescript
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const CAP_BASE = process.env.CAP_BASE_URL || 'http://localhost:4004';
const OUT_PATH = join('hugo', 'data', 'topic_clusters.json');

async function main() {
  let payload = {
    clusters: [] as unknown[],
    buildAt: new Date().toISOString(),
    error: null as string | null,
  };
  try {
    const res = await fetch(`${CAP_BASE}/build/topic-clusters`);
    if (!res.ok) throw new Error(`status ${res.status}`);
    const body = await res.json();
    payload = { ...payload, ...body };
  } catch (err: any) {
    payload.error = err.message;
    console.warn(`[fetch-topic-clusters] WARN: ${err.message} — writing empty payload`);
  }
  mkdirSync(join('hugo', 'data'), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(payload, null, 2), 'utf-8');
  console.log(`[fetch-topic-clusters] wrote ${payload.clusters?.length ?? 0} clusters to ${OUT_PATH}`);
}

main().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 4: Wire into `package.json`**

Add to the `scripts` block, right after the `fetch-featured-topics` line:

```json
    "fetch-topic-clusters": "tsx scripts/fetch-topic-clusters.ts",
```

In the `build:all` script string, insert `&& npm run fetch-topic-clusters` immediately after `&& npm run fetch-featured-topics`. The resulting fragment reads:

```
… && npm run fetch-featured-topics && npm run fetch-topic-clusters && npm run build:css && …
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/unit/scripts/fetch-topic-clusters.test.ts`
Expected: PASS (both tests). Then verify the JSON parses:
Run: `node -e "JSON.parse(require('fs').readFileSync('hugo/data/topic_clusters.json','utf-8')); console.log('ok')"`
Expected: `ok`.

- [ ] **Step 6: Commit**

```bash
git add scripts/fetch-topic-clusters.ts package.json test/unit/scripts/fetch-topic-clusters.test.ts hugo/data/topic_clusters.json
git commit -m "feat(#1170): bake topic-clusters payload into hugo/data via fetch script"
```

---

### Task 3: SSR Hugo partial + homepage placement + CSS

**Files:**
- Create: `hugo/layouts/partials/homepage/topic-clusters-band.html`
- Modify: `hugo/layouts/index.html` (insert partial call between `community-lane` and `directory-footer`, currently lines 15–16)
- Modify: `hugo/assets/css/homepage.css` (append `hp-topic-clusters` block)
- Test: `test/unit/hugo/topic-clusters-band.test.ts`

**Interfaces:**
- Consumes: `.Site.Data.topic_clusters` (Hugo auto-loads `hugo/data/topic_clusters.json` from Task 2) with shape `{ clusters: [{ label, rationale, communityFingerprint, tutorialCount, tutorials: [{ slug, title, url }] }] }`.
- Produces: a `<section class="hp-band hp-topic-clusters">` in the homepage output when clusters exist; nothing at all when empty.

- [ ] **Step 1: Write the failing test**

Create `test/unit/hugo/topic-clusters-band.test.ts`. This is a template-logic unit test that renders the partial through Hugo by writing a fixture data file and running the Hugo build, then asserts on the emitted HTML. Follow the existing pattern in `test/unit/hugo/featured-topics-empty-snapshot-shell.test.ts` (read it first for the exact Hugo-invocation helper this repo uses). The assertions to encode:

```typescript
// test/unit/hugo/topic-clusters-band.test.ts
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// NOTE: mirror the Hugo-render harness used by
// test/unit/hugo/featured-topics-empty-snapshot-shell.test.ts — if that test
// builds the whole site into a temp publishDir and greps hugo/public, do the
// same here rather than inventing a new harness.

const DATA = join('hugo', 'data', 'topic_clusters.json');
const HOME = join('hugo', 'public', 'index.html');

function buildHugo() {
  execFileSync('npx', ['hugo', '--source', 'hugo', '--quiet'], { stdio: 'pipe' });
}

describe('topic-clusters-band partial (#1170)', () => {
  it('renders the band with cluster labels + tutorial links when data present', () => {
    mkdirSync(join('hugo', 'data'), { recursive: true });
    writeFileSync(DATA, JSON.stringify({
      clusters: [
        { label: 'SAP RAP & Fiori', rationale: 'core', communityFingerprint: 'fp1', tutorialCount: 5,
          tutorials: [{ slug: 'abap-rap-basics', title: 'ABAP RAP Basics', url: '/tutorials/abap-rap-basics' }] },
        { label: 'CAP on BTP', rationale: 'cloud', communityFingerprint: 'fp2', tutorialCount: 4, tutorials: [] },
        { label: 'HANA Cloud', rationale: 'db', communityFingerprint: 'fp3', tutorialCount: 3, tutorials: [] },
      ], buildAt: '2026-07-13T00:00:00Z', error: null,
    }), 'utf-8');
    buildHugo();
    const html = readFileSync(HOME, 'utf-8');
    expect(html).toContain('Explore topic clusters');
    expect(html).toContain('SAP RAP &amp; Fiori');
    expect(html).toContain('/tutorials/abap-rap-basics');
    expect(html).toContain('hp-topic-clusters');
  });

  it('emits NO band section when clusters are empty', () => {
    writeFileSync(DATA, JSON.stringify({ clusters: [], buildAt: '2026-07-13T00:00:00Z', error: null }), 'utf-8');
    buildHugo();
    const html = readFileSync(HOME, 'utf-8');
    expect(html).not.toContain('hp-topic-clusters');
    expect(html).not.toContain('Explore topic clusters');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/hugo/topic-clusters-band.test.ts`
Expected: FAIL — the partial does not exist / homepage does not contain `hp-topic-clusters`.

- [ ] **Step 3: Write the SSR partial**

Create `hugo/layouts/partials/homepage/topic-clusters-band.html`:

```html
{{- /* topic-clusters-band.html — issue #1170.
       Reads .Site.Data.topic_clusters (populated by scripts/fetch-topic-clusters.ts
       calling GET /build/topic-clusters). SSR-only — no Vue island, no hydration.

       Payload shape:
         { clusters: [{ label, rationale, communityFingerprint, tutorialCount,
           tutorials: [{ slug, title, url }] }], buildAt, error }

       EMPTY-SAFE BY OMISSION: unlike featured-topics (which always emits a shell
       for its island to hydrate), this band has no island. When clusters is empty
       or absent we render ZERO DOM — no <section>, no header — so an empty band
       is truly hidden, never an empty box. */ -}}
{{- $tc := .Site.Data.topic_clusters | default (dict "clusters" slice) -}}
{{- $clusters := $tc.clusters | default slice -}}
{{- if gt (len $clusters) 0 -}}
<section class="hp-band hp-topic-clusters" aria-labelledby="hp-topic-clusters-title">
  <h2 id="hp-topic-clusters-title" class="hp-band__title">Explore topic clusters</h2>
  <div class="hp-topic-clusters__grid">
    {{- range $clusters -}}
    <div class="hp-topic-clusters__cluster" id="cluster-{{ .communityFingerprint }}">
      <h3 class="hp-topic-clusters__label">{{ .label }}</h3>
      {{- with .rationale }}<p class="hp-topic-clusters__rationale">{{ . }}</p>{{- end }}
      <ul class="hp-topic-clusters__links">
        {{- range .tutorials -}}
        <li><a href="{{ .url }}">{{ .title }}</a></li>
        {{- end -}}
      </ul>
    </div>
    {{- end -}}
  </div>
</section>
{{- end -}}
```

- [ ] **Step 4: Place the partial in `hugo/layouts/index.html`**

Between the `community-lane.html` call (line 15) and the `directory-footer.html` call (line 16), insert:

```html
  {{ partial "homepage/topic-clusters-band.html" . }}
```

Resulting order:

```html
  {{ partial "homepage/community-lane.html" . }}
  {{ partial "homepage/topic-clusters-band.html" . }}
  {{ partial "homepage/directory-footer.html" (dict "shelves" $shelves) }}
```

- [ ] **Step 5: Add CSS**

Append to `hugo/assets/css/homepage.css`:

```css
/* ===== Topic cluster band (#1170) ===== */
.hp-topic-clusters__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 1rem;
}

.hp-topic-clusters__cluster {
  padding: 1rem;
  border-radius: 8px;
  background: var(--sapBaseColor, #fff);
  border: 1px solid var(--sapList_BorderColor, #e5e5e5);
}

.hp-topic-clusters__label {
  font-size: 1.1rem;
  font-weight: 600;
  color: var(--sapTextColor, #32363a);
  margin: 0 0 0.25rem;
}

.hp-topic-clusters__rationale {
  font-size: 0.85rem;
  color: var(--sapContent_LabelColor, #6a6d70);
  margin: 0 0 0.5rem;
}

.hp-topic-clusters__links {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.hp-topic-clusters__links a {
  color: var(--sapLinkColor, #0070f3);
  text-decoration: none;
}

.hp-topic-clusters__links a:hover {
  text-decoration: underline;
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run test/unit/hugo/topic-clusters-band.test.ts`
Expected: PASS (both tests — band renders with data, absent when empty).

- [ ] **Step 7: Commit**

```bash
git add hugo/layouts/partials/homepage/topic-clusters-band.html hugo/layouts/index.html hugo/assets/css/homepage.css test/unit/hugo/topic-clusters-band.test.ts
git commit -m "feat(#1170): SSR topic-clusters homepage band + CSS + placement"
```

---

### Task 4: Hybrid coverage — real HANA join

**Files:**
- Create: `test/hybrid/1170-topic-clusters.test.js`

**Interfaces:**
- Consumes: the deployed/bound HANA `KgCommunity`, `KgCommunityLabel`, `KgCommunitySummaryV`, `Tutorials`, and the `/build/topic-clusters` route from Task 1.
- Produces: end-to-end assurance that the join returns real labeled clusters with resolved tutorial titles against HANA.

- [ ] **Step 1: Write the hybrid test**

Create `test/hybrid/1170-topic-clusters.test.js` (read-only — no writes, so no `ALLOW_HYBRID_WRITES` gate needed; still HANA-guarded):

```javascript
// test/hybrid/1170-topic-clusters.test.js
//
// Verifies GET /build/topic-clusters against real HANA (DEV space). Read-only:
// asserts the KgCommunityLabel ⋈ KgCommunity ⋈ Tutorials join resolves labeled
// clusters with live tutorial titles. Runs via `npm run test:hybrid` after
// `cds bind` to the DEV space (which has 18 labeled communities as of #1163).
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--profile', 'hybrid');

let isHana = false;
beforeAll(async () => {
  const db = await cds.connect.to('db');
  isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
});

describe.runIf(process.env.CDS_ENV === 'hybrid' || true)('topic-clusters band [hybrid]', () => {
  it('returns labeled clusters with resolved live tutorials from HANA', async () => {
    if (!isHana) {
      throw new Error('1170-topic-clusters.test.js must run against HANA (npm run test:hybrid after cds bind).');
    }
    const res = await project.get('/build/topic-clusters');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data.clusters)).toBe(true);
    // DEV has 18 labeled communities; expect at least a few qualifying clusters.
    expect(res.data.clusters.length).toBeGreaterThanOrEqual(1);
    for (const c of res.data.clusters) {
      expect(typeof c.label).toBe('string');
      expect(c.label.length).toBeGreaterThan(0);
      expect(c.tutorials.length).toBeGreaterThanOrEqual(3);      // min gate
      expect(c.tutorials.length).toBeLessThanOrEqual(4);         // per-card cap
      for (const t of c.tutorials) {
        expect(t.slug).toBe(t.slug.toLowerCase());                // canonical slug
        expect(t.url).toBe(`/tutorials/${t.slug}`);
        expect(typeof t.title).toBe('string');
      }
      // title ASC within card
      const titles = c.tutorials.map(t => t.title);
      expect(titles).toEqual([...titles].sort());
    }
    // ranked by tutorialCount desc across the band
    const counts = res.data.clusters.map(c => c.tutorialCount);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
  });
});
```

> **Implementer note:** confirm the hybrid harness idiom against a sibling read-only hybrid test before finalizing the `describe.runIf` guard — match whatever the repo uses (e.g. `test/hybrid/_guard.js` `isSafeForWrites()` is for write tests; a read-only test may just HANA-guard in the body as above). Do not leave `|| true` if the repo has a cleaner env guard; replace it with the sibling pattern.

- [ ] **Step 2: Run the hybrid test**

Run: `npm run test:hybrid -- test/hybrid/1170-topic-clusters.test.js` (requires `cf login` + `cds bind` to DEV).
Expected: PASS. If DEV currently has zero *qualifying* clusters (all labeled communities below the min-3 live-tutorial gate), relax the `>= 1` assertion to `>= 0` and log the observed count — but first verify the count by probing `/build/topic-clusters` directly (`curl` the bound endpoint) to confirm the read model is correct, not the data.

- [ ] **Step 3: Commit**

```bash
git add test/hybrid/1170-topic-clusters.test.js
git commit -m "test(#1170): hybrid coverage for topic-clusters HANA join"
```

---

### Task 5: Full-suite verification + deploy-readiness check

**Files:** none (verification only)

- [ ] **Step 1: Run the full unit suite**

Run: `npm test`
Expected: PASS — no regressions. The three new unit test files pass; nothing else breaks.

- [ ] **Step 2: Confirm no schema/deploy artifacts were needed**

Run: `git status --porcelain` and confirm no `db/**`, `.hdbmigrationtable`, or `db/last-dev/` files changed (this task set is read-only over existing entities — if any appear, something went wrong).
Expected: only the files listed in Tasks 1–4.

- [ ] **Step 3: Confirm no new `srv-qa` cp-list dependency**

`srv/lib/build-topic-clusters.js` imports only `@sap/cds`. Verify:
Run: `grep -n "^import" srv/lib/build-topic-clusters.js`
Expected: a single `import cds from '@sap/cds';`. No new `srv/lib/*` transitive dep → no `.deploy/mta.yaml` `srv-qa` cp entry needed. (It's registered in `srv/server.js`, not reachable from `content-store.js`, so the QA-boot cp-list audit is unaffected.)

- [ ] **Step 4: Local end-to-end smoke (optional, if a HANA-backed CAP is reachable)**

With `CAP_BASE_URL` exported at the deployed backend:
Run: `npm run fetch-topic-clusters && node -e "const d=require('./hugo/data/topic_clusters.json'); console.log('clusters:', d.clusters.length)"`
Expected: prints a cluster count (≥0). Then `npm run build:hugo` and grep `hugo/public/index.html` for `Explore topic clusters` (present iff clusters ≥ 1).

- [ ] **Step 5: Push branch + open draft PR**

```bash
git push -u origin worktree-issue-1170-topic-cluster-band
gh pr create --draft --title "feat(#1170): homepage topic-cluster band" --body "Implements #1170 — surfaces Louvain topic clusters (#1126) as an SSR homepage band. See docs/superpowers/specs/2026-07-13-1170-homepage-topic-cluster-band-design.md and docs/superpowers/plans/2026-07-13-1170-homepage-topic-cluster-band.md."
```

---

## Self-Review

**Spec coverage:**
- Read model / `GET /build/topic-clusters` → Task 1. ✓
- Hugo bake (`CAP_BASE_URL` contract) → Task 2. ✓
- Selection heuristic (top-6, min-3, 4/card, title ASC, member-count rank) → Task 1 (constants) + tests. ✓
- Refresh via `build:all`, no new job → Task 2 (build:all wiring). ✓
- Empty-safe / fail-open → Task 1 (200 + `{clusters:[]}`) + Task 3 (render-nothing). ✓
- `.toLowerCase()` slug joins + ACTIVE/null filter → Task 1 steps 4–5 + tests. ✓
- Unit + hybrid coverage → Tasks 1, 2, 3 (unit), Task 4 (hybrid). ✓
- Placement (before directory-footer) → Task 3 step 4. ✓
- No schema change / cp-list audit → Task 5. ✓

**Placeholder scan:** No TBD/TODO. Every code step shows complete code. The two "read the sibling harness first" notes (Task 3 Hugo-render, Task 4 hybrid guard) point at named existing files and give the fallback code inline — not placeholders.

**Type consistency:** `buildTopicClustersPayload(db)` / `buildTopicClustersHandler(req,res)` and the `Cluster` shape (`label, rationale, communityFingerprint, tutorialCount, tutorials:[{slug,title,url}]`) are identical across Tasks 1→2→3→4. `hugo/data/topic_clusters.json` key `clusters` matches the partial's `$tc.clusters`. Constants `MAX_CLUSTERS=6`, `MIN_TUTORIALS=3`, `MAX_TUTORIALS_PER_CARD=4` used consistently.
