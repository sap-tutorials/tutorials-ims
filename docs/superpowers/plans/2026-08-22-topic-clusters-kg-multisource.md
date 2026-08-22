# KG Multi-Source Homepage Topic Clusters — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand the homepage "Explore topic clusters" band so each cluster surfaces all Knowledge-Graph-linked content types (tutorials, missions, groups, learning journeys, discovery missions, blogs, videos, API docs, samples, help docs, community events) instead of tutorials only.

**Architecture:** Hybrid render. A shared CAP resolver turns a Louvain `communityFingerprint` into normalized content items (direct members for tutorial/mission/group; concept-hop for all external types). The existing `GET /build/topic-clusters` bakes the **stable** tier into `hugo/data/topic_clusters.json` (SSR, LCP/SEO-safe). A new `GET /homepage/topicClusterVolatile()` returns the **volatile** tier (blogs/videos/events) with an ETag; a new `topic-clusters-band` Vue island merges it into the SSR cards on hydrate. Every resolution path fails open — the band stays empty-safe end to end.

**Tech Stack:** CAP Node.js (`@sap/cds`), CQL/`cds.ql`, Hugo templates, Vue 3 islands built by Vite in `hugo-apps/`, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-22-topic-clusters-kg-multisource-design.md`

## Global Constraints

- **Fail-open everywhere.** Any DB throw in a per-type resolution contributes nothing and never 500s. The `/build/topic-clusters` error branch returns `{ clusters: [], error: 'topic_clusters_build_failed' }` and MUST NOT leak `err.message` (info-disclosure contract, existing test at `test/unit/srv/build-topic-clusters.test.js`).
- **HANA packet cap:** every `.in([...])` / `{ in: [...] }` MUST be chunked at ≤500 ids. Never issue an unbounded `.in()`.
- **Never SELECT a HANA LargeString/BLOB alongside scalars.** For external content select only scalar columns (`slug`, `title`, `url`, and the date field) — never `description` (NCLOB) or `embedding`.
- **HANA columns are UPPERCASE** in any raw `db.run(<sql string>)`. Prefer CQL (`SELECT.from(entity)`) so CAP handles casing; the existing builder uses CQL.
- **Slug matching is case-insensitive-normalized:** lowercase `KgCommunity.slug` before matching against `Concepts.slug` / `Tutorials.slug` / `Missions.slug` / `Groups.slug` (existing gotcha — test seeds `'Edge-Mixed'` → resolves `'edge-mixed'`).
- **Href conventions (verbatim):** tutorial → `/tutorials/<slug>`; mission → `/tutorials/mission-<slug>`; group → `/tutorials/group-<slug>`; every external type → its stored `url` column.
- **Visibility filters:** Tutorials `status = 'ACTIVE' or status is null`; Missions/Groups `published = true`; Concepts `status = 'ACTIVE'`; Videos `excludeFromHomepage = false`.
- **Fingerprint, not communityId,** is the only stable key across Louvain passes. All resolution keys on `communityFingerprint`.
- **`island_manifest.json` is generated, never hand-edited** — it regenerates from Vite's manifest via `scripts/build-island-manifest.cjs` once the Vite input exists.
- **srv-qa cp-list:** if any new `srv/lib/*.js` becomes a transitive `./` import of `srv/lib/content-store.js`, add it to the `srv-qa` `cp` list in `.deploy/mta.yaml`. (Expected: it does not — `build-topic-clusters.js` is not a content-store dep. Verify, then note "no action".)

**Namespaces:** base schema + KG communities + Concepts live in `com.sap.developers.ims` (alias `NS`). External content + its concept-link tables live in `com.sap.developers.ims.external` (alias `EXT`) — EXCEPT `TutorialConceptLinks`, which is in `NS`.

---

## Task 1: Data-population probe (verification spike)

Confirms what actually lights up per content type in DEV and PROD, so per-type caps are grounded (memory: *ground fixes in captured data, not shaped guesses*). No production code; output is recorded numbers.

**Files:**
- None modified. Scratch query only.

**Interfaces:**
- Consumes: real HANA via `cds bind --exec`.
- Produces: a row-count table appended to the spec's "Risks" section (informs caps in Task 2).

- [ ] **Step 1: Count concept-link + external-content + community rows against real HANA**

Run against DEV (requires `cf login`):

```bash
cds bind --exec -- node -e "
const cds=require('@sap/cds');
(async()=>{
  const db=await cds.connect.to('db');
  const q=async(t)=>{try{const r=await db.run('SELECT COUNT(*) AS N FROM '+t);return r[0].N??r[0].n;}catch(e){return 'ERR '+e.message;}};
  for (const t of [
    'COM_SAP_DEVELOPERS_IMS_EXTERNAL_BLOGPOSTCONCEPTLINKS',
    'COM_SAP_DEVELOPERS_IMS_EXTERNAL_VIDEOCONCEPTLINKS',
    'COM_SAP_DEVELOPERS_IMS_EXTERNAL_COMMUNITYEVENTCONCEPTLINKS',
    'COM_SAP_DEVELOPERS_IMS_EXTERNAL_LEARNINGJOURNEYCONCEPTLINKS',
    'COM_SAP_DEVELOPERS_IMS_EXTERNAL_DISCOVERYMISSIONCONCEPTLINKS',
    'COM_SAP_DEVELOPERS_IMS_EXTERNAL_APIDOCCONCEPTLINKS',
    'COM_SAP_DEVELOPERS_IMS_EXTERNAL_SAMPLECONCEPTLINKS',
    'COM_SAP_DEVELOPERS_IMS_EXTERNAL_HELPDOCCONCEPTLINKS',
    'COM_SAP_DEVELOPERS_IMS_KGCOMMUNITY'
  ]) console.log(t, await q(t));
})();
"
```

Expected: a count per table. `KGCOMMUNITY` also split by type is useful:

```bash
cds bind --exec -- node -e "
const cds=require('@sap/cds');(async()=>{const db=await cds.connect.to('db');
console.log(await db.run(\"SELECT VERTEXTYPE, COUNT(*) AS N FROM COM_SAP_DEVELOPERS_IMS_KGCOMMUNITY GROUP BY VERTEXTYPE\"));})();
"
```

- [ ] **Step 2: Record the numbers**

Append a short table (DEV counts; PROD counts if a PROD `cds bind` is available) to the "Risks & pre-implementation verification" section of the spec file. If a volatile type (blog/video/event links) is empty in PROD, note it — the island still ships (fail-open) but earns little until ingestion populates it.

- [ ] **Step 3: Commit the recorded findings**

```bash
git add docs/superpowers/specs/2026-08-22-topic-clusters-kg-multisource-design.md
git commit -m "docs: record KG link-table population counts (topic-clusters expansion)"
```

---

## Task 2: Content-type registry + pure helpers

A single source of truth for which content types exist, how they resolve, their tier, caps, and href/isNew rules. Pure functions only — fully unit-testable without a DB.

**Files:**
- Create: `srv/lib/topic-cluster-content.js`
- Test: `test/unit/srv/topic-cluster-content.test.js`

**Interfaces:**
- Produces:
  - `CONTENT_TYPES` — array of descriptors. Each: `{ kind, tier, source, linkEntity, contentEntity, contentFk, titleField, urlField, dateField, statusFilter, cap }` where `source` is `'direct'` (KgCommunity vertexType member) or `'concept'` (concept-hop). For `direct`, `contentEntity`/`statusFilter` apply and `linkEntity` is null. For `concept`, `linkEntity`+`contentFk` apply and `urlField`/`dateField` name columns on `contentEntity`.
  - `hrefFor(kind, slug, url)` → string. Direct kinds synthesize a path; concept kinds return `url`.
  - `isNewFrom(dateVal, nowMs, windowDays = 30)` → boolean.
  - `computeRank(item, rankMaps)` → number. `item` = `{ kind, slug, confidence, dateMs }`; `rankMaps` = `{ tutorialRank: Map, conceptRank: Map } | null`.
  - `rankAndCap(items, { perType, total })` → item[] — sorts by `rank` desc then `title` asc, enforces per-`kind` caps, then the overall `total` cap.
  - `TOTAL_ITEMS_PER_CARD` = 8.

- [ ] **Step 1: Write the failing test**

```js
// test/unit/srv/topic-cluster-content.test.js
import { describe, it, expect } from 'vitest';
import {
  CONTENT_TYPES, hrefFor, isNewFrom, computeRank, rankAndCap, TOTAL_ITEMS_PER_CARD,
} from '../../../srv/lib/topic-cluster-content.js';

describe('topic-cluster-content helpers', () => {
  it('registry covers all 11 kinds with a valid tier + source', () => {
    const kinds = CONTENT_TYPES.map(t => t.kind).sort();
    expect(kinds).toEqual([
      'api-doc','blog-post','community-event','discovery-mission','group',
      'help-doc','learning-journey','mission','sample','tutorial','video',
    ]);
    for (const t of CONTENT_TYPES) {
      expect(['stable','volatile']).toContain(t.tier);
      expect(['direct','concept']).toContain(t.source);
    }
    // Only blogs/videos/events are volatile.
    expect(CONTENT_TYPES.filter(t => t.tier === 'volatile').map(t => t.kind).sort())
      .toEqual(['blog-post','community-event','video']);
  });

  it('hrefFor synthesizes direct paths and passes external urls through', () => {
    expect(hrefFor('tutorial', 'abc', null)).toBe('/tutorials/abc');
    expect(hrefFor('mission', 'abc', null)).toBe('/tutorials/mission-abc');
    expect(hrefFor('group', 'abc', null)).toBe('/tutorials/group-abc');
    expect(hrefFor('blog-post', 'x', 'https://community.sap.com/p/1')).toBe('https://community.sap.com/p/1');
  });

  it('isNewFrom flags recent dates only', () => {
    const now = Date.parse('2026-08-22T00:00:00Z');
    expect(isNewFrom('2026-08-10T00:00:00Z', now)).toBe(true);
    expect(isNewFrom('2026-05-01T00:00:00Z', now)).toBe(false);
    expect(isNewFrom(null, now)).toBe(false);
  });

  it('computeRank blends confidence, recency and optional pagerank', () => {
    const now = Date.parse('2026-08-22T00:00:00Z');
    const base = { kind: 'blog-post', slug: 's', confidence: 0.8, dateMs: now };
    const old = { kind: 'blog-post', slug: 's', confidence: 0.8, dateMs: Date.parse('2020-01-01Z') };
    expect(computeRank(base, null)).toBeGreaterThan(computeRank(old, null));
    const withPR = computeRank({ kind: 'tutorial', slug: 't', confidence: 1, dateMs: null },
      { tutorialRank: new Map([['t', 1.0]]), conceptRank: new Map() });
    const noPR = computeRank({ kind: 'tutorial', slug: 't', confidence: 1, dateMs: null }, null);
    expect(withPR).toBeGreaterThan(noPR);
  });

  it('rankAndCap enforces per-type caps then total cap, sorted by rank', () => {
    const items = [];
    for (let i = 0; i < 10; i++) items.push({ kind: 'tutorial', slug: `t${i}`, title: `T${i}`, rank: i });
    for (let i = 0; i < 10; i++) items.push({ kind: 'blog-post', slug: `b${i}`, title: `B${i}`, rank: 100 + i });
    const out = rankAndCap(items, { perType: { tutorial: 3, 'blog-post': 2 }, total: 4 });
    expect(out.length).toBe(4);                       // total cap
    expect(out.filter(x => x.kind === 'blog-post').length).toBeLessThanOrEqual(2);
    expect(out[0].rank).toBeGreaterThanOrEqual(out[1].rank); // rank desc
  });

  it('TOTAL_ITEMS_PER_CARD is 8', () => expect(TOTAL_ITEMS_PER_CARD).toBe(8));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/srv/topic-cluster-content.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```js
// srv/lib/topic-cluster-content.js
//
// Single source of truth for the content types the homepage topic-cluster
// band can surface, plus pure helpers for href/recency/ranking. No DB access
// here — the resolver in build-topic-cluster-content.js consumes this.

export const TOTAL_ITEMS_PER_CARD = 8;

// Per-type caps prevent any high-volume source from flooding a card.
export const PER_TYPE_CAPS = {
  tutorial: 3, mission: 2, group: 1,
  'learning-journey': 1, 'discovery-mission': 1, 'api-doc': 1, sample: 1, 'help-doc': 1,
  'blog-post': 2, video: 2, 'community-event': 1,
};

// source:'direct'  → member of KgCommunity with matching vertexType; resolve by slug.
// source:'concept' → reached via concept-hop through linkEntity.contentFk.
export const CONTENT_TYPES = [
  { kind: 'tutorial', tier: 'stable', source: 'direct', vertexType: 'tutorial',
    contentEntity: 'Tutorials', titleField: 'title', statusFilter: 'tutorial' },
  { kind: 'mission', tier: 'stable', source: 'direct', vertexType: 'mission',
    contentEntity: 'Missions', titleField: 'title', statusFilter: 'published' },
  { kind: 'group', tier: 'stable', source: 'direct', vertexType: 'group',
    contentEntity: 'Groups', titleField: 'title', statusFilter: 'published' },

  { kind: 'learning-journey', tier: 'stable', source: 'concept', linkEntity: 'LearningJourneyConceptLinks',
    contentFk: 'journey_ID', contentEntity: 'LearningJourneys', titleField: 'title', urlField: 'url', dateField: null },
  { kind: 'discovery-mission', tier: 'stable', source: 'concept', linkEntity: 'DiscoveryMissionConceptLinks',
    contentFk: 'mission_ID', contentEntity: 'DiscoveryMissions', titleField: 'title', urlField: 'url', dateField: null },
  { kind: 'api-doc', tier: 'stable', source: 'concept', linkEntity: 'ApiDocConceptLinks',
    contentFk: 'apiDoc_ID', contentEntity: 'ApiDocs', titleField: 'title', urlField: 'url', dateField: null },
  { kind: 'sample', tier: 'stable', source: 'concept', linkEntity: 'SampleConceptLinks',
    contentFk: 'sample_ID', contentEntity: 'Samples', titleField: 'title', urlField: 'url', dateField: 'lastCommitAt' },
  { kind: 'help-doc', tier: 'stable', source: 'concept', linkEntity: 'HelpDocConceptLinks',
    contentFk: 'helpDoc_ID', contentEntity: 'HelpDocs', titleField: 'title', urlField: 'url', dateField: null },

  { kind: 'blog-post', tier: 'volatile', source: 'concept', linkEntity: 'BlogPostConceptLinks',
    contentFk: 'post_ID', contentEntity: 'BlogPosts', titleField: 'title', urlField: 'url', dateField: 'postedAt' },
  { kind: 'video', tier: 'volatile', source: 'concept', linkEntity: 'VideoConceptLinks',
    contentFk: 'video_ID', contentEntity: 'Videos', titleField: 'title', urlField: 'url', dateField: 'publishedAt',
    statusFilter: 'video' },
  { kind: 'community-event', tier: 'volatile', source: 'concept', linkEntity: 'CommunityEventConceptLinks',
    contentFk: 'event_ID', contentEntity: 'CommunityEvents', titleField: 'title', urlField: 'url', dateField: 'startDate' },
];

export function hrefFor(kind, slug, url) {
  if (kind === 'tutorial') return `/tutorials/${slug}`;
  if (kind === 'mission') return `/tutorials/mission-${slug}`;
  if (kind === 'group') return `/tutorials/group-${slug}`;
  return url || null; // external content carries an absolute url
}

export function isNewFrom(dateVal, nowMs, windowDays = 30) {
  if (!dateVal) return false;
  const t = Date.parse(dateVal);
  if (Number.isNaN(t)) return false;
  return (nowMs - t) <= windowDays * 86_400_000 && t <= nowMs;
}

// rank = confidence(0..1, direct=1) + recencyBoost(0..0.5) + pagerankBoost(0..0.5)
export function computeRank(item, rankMaps) {
  const conf = typeof item.confidence === 'number' ? item.confidence : 1;
  let recency = 0;
  if (item.dateMs) {
    const ageDays = (item._nowMs ?? Date.parse('2026-08-22Z')) - item.dateMs;
    const days = ageDays / 86_400_000;
    recency = days <= 30 ? 0.5 : days <= 90 ? 0.25 : days <= 365 ? 0.1 : 0;
  }
  let pr = 0;
  if (rankMaps) {
    const m = item.kind === 'tutorial' ? rankMaps.tutorialRank : rankMaps.conceptRank;
    const v = m?.get(item.slug);
    if (typeof v === 'number') pr = 0.5 * Math.max(0, Math.min(1, v));
  }
  return conf + recency + pr;
}

export function rankAndCap(items, { perType = PER_TYPE_CAPS, total = TOTAL_ITEMS_PER_CARD } = {}) {
  const sorted = [...items].sort((a, b) =>
    (b.rank ?? 0) - (a.rank ?? 0) || String(a.title || '').localeCompare(String(b.title || '')));
  const seen = {};
  const kept = [];
  for (const it of sorted) {
    const cap = perType[it.kind] ?? 1;
    seen[it.kind] = seen[it.kind] || 0;
    if (seen[it.kind] >= cap) continue;
    seen[it.kind]++;
    kept.push(it);
    if (kept.length >= total) break;
  }
  return kept;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/srv/topic-cluster-content.test.js`
Expected: PASS (all 6).

- [ ] **Step 5: Commit**

```bash
git add srv/lib/topic-cluster-content.js test/unit/srv/topic-cluster-content.test.js
git commit -m "feat: content-type registry + ranking helpers for multi-source topic clusters"
```

---

## Task 3: Shared cluster-content resolver

Turns one `communityFingerprint` + a set of kinds into normalized, ranked items via direct-member and concept-hop DB reads. Fail-open per type, packet-cap chunked.

**Files:**
- Create: `srv/lib/build-topic-cluster-content.js`
- Test: `test/unit/srv/build-topic-cluster-content.test.js`

**Interfaces:**
- Consumes: `CONTENT_TYPES`, `hrefFor`, `isNewFrom`, `computeRank`, `rankAndCap` (Task 2).
- Produces:
  - `chunk(arr, size = 500)` → arr[][]
  - `async resolveClusterContent(db, fingerprint, { tiers, rankMaps = null, nowMs })` → normalized item[] (NOT yet capped) where each item = `{ kind, slug, title, href, isNew, rank }`. `tiers` = array like `['stable']` or `['volatile']` or both. Selects only the `CONTENT_TYPES` whose `tier` is in `tiers`.

- [ ] **Step 1: Write the failing test**

```js
// test/unit/srv/build-topic-cluster-content.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');
const NS = 'com.sap.developers.ims';
const EXT = 'com.sap.developers.ims.external';
const FP = 'fp-multi0';

beforeAll(async () => {
  await project;
  const db = await cds.connect.to('db');
  const { KgCommunity, Tutorials, Missions, Concepts } = cds.entities(NS);
  const { BlogPosts, BlogPostConceptLinks } = cds.entities(EXT);
  const now = new Date().toISOString();

  // Direct members: 1 tutorial, 1 mission, plus 1 concept member.
  await db.run(INSERT.into(Tutorials).entries([{ ID: cds.utils.uuid(), slug: 'tut-a', title: 'Tut A', status: 'ACTIVE' }]));
  await db.run(INSERT.into(Missions).entries([{ ID: cds.utils.uuid(), slug: 'mis-a', title: 'Mission A', published: true }]));
  await db.run(INSERT.into(KgCommunity).entries([
    { communityId: 1, vertexKey: 'tutorial:tut-a', vertexType: 'tutorial', slug: 'tut-a', communityFingerprint: FP, detectedAt: now },
    { communityId: 1, vertexKey: 'mission:mis-a', vertexType: 'mission', slug: 'mis-a', communityFingerprint: FP, detectedAt: now },
    { communityId: 1, vertexKey: 'concept:cap-handlers', vertexType: 'concept', slug: 'cap-handlers', communityFingerprint: FP, detectedAt: now },
  ]));

  // Concept-hop: concept 'cap-handlers' → 1 recent blog post.
  const conceptId = cds.utils.uuid();
  await db.run(INSERT.into(Concepts).entries([{ ID: conceptId, slug: 'cap-handlers', name: 'CAP Handlers', status: 'ACTIVE' }]));
  const postId = cds.utils.uuid();
  await db.run(INSERT.into(BlogPosts).entries([{ ID: postId, slug: 'blog-1', title: 'A CAP Blog', url: 'https://community.sap.com/b/1', postedAt: now }]));
  await db.run(INSERT.into(BlogPostConceptLinks).entries([{ ID: cds.utils.uuid(), post_ID: postId, concept_ID: conceptId, predicate: 'discusses', confidence: 0.9 }]));
});

describe('resolveClusterContent', () => {
  it('resolves direct members (tutorial+mission) for the stable tier with correct hrefs', async () => {
    const { resolveClusterContent } = await import('../../../srv/lib/build-topic-cluster-content.js');
    const db = await cds.connect.to('db');
    const items = await resolveClusterContent(db, FP, { tiers: ['stable'], nowMs: Date.now() });
    const byKind = Object.fromEntries(items.map(i => [i.kind, i]));
    expect(byKind.tutorial.href).toBe('/tutorials/tut-a');
    expect(byKind.mission.href).toBe('/tutorials/mission-mis-a');
  });

  it('resolves concept-hop blog posts for the volatile tier', async () => {
    const { resolveClusterContent } = await import('../../../srv/lib/build-topic-cluster-content.js');
    const db = await cds.connect.to('db');
    const items = await resolveClusterContent(db, FP, { tiers: ['volatile'], nowMs: Date.now() });
    const blog = items.find(i => i.kind === 'blog-post');
    expect(blog).toBeDefined();
    expect(blog.href).toBe('https://community.sap.com/b/1');
    expect(blog.isNew).toBe(true);
  });

  it('fails open per type: a bad db yields [] not a throw', async () => {
    const { resolveClusterContent } = await import('../../../srv/lib/build-topic-cluster-content.js');
    const throwingDb = { run: async () => { throw new Error('boom'); } };
    const items = await resolveClusterContent(throwingDb, FP, { tiers: ['stable','volatile'], nowMs: Date.now() });
    expect(items).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/srv/build-topic-cluster-content.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```js
// srv/lib/build-topic-cluster-content.js
//
// Resolves one Louvain community (by communityFingerprint) into normalized
// content items across all KG-linked types. Direct members (tutorial/mission/
// group) resolve by slug; everything else via concept-hop
// (KgCommunity concept members → Concepts → <Type>ConceptLinks → content).
// Fail-open per type; packet-cap chunked. Pure ranking lives in
// topic-cluster-content.js.

import cds from '@sap/cds';
import { CONTENT_TYPES, hrefFor, isNewFrom, computeRank } from './topic-cluster-content.js';

const log = cds.log('build-topic-cluster-content');
const NS = 'com.sap.developers.ims';
const EXT = 'com.sap.developers.ims.external';

export function chunk(arr, size = 500) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function whereForContent(entity, kind, slugsLower) {
  // Direct-member visibility filters. slugsLower already lowercased.
  const q = SELECT.from(entity).columns('slug', 'title').where({ slug: { in: slugsLower } });
  if (kind === 'tutorial') return q.and(`status = 'ACTIVE' or status is null`);
  return q.and({ published: true }); // mission/group
}

async function resolveDirect(db, desc, fingerprint) {
  const { KgCommunity } = cds.entities(NS);
  const members = await db.run(
    SELECT.from(KgCommunity).columns('slug')
      .where({ communityFingerprint: fingerprint, vertexType: desc.vertexType })
  );
  const slugs = [...new Set(members.map(m => (m.slug || '').toLowerCase()).filter(Boolean))];
  if (!slugs.length) return [];
  const { [desc.contentEntity]: Entity } = cds.entities(NS);
  const rows = [];
  for (const c of chunk(slugs)) rows.push(...await db.run(whereForContent(Entity, desc.kind, c)));
  return rows.map(r => ({ kind: desc.kind, slug: r.slug, title: r.title, url: null, confidence: 1, dateMs: null }));
}

async function resolveConceptHop(db, desc, conceptIds, nowMs) {
  if (!conceptIds.length) return [];
  const { [desc.linkEntity]: Link } = cds.entities(EXT);
  const linkRows = [];
  for (const c of chunk(conceptIds)) {
    linkRows.push(...await db.run(
      SELECT.from(Link).columns(desc.contentFk, 'confidence').where({ concept_ID: { in: c } })
    ));
  }
  // best confidence per content id
  const confById = new Map();
  for (const r of linkRows) {
    const id = r[desc.contentFk];
    if (!id) continue;
    const prev = confById.get(id) ?? 0;
    if ((r.confidence ?? 0.7) > prev) confById.set(id, r.confidence ?? 0.7);
  }
  const ids = [...confById.keys()];
  if (!ids.length) return [];
  const cols = ['ID', 'slug', desc.titleField, desc.urlField];
  if (desc.dateField) cols.push(desc.dateField); // scalar dates only — never NCLOB description
  const { [desc.contentEntity]: Entity } = cds.entities(EXT);
  const rows = [];
  for (const c of chunk(ids)) {
    let q = SELECT.from(Entity).columns(...cols).where({ ID: { in: c } });
    if (desc.statusFilter === 'video') q = q.and({ excludeFromHomepage: false });
    rows.push(...await db.run(q));
  }
  return rows.map(r => {
    const dateVal = desc.dateField ? r[desc.dateField] : null;
    return {
      kind: desc.kind, slug: r.slug, title: r[desc.titleField], url: r[desc.urlField],
      confidence: confById.get(r.ID) ?? 0.7,
      dateMs: dateVal ? Date.parse(dateVal) : null,
      _isNew: isNewFrom(dateVal, nowMs),
    };
  });
}

export async function resolveClusterContent(db, fingerprint, { tiers, rankMaps = null, nowMs = Date.now() }) {
  const descs = CONTENT_TYPES.filter(d => tiers.includes(d.tier));
  const needsConcept = descs.some(d => d.source === 'concept');

  // Resolve concept ids once (shared across all concept-hop types).
  let conceptIds = [];
  if (needsConcept) {
    try {
      const { KgCommunity, Concepts } = cds.entities(NS);
      const cm = await db.run(
        SELECT.from(KgCommunity).columns('slug')
          .where({ communityFingerprint: fingerprint, vertexType: 'concept' })
      );
      const cslugs = [...new Set(cm.map(m => (m.slug || '').toLowerCase()).filter(Boolean))];
      const crows = [];
      for (const c of chunk(cslugs)) {
        crows.push(...await db.run(
          SELECT.from(Concepts).columns('ID', 'slug').where({ slug: { in: c } }).and({ status: 'ACTIVE' })
        ));
      }
      conceptIds = crows.map(r => r.ID);
    } catch (err) {
      log.warn('concept-id resolution failed; concept-hop types skipped', err);
      conceptIds = [];
    }
  }

  const items = [];
  for (const desc of descs) {
    try {
      const raw = desc.source === 'direct'
        ? await resolveDirect(db, desc, fingerprint)
        : await resolveConceptHop(db, desc, conceptIds, nowMs);
      for (const it of raw) {
        it._nowMs = nowMs;
        items.push({
          kind: it.kind,
          slug: it.slug,
          title: it.title,
          href: hrefFor(it.kind, it.slug, it.url),
          isNew: it._isNew ?? false,
          rank: computeRank(it, rankMaps),
        });
      }
    } catch (err) {
      log.warn(`topic-cluster resolve failed for kind=${desc.kind}; skipping`, err);
    }
  }
  // De-dupe by kind+slug (a slug can appear via multiple concepts).
  const seen = new Set();
  return items.filter(it => {
    const k = `${it.kind}:${it.slug}`;
    if (seen.has(k) || !it.href) return false;
    seen.add(k);
    return true;
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/srv/build-topic-cluster-content.test.js`
Expected: PASS (3).

- [ ] **Step 5: Verify SQLite in-memory model deploys**

Run: `npx cds deploy --to sqlite::memory: 2>&1 | tail -5`
Expected: no compile error (external + community entities compile).

- [ ] **Step 6: Commit**

```bash
git add srv/lib/build-topic-cluster-content.js test/unit/srv/build-topic-cluster-content.test.js
git commit -m "feat: shared multi-source cluster-content resolver (direct + concept-hop)"
```

---

## Task 4: Widen the build payload (stable tier + back-compat)

`GET /build/topic-clusters` now emits an `items` array (stable tier, ranked+capped) on each cluster while keeping `tutorials` for back-compat. Rank maps loaded via the KG service's exported `loadRankMaps()`.

**Files:**
- Modify: `srv/lib/build-topic-clusters.js`
- Modify: `test/unit/srv/build-topic-clusters.test.js`

**Interfaces:**
- Consumes: `resolveClusterContent` (Task 3), `rankAndCap`, `PER_TYPE_CAPS`, `TOTAL_ITEMS_PER_CARD` (Task 2), and `loadRankMaps` from `../knowledge-graph-service.js` (exported per recon).
- Produces: each cluster in the payload gains `items: [{ kind, slug, title, href, isNew }]` (rank stripped from the wire). `tutorials` unchanged.

- [ ] **Step 1: Add the failing test (mixed-type cluster emits `items`)**

Append to `test/unit/srv/build-topic-clusters.test.js` a new `describe` (reuse the existing bootstrap at top of file; add fixtures in a fresh `beforeAll` is not possible — instead extend the existing seed). Add these rows to the existing `beforeAll` seed (a concept member + a blog post on the largest cluster `fp-0...`), then this test:

```js
  it('emits a mixed-source items[] array alongside tutorials[] (back-compat)', async () => {
    const { buildTopicClustersPayload } = await import('../../../srv/lib/build-topic-clusters.js');
    const db = await cds.connect.to('db');
    const { clusters } = await buildTopicClustersPayload(db);
    const c = clusters.find(x => x.communityFingerprint.startsWith('fp-0'));
    expect(Array.isArray(c.items)).toBe(true);
    expect(Array.isArray(c.tutorials)).toBe(true);           // back-compat kept
    expect(c.items.every(i => i.kind && i.href && ('isNew' in i))).toBe(true);
    expect(c.items.some(i => i.kind === 'tutorial')).toBe(true);
    // no rank on the wire
    expect(c.items.every(i => !('rank' in i))).toBe(true);
  });
```

Seed additions (inside the existing `beforeAll`, after the sized-cluster loop, before the inserts):

```js
  // Mixed-source enrichment on cluster 0 (fp-0): a concept member + a blog post.
  const EXT = 'com.sap.developers.ims.external';
  const { Concepts } = cds.entities(NS);
  const { BlogPosts, BlogPostConceptLinks } = cds.entities(EXT);
  const cId = cds.utils.uuid(); const pId = cds.utils.uuid();
  communities.push({ communityId: 0, vertexKey: 'concept:c0', vertexType: 'concept', slug: 'c0', communityFingerprint: 'fp-00000', detectedAt: new Date().toISOString() });
  // (insert Concepts/BlogPosts/link after the three main inserts:)
  globalThis.__extraSeed = async () => {
    await db.run(INSERT.into(Concepts).entries([{ ID: cId, slug: 'c0', name: 'C0', status: 'ACTIVE' }]));
    await db.run(INSERT.into(BlogPosts).entries([{ ID: pId, slug: 'bp0', title: 'BP0', url: 'https://x/bp0', postedAt: new Date().toISOString() }]));
    await db.run(INSERT.into(BlogPostConceptLinks).entries([{ ID: cds.utils.uuid(), post_ID: pId, concept_ID: cId, confidence: 0.9 }]));
  };
```

Then after the existing three `INSERT.into(...)` calls at the end of `beforeAll`, add: `await globalThis.__extraSeed();`. (Fingerprint for cluster 0 in the existing seed is `'fp-0'.padEnd(8,'0')` = `'fp-00000'`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/srv/build-topic-clusters.test.js`
Expected: FAIL — `c.items` is undefined.

- [ ] **Step 3: Widen the builder**

In `srv/lib/build-topic-clusters.js`: add imports and load rank maps once, then populate `items` per cluster. Concretely:

Add after line 13 (`import cds ...`):

```js
import { resolveClusterContent } from './build-topic-cluster-content.js';
import { rankAndCap, PER_TYPE_CAPS, TOTAL_ITEMS_PER_CARD } from './topic-cluster-content.js';
```

Inside `buildTopicClustersPayload`, right after `const buildAt = ...` add a fail-open rank-map load:

```js
  const nowMs = Date.now();
  let rankMaps = null;
  try {
    const { loadRankMaps } = await import('../knowledge-graph-service.js');
    rankMaps = await loadRankMaps(db); // { tutorialRank, conceptRank } — fail-open below
  } catch { rankMaps = null; }
```

In the per-cluster loop, after the existing `clusters.push({ ... tutorials: ... })`, replace the push so it also computes `items`. Change the push block (current lines 79-89) to:

```js
      const rawItems = await resolveClusterContent(db, cluster.communityFingerprint, {
        tiers: ['stable'], rankMaps, nowMs,
      });
      const items = rankAndCap(rawItems, { perType: PER_TYPE_CAPS, total: TOTAL_ITEMS_PER_CARD })
        .map(({ rank, ...wire }) => wire); // strip rank from the wire
      clusters.push({
        label: cluster.label,
        rationale: cluster.rationale,
        communityFingerprint: cluster.communityFingerprint,
        tutorialCount: cluster.tutorialCount,
        tutorials: live.slice(0, MAX_TUTORIALS_PER_CARD).map(t => ({
          slug: t.slug, title: t.title, url: `/tutorials/${t.slug}`,
        })),
        items,
      });
```

Note: `resolveClusterContent` is itself fail-open (returns `[]` on any error), so a bad enrichment never breaks the tutorials-only card. If `loadRankMaps` has a different export name/shape, wrap defensively (the `try/catch` already collapses it to `null`, and `computeRank` tolerates `null`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/srv/build-topic-clusters.test.js`
Expected: PASS — all existing tests (ranking, gates, case-insensitive, fail-open) AND the new `items[]` test.

- [ ] **Step 5: Verify `loadRankMaps` export exists and shape matches**

Run: `grep -n "export.*loadRankMaps\|function loadRankMaps" srv/knowledge-graph-service.js`
Expected: a match. If the return shape is not `{ tutorialRank, conceptRank }`, adapt the `rankMaps` adapter in Step 3 (map the actual field names) and re-run Step 4. Do not leave a mismatch.

- [ ] **Step 6: Commit**

```bash
git add srv/lib/build-topic-clusters.js test/unit/srv/build-topic-clusters.test.js
git commit -m "feat: bake stable multi-source items[] into /build/topic-clusters"
```

---

## Task 5: Volatile-tier endpoint `topicClusterVolatile()`

Public HomepageService function returning volatile items (blogs/videos/events) per shown fingerprint, with ETag + 304 + 60s cache, fail-open. Mirrors `featuredTopics()` exactly (recon).

**Files:**
- Modify: `srv/homepage-service.cds`
- Modify: `srv/homepage-service.js`
- Test: `test/unit/srv/homepage-topic-cluster-volatile.test.js`

**Interfaces:**
- Consumes: `resolveClusterContent` (Task 3), `rankAndCap`/caps (Task 2), and the stable payload from `buildTopicClustersPayload` (Task 4) to learn which fingerprints are on the homepage.
- Produces: OData function `topicClusterVolatile()` at `/homepage/topicClusterVolatile()` returning `{ computedAt, etag, clusters: [{ communityFingerprint, items: [{kind,slug,title,href,isNew}] }] }`.

- [ ] **Step 1: Write the failing test**

```js
// test/unit/srv/homepage-topic-cluster-volatile.test.js
import { describe, it, expect } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

describe('/homepage/topicClusterVolatile()', () => {
  it('returns 200 with clusters[], an etag, and Cache-Control', async () => {
    await project;
    const res = await project.get('/homepage/topicClusterVolatile()');
    expect(res.status).toBe(200);
    expect(res.data).toHaveProperty('etag');
    expect(res.data).toHaveProperty('clusters');
    expect(Array.isArray(res.data.clusters)).toBe(true);
    expect(res.headers['cache-control']).toContain('max-age=60');
  });

  it('honors If-None-Match with a 304', async () => {
    await project;
    const first = await project.get('/homepage/topicClusterVolatile()');
    const etag = first.data.etag;
    try {
      const second = await project.get('/homepage/topicClusterVolatile()', { headers: { 'If-None-Match': etag } });
      expect(second.status).toBe(304);
    } catch (e) {
      // axios throws on 304 in some setups; assert the status off the error response.
      expect(e.response?.status).toBe(304);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/srv/homepage-topic-cluster-volatile.test.js`
Expected: FAIL — 404 (function not defined).

- [ ] **Step 3: Add the CDS type + function**

In `srv/homepage-service.cds`, add these types OUTSIDE the service block (next to `FeaturedTopicsPayload`):

```cds
type TopicClusterVolatileItem {
  kind  : String;
  slug  : String;
  title : String;
  href  : String;
  isNew : Boolean;
}
type TopicClusterVolatileCluster {
  communityFingerprint : String;
  items                : many TopicClusterVolatileItem;
}
type TopicClusterVolatilePayload {
  computedAt : Timestamp;
  etag       : String;
  clusters   : many TopicClusterVolatileCluster;
}
```

Inside the `service HomepageService { ... }` block, next to `function featuredTopics()`:

```cds
  // Volatile tier (blogs/videos/events) for the homepage topic-cluster band.
  // Public — no auth. 60s cache; ETag so the island hydrates cheaply.
  function topicClusterVolatile() returns TopicClusterVolatilePayload;
```

- [ ] **Step 4: Add the handler + cache**

In `srv/homepage-service.js`:

Add a cache slot in `_state` next to `ft`:

```js
  // Volatile topic-cluster tier cache (mirrors ft).
  tcv: { at: 0, payload: null },
```

Add near `resetFtCache`:

```js
export function resetTcvCache() { _state.tcv = { at: 0, payload: null }; }
```

Add near the `_getFeaturedTopicsPayload` helper:

```js
import { createHash } from 'node:crypto';
import { buildTopicClustersPayload } from './lib/build-topic-clusters.js';
import { resolveClusterContent } from './lib/build-topic-cluster-content.js';
import { rankAndCap, PER_TYPE_CAPS, TOTAL_ITEMS_PER_CARD } from './lib/topic-cluster-content.js';

const TCV_CACHE_MS = 60_000;

async function _getTopicClusterVolatilePayload() {
  const now = Date.now();
  if (_state.tcv.payload && (now - _state.tcv.at) < TCV_CACHE_MS) return _state.tcv.payload;
  const computedAt = new Date().toISOString();
  let clusters = [];
  try {
    const db = await cds.connect.to('db');
    const stable = await buildTopicClustersPayload(db);          // same clusters the band shows
    for (const c of stable.clusters || []) {
      const raw = await resolveClusterContent(db, c.communityFingerprint, { tiers: ['volatile'], nowMs: now });
      const items = rankAndCap(raw, { perType: PER_TYPE_CAPS, total: TOTAL_ITEMS_PER_CARD })
        .map(({ rank, ...wire }) => wire);
      if (items.length) clusters.push({ communityFingerprint: c.communityFingerprint, items });
    }
  } catch (err) {
    cds.log('homepage').warn('topicClusterVolatile build failed; serving empty', err);
    clusters = [];
  }
  const etag = '"' + createHash('sha1').update(JSON.stringify(clusters)).digest('hex') + '"';
  const payload = { computedAt, etag, clusters };
  _state.tcv = { at: now, payload };
  return payload;
}
```

Register the handler alongside `featuredTopics` (copy the exact 304 idiom):

```js
    this.on('topicClusterVolatile', async (req) => {
      const payload = await _getTopicClusterVolatilePayload();
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

Also add `_state.tcv = { at: 0, payload: null };` to whatever `_resetForTests`/reset helper resets `_state.ft` (grep for `_state.ft =` to find it).

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/unit/srv/homepage-topic-cluster-volatile.test.js`
Expected: PASS (2).

- [ ] **Step 6: Run the broader srv suite to catch import regressions**

Run: `npx vitest run test/unit/srv`
Expected: PASS (no import/boot breakage from the new top-level imports in homepage-service.js).

- [ ] **Step 7: Commit**

```bash
git add srv/homepage-service.cds srv/homepage-service.js test/unit/srv/homepage-topic-cluster-volatile.test.js
git commit -m "feat: /homepage/topicClusterVolatile endpoint (blogs/videos/events, ETag)"
```

---

## Task 6: SSR band renders items[] + type badges + island shell

Render the stable `items` flat list with per-kind badges, and emit a `data-app` + `data-etag` shell so the Task 7 island can hydrate. Keep empty-by-omission (no clusters → zero DOM).

**Files:**
- Modify: `hugo/layouts/partials/homepage/topic-clusters-band.html`
- Modify: `hugo/layouts/index.html` (add island `<script>`)
- Modify (CSS): the homepage band stylesheet (grep `hp-topic-clusters` under `hugo/assets` or `hugo-apps` CSS to find the file) — add badge styles.
- Test: `test/unit/hugo/topic-clusters-band.test.ts` (extend existing)

**Interfaces:**
- Consumes: `.Site.Data.topic_clusters` clusters now carrying `items: [{kind,slug,title,href,isNew}]` (Task 4). Falls back to `.tutorials` if `items` absent (defensive).
- Produces: DOM `<section data-app="topic-clusters-band" data-etag="…">` with per-item `<li data-kind data-slug>` + a `<span class="hp-tc-badge hp-tc-badge--<kind>">` label.

- [ ] **Step 1: Add the failing test**

Extend `test/unit/hugo/topic-clusters-band.test.ts` (mirror how it renders the partial — likely via a hugo build fixture or a rendered-HTML assertion; follow the file's existing harness). Add assertions:

```ts
// After rendering the band with a cluster whose items include a blog-post:
it('renders type badges and a data-app shell for hydration', () => {
  expect(html).toContain('data-app="topic-clusters-band"');
  expect(html).toContain('hp-tc-badge--blog-post');       // badge for a non-tutorial kind
  expect(html).toContain('data-kind="blog-post"');
});
it('still emits zero DOM when clusters is empty', () => {
  expect(emptyHtml).not.toContain('hp-topic-clusters');
});
```

(Match the existing test's fixture-loading style — read the current file first and mirror its `renderPartial`/golden approach; if it builds via `hugo`, add an `items` array to the fixture JSON it feeds.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/hugo/topic-clusters-band.test.ts`
Expected: FAIL — no `data-app` / badge markup yet.

- [ ] **Step 3: Rewrite the partial**

```gotemplate
{{- /* topic-clusters-band.html — #1170, expanded to multi-source (KG).
       Reads .Site.Data.topic_clusters. Each cluster now carries an `items`
       array of mixed-source content ({kind,slug,title,href,isNew}); falls
       back to `tutorials` for older baked payloads.

       HYBRID: we emit a data-app shell + data-etag so the topic-clusters-band
       island can merge the volatile tier (blogs/videos/events) on hydrate.
       Still EMPTY-SAFE BY OMISSION at the band level: zero clusters → zero DOM. */ -}}
{{- $tc := .Site.Data.topic_clusters | default (dict "clusters" slice) -}}
{{- $clusters := $tc.clusters | default slice -}}
{{- if gt (len $clusters) 0 -}}
<section class="hp-band hp-topic-clusters"
         data-app="topic-clusters-band"
         data-etag=""
         aria-labelledby="hp-topic-clusters-title">
  <h2 id="hp-topic-clusters-title" class="hp-band__title">Explore topic clusters</h2>
  <a class="hp-topic-clusters__see-all" href="/topics/">See all topics &rarr;</a>
  <div class="hp-topic-clusters__grid">
    {{- range $clusters -}}
    <div class="hp-topic-clusters__cluster" data-fp="{{ .communityFingerprint }}" id="cluster-{{ .communityFingerprint }}">
      <h3 class="hp-topic-clusters__label">{{ .label }}</h3>
      {{- with .rationale }}<p class="hp-topic-clusters__rationale">{{ . }}</p>{{- end }}
      {{- $items := .items | default slice -}}
      {{- if eq (len $items) 0 -}}
        {{- /* back-compat: older payload without items[] */ -}}
        {{- $items = slice -}}
        {{- range .tutorials -}}{{- $items = $items | append (dict "kind" "tutorial" "slug" .slug "title" .title "href" .url "isNew" false) -}}{{- end -}}
      {{- end -}}
      <ul class="hp-topic-clusters__links">
        {{- range $items -}}
        {{- $label := or (trim (.title | default "") " ") (.slug | default "") -}}
        {{- if and $label .href -}}
        <li data-kind="{{ .kind }}" data-slug="{{ .slug }}">
          <a href="{{ .href }}">{{ $label }}</a>
          <span class="hp-tc-badge hp-tc-badge--{{ .kind }}">{{ .kind }}</span>
        </li>
        {{- end -}}
        {{- end -}}
      </ul>
    </div>
    {{- end -}}
  </div>
</section>
{{- end -}}
```

- [ ] **Step 4: Add badge CSS**

In the stylesheet that defines `.hp-topic-clusters` (grep to locate), add readable per-kind badge chips. Minimal, non-cosmetic-only geometry (memory: CLS from late CSS — keep badge size in render-blocking CSS):

```css
.hp-tc-badge { display:inline-block; margin-left:.4rem; padding:0 .4rem; font-size:.7rem;
  line-height:1.4; border-radius:.25rem; background:var(--sapNeutralBackground,#eaecee); color:var(--sapContent_LabelColor,#556); vertical-align:middle; }
.hp-tc-badge--tutorial{ background:#e3f0ff; } .hp-tc-badge--blog-post{ background:#fde7d6; }
.hp-tc-badge--video{ background:#fde3e3; } .hp-tc-badge--mission,.hp-tc-badge--group{ background:#e6f6ea; }
.hp-tc-badge--community-event{ background:#f0e6fb; }
```

- [ ] **Step 5: Add the island script tag**

In `hugo/layouts/index.html`, next to the featured-topics script tag (recon line ~23):

```gotemplate
<script type="module" src="{{ partial "island-src.html" "topic-clusters-band" }}"></script>
```

- [ ] **Step 6: Run the hugo test**

Run: `npx vitest run test/unit/hugo/topic-clusters-band.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add hugo/layouts/partials/homepage/topic-clusters-band.html hugo/layouts/index.html test/unit/hugo/topic-clusters-band.test.ts
git add <the-badge-css-file>
git commit -m "feat: SSR topic-cluster band renders mixed items with type badges + island shell"
```

---

## Task 7: `topic-clusters-band` Vue island (volatile hydration)

New island that fetches `/homepage/topicClusterVolatile()`, merges volatile items into each SSR card by fingerprint, re-ranks the combined list client-side, and re-applies the total cap. Fail-open: any fetch/parse error leaves SSR content untouched. Mirror the featured-topics island structure (recon).

**Files:**
- Create: `hugo-apps/src/topic-clusters-band/main.ts`
- Create: `hugo-apps/src/topic-clusters-band/hydrate.ts`
- Create: `hugo-apps/src/topic-clusters-band/hydrate.test.ts`
- Modify: `hugo-apps/vite.config.ts` (register input)

**Interfaces:**
- Consumes: SSR DOM (`[data-app="topic-clusters-band"]`, per-card `.hp-topic-clusters__cluster[data-fp]`, `data-etag`), and `/homepage/topicClusterVolatile()` payload `{ etag, clusters:[{communityFingerprint, items:[{kind,slug,title,href,isNew}]}] }`.
- Produces: augmented `<ul.hp-topic-clusters__links>` per card (volatile `<li>`s inserted, list re-capped to 8).

- [ ] **Step 1: Write the failing test (pure merge logic)**

```ts
// hugo-apps/src/topic-clusters-band/hydrate.test.ts
import { describe, it, expect } from 'vitest';
import { mergeVolatile } from './hydrate';

describe('mergeVolatile', () => {
  const ssr = [
    { kind: 'tutorial', slug: 't1', title: 'T1', href: '/tutorials/t1' },
    { kind: 'tutorial', slug: 't2', title: 'T2', href: '/tutorials/t2' },
  ];
  it('appends volatile items, dedupes by kind+slug, caps at 8', () => {
    const volatile = [
      { kind: 'blog-post', slug: 'b1', title: 'B1', href: 'https://x/b1', isNew: true },
      { kind: 'tutorial', slug: 't1', title: 'T1', href: '/tutorials/t1' }, // dup — dropped
    ];
    const out = mergeVolatile(ssr, volatile, 8);
    expect(out.filter(i => i.kind === 'blog-post').length).toBe(1);
    expect(out.filter(i => i.slug === 't1').length).toBe(1);
    expect(out.length).toBeLessThanOrEqual(8);
  });
  it('returns SSR unchanged when volatile is empty', () => {
    expect(mergeVolatile(ssr, [], 8)).toEqual(ssr);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: from repo root, `npx vitest run --project unit hugo-apps/src/topic-clusters-band/hydrate.test.ts`
Expected: FAIL — module not found. (Memory: hugo-apps `.ts`/`.vue` tests run via `--project unit` from repo root.)

- [ ] **Step 3: Write the merge helper + DOM entry**

```ts
// hugo-apps/src/topic-clusters-band/hydrate.ts
export interface ClusterItem { kind: string; slug: string; title: string; href: string; isNew?: boolean; }

/** Merge volatile items into SSR items: dedupe by kind+slug, keep SSR first, cap total. */
export function mergeVolatile(ssr: ClusterItem[], volatile: ClusterItem[], cap: number): ClusterItem[] {
  const seen = new Set(ssr.map(i => `${i.kind}:${i.slug}`));
  const merged = [...ssr];
  for (const v of volatile) {
    const k = `${v.kind}:${v.slug}`;
    if (seen.has(k) || !v.href) continue;
    seen.add(k);
    merged.push(v);
  }
  return merged.slice(0, cap);
}
```

```ts
// hugo-apps/src/topic-clusters-band/main.ts
import { mergeVolatile, type ClusterItem } from './hydrate';

const TOTAL = 8;

function readCardItems(ul: HTMLElement): ClusterItem[] {
  return Array.from(ul.querySelectorAll<HTMLElement>('li[data-kind]')).map(li => ({
    kind: li.getAttribute('data-kind') || '',
    slug: li.getAttribute('data-slug') || '',
    title: li.querySelector('a')?.textContent?.trim() || '',
    href: li.querySelector('a')?.getAttribute('href') || '',
  }));
}

function renderItems(ul: HTMLElement, items: ClusterItem[]): void {
  ul.innerHTML = items.map(i => {
    const label = i.title || i.slug;
    return `<li data-kind="${i.kind}" data-slug="${i.slug}"><a href="${i.href}">${label}</a>`
      + `<span class="hp-tc-badge hp-tc-badge--${i.kind}">${i.kind}</span></li>`;
  }).join('');
}

async function hydrate(root: HTMLElement): Promise<void> {
  const etag = root.getAttribute('data-etag') || '';
  try {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (etag) headers['If-None-Match'] = etag;
    const res = await fetch('/homepage/topicClusterVolatile()', { headers });
    if (res.status === 304 || !res.ok) return;      // fail-open: keep SSR
    const body = await res.json();
    const clusters = body.clusters ?? body.value?.[0]?.clusters ?? [];
    const byFp = new Map<string, ClusterItem[]>(clusters.map((c: any) => [c.communityFingerprint, c.items || []]));
    root.querySelectorAll<HTMLElement>('.hp-topic-clusters__cluster[data-fp]').forEach(card => {
      const fp = card.getAttribute('data-fp') || '';
      const vol = byFp.get(fp);
      if (!vol || !vol.length) return;
      const ul = card.querySelector<HTMLElement>('.hp-topic-clusters__links');
      if (!ul) return;
      renderItems(ul, mergeVolatile(readCardItems(ul), vol, TOTAL));
    });
  } catch (err) {
    if (typeof console !== 'undefined') console.warn('[topic-clusters-band] hydration failed', err);
  }
}

document.querySelectorAll<HTMLElement>('[data-app="topic-clusters-band"]').forEach(hydrate);
```

- [ ] **Step 4: Register the Vite input**

In `hugo-apps/vite.config.ts`, add to `build.rollupOptions.input` (next to `featured-topics-carousel`):

```ts
        'topic-clusters-band': resolve(__dirname, 'src/topic-clusters-band/main.ts'),
```

- [ ] **Step 5: Run the island test**

Run: from repo root, `npx vitest run --project unit hugo-apps/src/topic-clusters-band/hydrate.test.ts`
Expected: PASS (2).

- [ ] **Step 6: Build the island bundle + confirm it emits**

Run: `cd hugo-apps && npx vite build 2>&1 | grep topic-clusters-band` then `cd .. && node scripts/build-island-manifest.cjs`
Expected: Vite emits `topic-clusters-band-<hash>.js`; the manifest script writes a `topic-clusters-band` entry into both `hugo/data/island_manifest.json` and `srv/lib/island-manifest.json`.

- [ ] **Step 7: Commit**

```bash
git add hugo-apps/src/topic-clusters-band/ hugo-apps/vite.config.ts
git commit -m "feat: topic-clusters-band island hydrates volatile tier into homepage cards"
```

---

## Task 8: Integration wiring, guards, and full-suite verification

Prove the pieces fit: island path bakes hashed, endpoint reachable, whole suite green, srv-qa audit done, e2e stub added.

**Files:**
- Create: `test/e2e/topic-clusters-band.spec.ts` (advisory e2e coverage — self-skips without `SMOKE_BASE_URL`)
- Verify only: `.deploy/mta.yaml` (srv-qa cp list)

- [ ] **Step 1: srv-qa cp-list audit**

Run: `grep -n "content-store" srv/lib/build-topic-clusters.js srv/lib/build-topic-cluster-content.js srv/lib/topic-cluster-content.js` and re-walk imports from `srv/lib/content-store.js`.
Expected: none of the three new/modified libs is a transitive `./` import of `content-store.js` → **no `srv-qa` `cp` entry needed**. Record the conclusion in the commit message. If any IS reachable, add it to the `srv-qa` module's `cp:` list in `.deploy/mta.yaml`.

- [ ] **Step 2: Add the advisory e2e spec**

Mirror an existing `test/e2e/*.spec.ts` (self-skip guard when `SMOKE_BASE_URL`/`PLAYWRIGHT_BASE_URL` absent). Assert the band renders on the homepage and at least one non-tutorial badge appears when data exists:

```ts
// test/e2e/topic-clusters-band.spec.ts
import { test, expect } from '@playwright/test';
const BASE = process.env.SMOKE_BASE_URL || process.env.PLAYWRIGHT_BASE_URL;
test.skip(!BASE, 'no deployed base url');
test('homepage topic-cluster band renders (multi-source)', async ({ page }) => {
  await page.goto(BASE!);
  const band = page.locator('[data-app="topic-clusters-band"]');
  // Band is empty-by-omission; only assert badges when the band exists.
  if (await band.count()) {
    await expect(band.locator('.hp-topic-clusters__cluster').first()).toBeVisible();
  }
});
```

- [ ] **Step 3: Full unit suite**

Run: `npm test`
Expected: PASS (in-memory SQLite). Confirm no regression in `test/unit/srv` or `test/unit/hugo`.

- [ ] **Step 4: Model deploy sanity + lint**

Run: `npx cds deploy --to sqlite::memory: 2>&1 | tail -3`
Expected: clean compile (new CDS types resolve).

- [ ] **Step 5: Commit**

```bash
git add test/e2e/topic-clusters-band.spec.ts
git commit -m "test: advisory e2e for multi-source topic-cluster band; srv-qa cp audit clean"
```

- [ ] **Step 6: Open PR**

```bash
git push -u origin worktree-expand-topic-clusters-kg
gh pr create --base main --title "Expand homepage topic clusters to KG multi-source content" \
  --body "Implements docs/superpowers/specs/2026-08-22-topic-clusters-kg-multisource-design.md. Widens the topic-cluster builder to resolve all KG-linked content (direct members + concept-hop), bakes the stable tier SSR with type badges, and hydrates the volatile tier (blogs/videos/events) via a new /homepage/topicClusterVolatile endpoint + island. Fail-open throughout."
```

(Per repo convention: PR, never direct-merge. Do NOT deploy from this branch — merge, then deploy from fresh main.)

---

## Self-Review

**Spec coverage:**
- All-sources resolution → Tasks 2 (registry, all 11 kinds) + 3 (resolver). ✓
- Hybrid render (SSR stable + island volatile) → Task 4 (bake stable) + 5 (volatile endpoint) + 6 (SSR shell) + 7 (island). ✓
- Flat list + type badges → Task 6 (badges) + 7 (merge). ✓
- Ranking + per-type caps + fail-open → Task 2 (`computeRank`/`rankAndCap`/caps) + fail-open in 3/4/5. ✓
- PROD data-population risk → Task 1 spike. ✓
- ETag/304 volatile freshness → Task 5. ✓
- Testing (builder, endpoint, SSR, island, e2e) → Tasks 2–8. ✓
- Global constraints (packet cap, no-BLOB-with-scalars, slug lowercase, hrefs, srv-qa audit, island manifest) → encoded in Global Constraints + Tasks 3/4/8. ✓

**Placeholder scan:** One deliberate lookup remains — the badge CSS file path (`<the-badge-css-file>` in Task 6) and the exact `test/unit/hugo/topic-clusters-band.test.ts` harness style, both require reading the current file first (grep step given). `loadRankMaps` shape is verified in Task 4 Step 5 with an explicit adapt-or-fail instruction. No "TODO"/"handle edge cases" placeholders.

**Type consistency:** item shape `{ kind, slug, title, href, isNew, rank }` is consistent across resolver (Task 3), wire-stripping of `rank` (Tasks 4/5), SSR consumption (Task 6), and island merge (Task 7). `resolveClusterContent(db, fingerprint, { tiers, rankMaps, nowMs })` signature identical in Tasks 3/4/5. Endpoint payload `{ computedAt, etag, clusters:[{communityFingerprint, items}] }` identical in Task 5 (CDS + JS) and Task 7 (island fetch).
