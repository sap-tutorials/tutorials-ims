# Tag-Tree Topics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild `/topics/` as a first-class CAP-served subsystem with the same technical quality as `/concepts/` — stable SAP-tag-hierarchy slugs, a server-rendered tree index + progressive island, deterministically-populated concepts, working search, and dynamic per-slug HANA-blob serving.

**Architecture:** A topic = a live SAP tag (a tag applied to ≥1 tutorial). Two JSON build feeds (`/build/topics-tree`, `/build/topics/:slug`) assemble data directly from `Tags`/`TutorialTags`/`TutorialConceptLinks`. A CAP index renderer (`topic-list-page.js` → `/content/topics-index`) and detail renderer (`topic-detail-render.js`, published as `topic-<slug>` HANA blobs) mirror the concepts subsystem exactly, wrapped in the shared chrome shell. The approuter gains `^/topics/(.*)$` + `^/topics/?$` dynamic routes and a `/search/` → `/tutorial-navigator/` redirect. Legacy `topics_gallery`/Hugo topics section is retired.

**Tech Stack:** SAP CAP (Node.js, `@sap/cds`), Express handlers, Hugo, Vue 3 island (`hugo-apps/`, Vite), HANA content blobs (gzip), AppRouter (`xs-app.json`), Vitest (`cds.test`).

**Spec:** `docs/superpowers/specs/2026-09-01-tag-tree-topics-design.md`

## Global Constraints

- **PRs target `DEV`; `main` is protected — no direct-to-main path.** Branch off `origin/DEV`. This worktree is already rebased onto `origin/DEV`.
- **Never write raw SQL** — use `cds.ql`/CQL. Exception: reading HANA BLOBs alongside metadata (use raw `db.run()` per the BLOB-locator rule); topic payload queries touch no BLOBs, so CQL applies throughout the query layer.
- **Never SELECT a HANA BLOB alongside metadata in one CDS QL query.** The publish/serve blob paths reuse the existing concepts blob helpers (`composeShell`, session helpers) which already obey this.
- **Resolve entities via `cds.entities(NS)`** with `NS = 'com.sap.developers.ims'`, not bare `SELECT.from('X')` (CI Node 22 vs local Node 24 drift).
- **HANA stores columns UPPERCASE**; junction FK columns are `tutorial_ID`, `tag_ID`, `concept_ID`. Query via entity refs + CQL (CAP maps casing), never hand-cased raw SQL here.
- **`srv/lib/*` reachable from `content-store.js` must be in `.deploy/mta.yaml`'s `srv-qa` `cp` list**, with transitive `./` imports re-walked (Task 12).
- **Never `publish-content` from a workstation** — topic blobs publish via `gh workflow run rebuild-content.yml`. Local verification uses `/build/topics/:slug` JSON + hybrid tests.
- **Fail-open everywhere:** empty `TutorialConceptLinks`/`Tags` → empty payload + `error` field, never a 500. Mirrors `build-topics-gallery.js` posture.
- **Tutorial slugs are lowercase canonical** — `.toLowerCase()` tutorial slugs before emitting hrefs.
- **Test bootstrap:** `cds.test('serve', …, '--in-memory')` — NOT `cds.deploy(cds.model)` (broken in unit tests).
- **Pre-commit for any `db/**/*.cds` change:** `npx cds deploy --to sqlite::memory:`. (This plan adds NO new CDS entities — all sources already exist.)
- **Address the user as Tom.**

---

## File Structure

**New files:**
- `srv/lib/topic-slug.js` — pure slug flatten / collision-qualify / legacy-normalize utilities.
- `srv/lib/topics-query.js` — data assemblers: `buildTopicsTreePayload(db)`, `buildTopicDetailPayload(db, slug)`, `resolveTopicBySlug`.
- `srv/lib/build-topics.js` — Express JSON feed handlers `buildTopicsTreeHandler`, `buildTopicDetailHandler` (mirrors `build-concepts.js`).
- `srv/lib/topic-list-page.js` — CAP index renderer + `topicsIndexHandler` (mirrors `concept-list-page.js`).
- `srv/lib/topic-detail-render.js` — `renderTopicDetail(topic)` → `{body, contentHash}` (mirrors `concept-detail-render.js`).
- `srv/lib/publish-topics.js` — `renderTopicsIntoSession(...)` blob publisher (mirrors `publish-concepts.js`).
- `hugo-apps/src/topics-tree/main.ts` + `App.vue` — progressive-enhancement island.
- `test/unit/topic-slug.test.js`, `test/unit/topics-query.test.js`, `test/unit/topic-list-page.test.js` — unit tests.
- `test/hybrid/topics-publish-serve.test.js` — hybrid round-trip.
- `test/e2e/topics.spec.ts` — post-deploy e2e.

**Modified files:**
- `srv/server.js` — register 4 routes.
- `srv/lib/page-key-map.js` — add `TOPIC_KEY_PREFIX` + `discoverTopicPages`.
- `scripts/publish-content.ts` — call `discoverTopicPages` in the non-slug publish path.
- `approuter/xs-app.json` — topics detail/index routes, `topics-tree` build allow-list, `/search/` redirect.
- `hugo/layouts/topics/list.html` — repoint search form (interim, before section retirement).
- `.deploy/mta.yaml` — `srv-qa` `cp` list.
- `hugo-apps/vite.config.ts` — register `topics-tree` island entry.
- **Deletions (Task 11):** `hugo/content/topics/btp-basics.md`, `hugo/content/topics/cap-fundamentals.md`, `hugo/layouts/topics/list.html`, `hugo/layouts/topics/single.html`, `hugo/data/topics_gallery.json`, `scripts/fetch-topics-gallery.ts`, and orphaned tests referencing them.

---

## Task 1: Pure slug utilities (`srv/lib/topic-slug.js`)

**Files:**
- Create: `srv/lib/topic-slug.js`
- Test: `test/unit/topic-slug.test.js`

**Interfaces:**
- Produces:
  - `flattenTopicSlug(value: string): string` — `'sap-hana-cloud--data-lake'` → `'sap-hana-cloud-data-lake'`.
  - `buildTopicSlugMap(liveTags: Array<{titlePath, label, tutorialCount, conceptCount}>): { bySlug: Map<string, Tag>, byTag: Map<string, string> }` — deterministic collision-qualify.
  - `normalizeLegacyTopicSlug(slug: string): string` — strips a single trailing `-<digits>` disambiguator.
  - `parseTitlePath(titlePath: string): { facet: string, value: string, segments: string[] }`.
  - `Tag` shape: `{ titlePath, facet, value, segments, slug, label, tutorialCount, conceptCount }`.

- [ ] **Step 1: Write the failing test**

```js
// test/unit/topic-slug.test.js
import { describe, it, expect } from 'vitest';
import {
  flattenTopicSlug, parseTitlePath, buildTopicSlugMap, normalizeLegacyTopicSlug,
} from '../../srv/lib/topic-slug.js';

describe('flattenTopicSlug', () => {
  it('collapses -- and lowercases', () => {
    expect(flattenTopicSlug('sap-hana-cloud--data-lake')).toBe('sap-hana-cloud-data-lake');
    expect(flattenTopicSlug('SAP-HANA-Cloud')).toBe('sap-hana-cloud');
  });
});

describe('parseTitlePath', () => {
  it('splits facet, value and -- segments', () => {
    expect(parseTitlePath('software-product-function>sap-hana-cloud--data-lake')).toEqual({
      facet: 'software-product-function',
      value: 'sap-hana-cloud--data-lake',
      segments: ['sap-hana-cloud', 'data-lake'],
    });
  });
});

describe('buildTopicSlugMap', () => {
  it('qualifies collisions with facet, first-by-titlePath wins bare', () => {
    const { bySlug } = buildTopicSlugMap([
      { titlePath: 'software-product>foo-bar', label: 'A' },
      { titlePath: 'topic>foo--bar', label: 'B' }, // also flattens to foo-bar
    ]);
    expect(bySlug.has('foo-bar')).toBe(true);          // software-product wins (sorts first)
    expect(bySlug.get('foo-bar').label).toBe('A');
    expect(bySlug.has('topic-foo-bar')).toBe(true);    // loser facet-qualified
    expect(bySlug.get('topic-foo-bar').label).toBe('B');
  });
});

describe('normalizeLegacyTopicSlug', () => {
  it('strips a trailing numeric disambiguator', () => {
    expect(normalizeLegacyTopicSlug('sap-hana-smart-data-streaming-development-2'))
      .toBe('sap-hana-smart-data-streaming-development');
    expect(normalizeLegacyTopicSlug('sap-hana-cloud')).toBe('sap-hana-cloud');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/topic-slug.test.js --project unit`
Expected: FAIL — module not found / functions undefined.

- [ ] **Step 3: Write minimal implementation**

```js
// srv/lib/topic-slug.js
export function flattenTopicSlug(value) {
  return String(value).replace(/--/g, '-').toLowerCase();
}

export function parseTitlePath(titlePath) {
  const idx = String(titlePath).indexOf('>');
  const facet = idx === -1 ? '' : titlePath.slice(0, idx);
  const value = idx === -1 ? titlePath : titlePath.slice(idx + 1);
  return { facet, value, segments: value.split('--') };
}

// Deterministic: sort by titlePath, first occupant of a slug keeps it bare;
// later collisions are facet-qualified `<facet>-<slug>`.
export function buildTopicSlugMap(liveTags) {
  const bySlug = new Map();
  const byTag = new Map();
  const sorted = [...liveTags].sort((a, b) => a.titlePath.localeCompare(b.titlePath));
  for (const raw of sorted) {
    const { facet, value, segments } = parseTitlePath(raw.titlePath);
    const base = flattenTopicSlug(value);
    let slug = base;
    if (bySlug.has(slug)) slug = `${facet}-${base}`;
    // If even the qualified slug collides, suffix an index (defensive; asserted-rare).
    let n = 2;
    while (bySlug.has(slug)) slug = `${facet}-${base}-${n++}`;
    const tag = {
      titlePath: raw.titlePath, facet, value, segments, slug,
      label: raw.label || segments[segments.length - 1],
      tutorialCount: raw.tutorialCount ?? 0,
      conceptCount: raw.conceptCount ?? 0,
    };
    bySlug.set(slug, tag);
    byTag.set(raw.titlePath, slug);
  }
  return { bySlug, byTag };
}

export function normalizeLegacyTopicSlug(slug) {
  return String(slug).replace(/-\d+$/, '');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/topic-slug.test.js --project unit`
Expected: PASS (4 suites).

- [ ] **Step 5: Commit**

```bash
git add srv/lib/topic-slug.js test/unit/topic-slug.test.js
git commit -m "feat(topics): pure slug flatten + collision-qualify + legacy-normalize"
```

---

## Task 2: Data assemblers (`srv/lib/topics-query.js`)

**Files:**
- Create: `srv/lib/topics-query.js`
- Test: `test/unit/topics-query.test.js`

**Interfaces:**
- Consumes: `flattenTopicSlug`, `parseTitlePath`, `buildTopicSlugMap`, `normalizeLegacyTopicSlug` (Task 1).
- Produces:
  - `loadLiveTags(db): Promise<Tag[]>` — tags applied to ≥1 tutorial, with `tutorialCount` + `conceptCount`.
  - `buildTopicsTreePayload(db): Promise<{ tree, buildAt, error }>` where `tree = [{ facet, label, children: TreeNode[] }]`, `TreeNode = { segment, label, slug?, tutorialCount?, conceptCount?, children: TreeNode[] }`.
  - `resolveTopicBySlug(db, slug): Promise<{ tag: Tag|null, redirectTo: string|null }>` — legacy `-N` strip + facet-qualify resolution.
  - `buildTopicDetailPayload(db, slug): Promise<{ slug, label, facet, tutorials, concepts, relatedTags, buildAt, error, notFound?, redirectTo? }>`.
  - `tutorials[]` = `{ slug, title, level, time, href, isNew }`; `concepts[]` = `{ slug, name, rank }`; `relatedTags[]` = `{ slug, label }`.

**Reference to mirror:** tag→tutorial join pattern `srv/lib/kg-projection.js:1027-1038`; unbounded-fetch-filter-in-Node HANA pattern `srv/lib/published-concepts-query.js:78-92`; teaches-link join `published-concepts-query.js:95-104`.

- [ ] **Step 1: Write the failing test**

```js
// test/unit/topics-query.test.js
import { describe, it, beforeAll, expect } from 'vitest';
import cds from '@sap/cds';
import {
  loadLiveTags, buildTopicsTreePayload, resolveTopicBySlug, buildTopicDetailPayload,
} from '../../srv/lib/topics-query.js';

const NS = 'com.sap.developers.ims';

describe('topics-query', () => {
  let db;
  beforeAll(async () => {
    await cds.test('serve', '--in-memory', '--project', process.cwd());
    db = await cds.connect.to('db');
    const { Tutorials, Tags, TutorialTags, TutorialConceptLinks, Concepts } = cds.entities(NS);
    await db.run(INSERT.into(Tags).entries([
      { ID: 't1', titlePath: 'software-product>sap-hana-cloud', label: 'SAP HANA Cloud', name: 'sap-hana-cloud' },
      { ID: 't2', titlePath: 'software-product-function>sap-hana-cloud--data-lake', label: 'Data Lake', name: 'sap-hana-cloud--data-lake' },
    ]));
    await db.run(INSERT.into(Tutorials).entries([
      { ID: 'tut1', slug: 'hana-intro', title: 'HANA Intro', experienceTag: 'Beginner' },
    ]));
    await db.run(INSERT.into(TutorialTags).entries([
      { tutorial_ID: 'tut1', tag_ID: 't1' },
    ]));
    await db.run(INSERT.into(Concepts).entries([
      { ID: 'c1', slug: 'in-memory-database', name: 'In-Memory Database', status: 'ACTIVE', publishedAt: new Date().toISOString() },
    ]));
    await db.run(INSERT.into(TutorialConceptLinks).entries([
      { ID: 'l1', tutorial_ID: 'tut1', concept_ID: 'c1', predicate: 'teaches' },
    ]));
  });

  it('loadLiveTags returns only tags with ≥1 tutorial, with counts', async () => {
    const live = await loadLiveTags(db);
    const slugs = live.map(t => t.slug).sort();
    expect(slugs).toContain('sap-hana-cloud');
    expect(slugs).not.toContain('sap-hana-cloud-data-lake'); // t2 has no tutorial
    const hana = live.find(t => t.slug === 'sap-hana-cloud');
    expect(hana.tutorialCount).toBe(1);
    expect(hana.conceptCount).toBe(1);
  });

  it('buildTopicsTreePayload groups by facet', async () => {
    const { tree, error } = await buildTopicsTreePayload(db);
    expect(error).toBeFalsy();
    const facet = tree.find(f => f.facet === 'software-product');
    expect(facet.children.some(n => n.slug === 'sap-hana-cloud')).toBe(true);
  });

  it('buildTopicDetailPayload returns tutorials + concepts', async () => {
    const p = await buildTopicDetailPayload(db, 'sap-hana-cloud');
    expect(p.notFound).toBeFalsy();
    expect(p.tutorials.map(t => t.slug)).toContain('hana-intro');
    expect(p.concepts.map(c => c.slug)).toContain('in-memory-database');
  });

  it('resolveTopicBySlug strips legacy -N and redirects', async () => {
    const r = await resolveTopicBySlug(db, 'sap-hana-cloud-2');
    expect(r.tag?.slug).toBe('sap-hana-cloud');
    expect(r.redirectTo).toBe('/topics/sap-hana-cloud/');
  });

  it('unknown slug is notFound with redirect to /topics/', async () => {
    const p = await buildTopicDetailPayload(db, 'does-not-exist');
    expect(p.notFound).toBe(true);
    expect(p.redirectTo).toBe('/topics/');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/topics-query.test.js --project unit`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```js
// srv/lib/topics-query.js
import cds from '@sap/cds';
import { buildTopicSlugMap, parseTitlePath, normalizeLegacyTopicSlug } from './topic-slug.js';

const NS = 'com.sap.developers.ims';
const MAX_TUTORIALS = 60;
const MAX_CONCEPTS = 24;

function ent() {
  const { Tags, TutorialTags, Tutorials, TutorialConceptLinks, Concepts, ConceptRank } = cds.entities(NS);
  return { Tags, TutorialTags, Tutorials, TutorialConceptLinks, Concepts, ConceptRank };
}

function humanizeFacet(facet) {
  return String(facet).split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// Live-tag set (applied to ≥1 tutorial) with per-tag tutorial + concept counts.
export async function loadLiveTags(db) {
  const { Tags, TutorialTags, TutorialConceptLinks } = ent();
  const tags = await db.run(SELECT.from(Tags).columns('ID', 'titlePath', 'label', 'name'));
  const tagById = new Map(tags.map(t => [t.ID, t]));
  const links = await db.run(SELECT.from(TutorialTags).columns('tutorial_ID', 'tag_ID'));

  const tutorialIdsByTag = new Map(); // tag_ID -> Set(tutorial_ID)
  for (const l of links) {
    if (!tagById.has(l.tag_ID)) continue;
    (tutorialIdsByTag.get(l.tag_ID) ?? tutorialIdsByTag.set(l.tag_ID, new Set()).get(l.tag_ID)).add(l.tutorial_ID);
  }

  // Bulk teaches-links → tutorial_ID -> Set(concept_ID); unbounded fetch, filter in Node.
  const teaches = await db.run(
    SELECT.from(TutorialConceptLinks).columns('tutorial_ID', 'concept_ID').where({ predicate: 'teaches' }),
  );
  const conceptsByTutorial = new Map();
  for (const t of teaches) {
    if (!t.concept_ID) continue;
    (conceptsByTutorial.get(t.tutorial_ID) ?? conceptsByTutorial.set(t.tutorial_ID, new Set()).get(t.tutorial_ID)).add(t.concept_ID);
  }

  const liveRaw = [];
  for (const [tagId, tutSet] of tutorialIdsByTag) {
    const tag = tagById.get(tagId);
    if (!tag?.titlePath) continue;
    const conceptSet = new Set();
    for (const tutId of tutSet) for (const c of (conceptsByTutorial.get(tutId) ?? [])) conceptSet.add(c);
    liveRaw.push({ titlePath: tag.titlePath, label: tag.label, tutorialCount: tutSet.size, conceptCount: conceptSet.size });
  }
  const { bySlug } = buildTopicSlugMap(liveRaw);
  return [...bySlug.values()];
}

export async function buildTopicsTreePayload(db) {
  try {
    const live = await loadLiveTags(db);
    const facets = new Map(); // facet -> node
    for (const tag of live) {
      if (!facets.has(tag.facet)) facets.set(tag.facet, { facet: tag.facet, label: humanizeFacet(tag.facet), children: [] });
      const facetNode = facets.get(tag.facet);
      let level = facetNode.children;
      for (let i = 0; i < tag.segments.length; i++) {
        const seg = tag.segments[i];
        let node = level.find(n => n.segment === seg);
        if (!node) { node = { segment: seg, label: seg, children: [] }; level.push(node); }
        if (i === tag.segments.length - 1) {
          node.slug = tag.slug;
          node.label = tag.label || seg;
          node.tutorialCount = tag.tutorialCount;
          node.conceptCount = tag.conceptCount;
        }
        level = node.children;
      }
    }
    const sortRec = (nodes) => {
      nodes.sort((a, b) => a.label.localeCompare(b.label));
      for (const n of nodes) sortRec(n.children);
    };
    const tree = [...facets.values()].sort((a, b) => a.label.localeCompare(b.label));
    for (const f of tree) sortRec(f.children);
    return { tree, buildAt: new Date().toISOString(), error: null };
  } catch (err) {
    return { tree: [], buildAt: new Date().toISOString(), error: err.message };
  }
}

export async function resolveTopicBySlug(db, slug) {
  const live = await loadLiveTags(db);
  const bySlug = new Map(live.map(t => [t.slug, t]));
  if (bySlug.has(slug)) return { tag: bySlug.get(slug), redirectTo: null };
  const base = normalizeLegacyTopicSlug(slug);
  if (base !== slug && bySlug.has(base)) return { tag: bySlug.get(base), redirectTo: `/topics/${base}/` };
  return { tag: null, redirectTo: '/topics/' };
}

export async function buildTopicDetailPayload(db, slug) {
  try {
    const { tag, redirectTo } = await resolveTopicBySlug(db, slug);
    if (!tag) return { slug, notFound: true, redirectTo, tutorials: [], concepts: [], relatedTags: [], buildAt: new Date().toISOString(), error: null };
    if (redirectTo) return { slug: tag.slug, notFound: false, redirectTo, tutorials: [], concepts: [], relatedTags: [], buildAt: new Date().toISOString(), error: null };

    const { Tags, TutorialTags, Tutorials, TutorialConceptLinks, Concepts, ConceptRank } = ent();

    // tutorials carrying this tag
    const tagRow = await db.run(SELECT.one.from(Tags).columns('ID').where({ titlePath: tag.titlePath }));
    const ttRows = tagRow ? await db.run(SELECT.from(TutorialTags).columns('tutorial_ID').where({ tag_ID: tagRow.ID })) : [];
    const tutIds = new Set(ttRows.map(r => r.tutorial_ID));
    const allTuts = await db.run(SELECT.from(Tutorials).columns('ID', 'slug', 'title', 'experienceTag', 'timeToComplete', 'isNew'));
    const tutorials = allTuts
      .filter(t => tutIds.has(t.ID))
      .map(t => ({
        slug: String(t.slug || '').toLowerCase(),
        title: t.title,
        level: t.experienceTag || null,
        time: t.timeToComplete || null,
        href: `/tutorials/${String(t.slug || '').toLowerCase()}/`,
        isNew: !!t.isNew,
      }))
      .sort((a, b) => a.title.localeCompare(b.title))
      .slice(0, MAX_TUTORIALS);

    // concepts taught by those tutorials (unbounded fetch + Node filter)
    const teaches = await db.run(SELECT.from(TutorialConceptLinks).columns('tutorial_ID', 'concept_ID').where({ predicate: 'teaches' }));
    const conceptIds = new Set(teaches.filter(l => tutIds.has(l.tutorial_ID) && l.concept_ID).map(l => l.concept_ID));
    const allConcepts = await db.run(SELECT.from(Concepts).columns('ID', 'slug', 'name').where({ status: 'ACTIVE' }));
    const rankRows = await db.run(SELECT.from(ConceptRank).columns('slug', 'score')).catch(() => []);
    const rankBySlug = new Map(rankRows.map(r => [r.slug, r.score]));
    const concepts = allConcepts
      .filter(c => conceptIds.has(c.ID))
      .map(c => ({ slug: c.slug, name: c.name, rank: rankBySlug.get(c.slug) ?? 0 }))
      .sort((a, b) => b.rank - a.rank || a.name.localeCompare(b.name))
      .slice(0, MAX_CONCEPTS);

    // related tags = same-facet siblings sharing the parent segment
    const parent = tag.segments.slice(0, -1);
    const relatedTags = live
      .filter(t => t.slug !== tag.slug && t.facet === tag.facet)
      .filter(t => parent.length === 0 || parent.every((seg, i) => t.segments[i] === seg))
      .map(t => ({ slug: t.slug, label: t.label }))
      .sort((a, b) => a.label.localeCompare(b.label))
      .slice(0, 24);

    return {
      slug: tag.slug, label: tag.label, facet: tag.facet,
      tutorials, concepts, relatedTags,
      buildAt: new Date().toISOString(), error: null,
    };
  } catch (err) {
    return { slug, tutorials: [], concepts: [], relatedTags: [], buildAt: new Date().toISOString(), error: err.message };
  }
}
```

> **NOTE for implementer:** verify the real column names on `Tutorials` before running — the recon confirmed `slug`, `title`, `experienceTag`, `stepCount`, `isNew`, `primaryTag`. Confirm the "time to complete" column name via `cds.entities(NS).Tutorials` (candidates: `timeToComplete`, `time`, `estimatedTime`); adjust the `.columns(...)` and mapping to the actual name. If absent, drop `time` from the projection.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/topics-query.test.js --project unit`
Expected: PASS (5 cases). Fix column-name mismatches surfaced here.

- [ ] **Step 5: Commit**

```bash
git add srv/lib/topics-query.js test/unit/topics-query.test.js
git commit -m "feat(topics): tree + detail data assemblers (tag-sourced, concept-enriched, fail-open)"
```

---

## Task 3: JSON build feed handlers (`srv/lib/build-topics.js`)

**Files:**
- Create: `srv/lib/build-topics.js`

**Interfaces:**
- Consumes: `buildTopicsTreePayload`, `buildTopicDetailPayload` (Task 2).
- Produces: `buildTopicsTreeHandler(req, res)`, `buildTopicDetailHandler(req, res)` — Express handlers.

**Reference to mirror:** `srv/lib/build-concepts.js:11-22`.

- [ ] **Step 1: Write the implementation**

```js
// srv/lib/build-topics.js
import cds from '@sap/cds';
import { buildTopicsTreePayload, buildTopicDetailPayload } from './topics-query.js';

export async function buildTopicsTreeHandler(req, res) {
  const db = await cds.connect.to('db');
  const payload = await buildTopicsTreePayload(db);
  res.set('Cache-Control', 'public, max-age=60');
  res.json(payload);
}

export async function buildTopicDetailHandler(req, res) {
  const db = await cds.connect.to('db');
  const slug = String(req.params.slug || '').toLowerCase();
  const payload = await buildTopicDetailPayload(db, slug);
  res.set('Cache-Control', 'public, max-age=60');
  res.status(payload.notFound ? 404 : 200).json(payload);
}
```

- [ ] **Step 2: Commit** (registration + live verification happen in Task 8)

```bash
git add srv/lib/build-topics.js
git commit -m "feat(topics): /build/topics-tree + /build/topics/:slug JSON feed handlers"
```

---

## Task 4: CAP index renderer (`srv/lib/topic-list-page.js`)

**Files:**
- Create: `srv/lib/topic-list-page.js`
- Test: `test/unit/topic-list-page.test.js`

**Interfaces:**
- Consumes: `buildTopicsTreePayload` (Task 2); `chrome-shell.js` exports `createShellLoader`, `composeShell`, `ShellMarkerError`; `edge-cache-headers.js` `setContentCacheHeaders`; `island-manifest.json`.
- Produces:
  - `buildTopicListModel(db, deps = {}): Promise<{ tree, version }>`.
  - `renderTopicListBody(model): string` — BODY fragment: inline `<style>`, `<article class="topics-index" id="topics-tree-root">` with semantic nested `<ul>` + `<details>/<summary>`, embedded `<script type="application/json" id="topics-tree-data">`, and `<script type="module" src="${islandSrc('topics-tree')}" defer>`.
  - `createTopicListPage({ namespace, deps } = {}): { topicsIndexHandler, _invalidate }`.
  - Default export `topicsIndexHandler`.

**Reference to mirror (read these exact ranges and copy the boilerplate):**
- `srv/lib/concept-list-page.js:20-38` — `islandSrc` + imports.
- `concept-list-page.js:239-334` — `createConceptListPage` factory: shell loader wiring, `getActiveVersion()`, version-keyed gzip+etag cache, 304 handling, `composeShell` wrap, `setContentCacheHeaders`, `X-Content-Source`, stale-cache-on-error → 503.
- `srv/lib/chrome-shell.js:75-89` — **add a `topics-index` case to `canonicalUrlFor`** returning `/topics/` and a `topic` case returning `/topics/${slug}/`; **add the same two cases to `buildBreadcrumbJsonLd` (`chrome-shell.js:99-137`)**.

- [ ] **Step 1: Write the failing test**

```js
// test/unit/topic-list-page.test.js
import { describe, it, expect } from 'vitest';
import { renderTopicListBody } from '../../srv/lib/topic-list-page.js';

describe('renderTopicListBody', () => {
  const model = {
    version: 'v1',
    tree: [{
      facet: 'software-product', label: 'Software Product',
      children: [
        { segment: 'sap-hana-cloud', slug: 'sap-hana-cloud', label: 'SAP HANA Cloud', tutorialCount: 3, conceptCount: 5, children: [
          { segment: 'data-lake', slug: 'sap-hana-cloud-data-lake', label: 'Data Lake', tutorialCount: 1, conceptCount: 2, children: [] },
        ] },
      ],
    }],
  };
  it('renders nested details/ul with topic links and no-JS disclosure', () => {
    const html = renderTopicListBody(model);
    expect(html).toContain('<details');
    expect(html).toContain('<summary');
    expect(html).toContain('href="/topics/sap-hana-cloud/"');
    expect(html).toContain('href="/topics/sap-hana-cloud-data-lake/"');
    expect(html).toContain('id="topics-tree-root"');
  });
  it('embeds the tree JSON and the island script', () => {
    const html = renderTopicListBody(model);
    expect(html).toContain('id="topics-tree-data"');
    expect(html).toMatch(/<script type="module" src="[^"]+" defer>/);
    // JSON must be HTML-safe
    expect(html).not.toContain('</script></script>');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/topic-list-page.test.js --project unit`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```js
// srv/lib/topic-list-page.js
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import cds from '@sap/cds';
import { createShellLoader, ShellMarkerError, composeShell } from './chrome-shell.js';
import { buildTopicsTreePayload } from './topics-query.js';
import { setContentCacheHeaders } from './edge-cache-headers.js';

const _dir = dirname(fileURLToPath(import.meta.url));
let _islandManifest;
function islandSrc(name) {
  if (!_islandManifest) {
    try { _islandManifest = JSON.parse(readFileSync(join(_dir, 'island-manifest.json'), 'utf8')); }
    catch { _islandManifest = {}; }
  }
  return _islandManifest[name] ?? `/js/${name}.js`;
}

const DEFAULT_NAMESPACE = 'com.sap.developers.ims';
const HANA_TABLE = 'com_sap_developers_ims_ContentFiles';
const HANA_CURRENT_TABLE = 'com_sap_developers_ims_ContentCurrent';

const TOPICS_STYLE = `<style>
.topics-index{max-width:64rem;margin:0 auto;padding:1rem}
.topics-index details{margin:.25rem 0}
.topics-index summary{cursor:pointer;font-weight:600}
.topics-index ul{list-style:none;padding-left:1.25rem;margin:.25rem 0}
.topics-index__count{color:#556;font-size:.85em;margin-left:.4em}
.topics-index__filter{width:100%;max-width:28rem;padding:.5rem;margin:.5rem 0}
</style>`;

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function jsonForScript(obj) {
  return JSON.stringify(obj).replace(/</g, '\\u003c');
}

function renderNode(node) {
  const count = node.slug
    ? `<span class="topics-index__count">${node.tutorialCount ?? 0} tutorials · ${node.conceptCount ?? 0} concepts</span>`
    : '';
  const label = node.slug
    ? `<a href="/topics/${esc(node.slug)}/">${esc(node.label)}</a>${count}`
    : `${esc(node.label)}`;
  if (node.children && node.children.length) {
    return `<li><details><summary>${label}</summary><ul>${node.children.map(renderNode).join('')}</ul></details></li>`;
  }
  return `<li>${label}</li>`;
}

export function renderTopicListBody(model) {
  const facets = (model.tree || []).map(f =>
    `<li><details open><summary>${esc(f.label)}</summary><ul>${f.children.map(renderNode).join('')}</ul></details></li>`,
  ).join('');
  const data = jsonForScript({ tree: model.tree || [] });
  return `${TOPICS_STYLE}
<article class="topics-index" id="topics-tree-root">
  <h1>Explore topics</h1>
  <input type="search" class="topics-index__filter" id="topics-filter-input"
    placeholder="Filter topics…" aria-label="Filter topics">
  <ul>${facets}</ul>
  <p><a href="/tutorial-navigator/">Search all tutorials →</a></p>
</article>
<script type="application/json" id="topics-tree-data">${data}</script>
<script type="module" src="${islandSrc('topics-tree')}" defer></script>`;
}

export async function buildTopicListModel(db, _deps = {}) {
  const payload = await buildTopicsTreePayload(db);
  return { tree: payload.tree || [], version: null };
}

export function createTopicListPage({ namespace = DEFAULT_NAMESPACE } = {}) {
  const NS = namespace;
  const { ContentManifest } = cds.entities(NS);
  async function getActiveVersion(db) {
    const row = await db.run(SELECT.one.from(ContentManifest).columns('version').where({ status: 'ACTIVE' })).catch(() => null);
    return row?.version ?? null;
  }
  const shellLoader = createShellLoader({
    namespace: NS, hanaTableName: HANA_TABLE, hanaCurrentTableName: HANA_CURRENT_TABLE,
    getActiveVersion: () => cds.connect.to('db').then(getActiveVersion),
  });
  let cache = null; // { version, gz, etag }

  async function topicsIndexHandler(req, res) {
    try {
      const db = await cds.connect.to('db');
      const version = await getActiveVersion(db);
      if (cache && cache.version === version) {
        if (req.headers['if-none-match'] === cache.etag) { res.status(304).end(); return; }
        setContentCacheHeaders(res, { slug: 'topics' });
        res.set('Content-Encoding', 'gzip').set('ETag', cache.etag).set('X-Content-Source', 'db-current').type('html').send(cache.gz);
        return;
      }
      const model = await buildTopicListModel(db);
      model.version = version;
      const body = renderTopicListBody(model);
      const meta = { kind: 'topics-index', slug: 'topics', title: 'Explore topics', description: 'Browse SAP developer topics by product hierarchy.' };
      const shell = await shellLoader.get();
      if (!shell) throw new ShellMarkerError('shell unavailable');
      const html = composeShell(shell, body, meta);
      const gz = gzipSync(Buffer.from(html, 'utf8'));
      const etag = `"${createHash('sha256').update(gz).digest('hex').slice(0, 32)}"`;
      cache = { version, gz, etag };
      if (req.headers['if-none-match'] === etag) { res.status(304).end(); return; }
      setContentCacheHeaders(res, { slug: 'topics' });
      res.set('Content-Encoding', 'gzip').set('ETag', etag).set('X-Content-Source', 'db-current').type('html').send(gz);
    } catch (err) {
      if (cache) {
        res.set('Content-Encoding', 'gzip').set('X-Content-Source', 'db-stale').type('html').send(cache.gz);
        return;
      }
      res.status(503).type('text/plain').send('topics index unavailable');
    }
  }
  return { topicsIndexHandler, _invalidate() { cache = null; shellLoader.invalidate?.(); } };
}

export const { topicsIndexHandler } = createTopicListPage();
export default topicsIndexHandler;
```

> **NOTE for implementer:** the cache/etag/shell-loader boilerplate above is transcribed from `concept-list-page.js:239-334`. **Diff your version against that source** and adopt any details you missed (exact `setContentCacheHeaders` args, `getActiveVersion` source table, `ContentManifest` query shape). Do NOT invent behavior the concepts handler doesn't have.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/topic-list-page.test.js --project unit`
Expected: PASS (2 cases).

- [ ] **Step 5: Add chrome-shell cases + verify concepts untouched**

Edit `srv/lib/chrome-shell.js`: in `canonicalUrlFor` (kind switch ~`:75-89`) add `case 'topics-index': return '/topics/';` and `case 'topic': return \`/topics/${meta.slug}/\`;`. Add the identical two cases to `buildBreadcrumbJsonLd` (~`:99-137`).

- [ ] **Step 6: Commit**

```bash
git add srv/lib/topic-list-page.js srv/lib/chrome-shell.js test/unit/topic-list-page.test.js
git commit -m "feat(topics): CAP-rendered tree index (topic-list-page) + chrome-shell topic canonical/breadcrumb"
```

---

## Task 5: CAP detail renderer (`srv/lib/topic-detail-render.js`)

**Files:**
- Create: `srv/lib/topic-detail-render.js`
- Test: extend `test/unit/topics-query.test.js` (add a render block) or new `test/unit/topic-detail-render.test.js`.

**Interfaces:**
- Consumes: topic detail payload shape from Task 2.
- Produces: `renderTopicDetail(topic): { body: string, contentHash: string }` — `body` supplies its own `<main>` (the shell has only the marker). `topic` = `{ slug, label, facet, tutorials, concepts, relatedTags }`.

**Reference to mirror:** `srv/lib/concept-detail-render.js:51` (`renderConceptDetail` → `{body, contentHash}`, `body = \`<main>${…}</main>\``, `contentHash = sha256(body)`, throws if key fields missing).

- [ ] **Step 1: Write the failing test**

```js
// test/unit/topic-detail-render.test.js
import { describe, it, expect } from 'vitest';
import { renderTopicDetail } from '../../srv/lib/topic-detail-render.js';

describe('renderTopicDetail', () => {
  const topic = {
    slug: 'sap-hana-cloud', label: 'SAP HANA Cloud', facet: 'software-product',
    tutorials: [{ slug: 'hana-intro', title: 'HANA Intro', level: 'Beginner', time: 15, href: '/tutorials/hana-intro/', isNew: true }],
    concepts: [{ slug: 'in-memory-database', name: 'In-Memory Database', rank: 0.9 }],
    relatedTags: [{ slug: 'sap-hana-cloud-data-lake', label: 'Data Lake' }],
  };
  it('renders a <main> body with breadcrumb, tutorials, concepts, related tags', () => {
    const { body, contentHash } = renderTopicDetail(topic);
    expect(body.startsWith('<main>')).toBe(true);
    expect(body.endsWith('</main>')).toBe(true);
    expect(body).toContain('SAP HANA Cloud');
    expect(body).toContain('href="/tutorials/hana-intro/"');
    expect(body).toContain('href="/concepts/in-memory-database/"');
    expect(body).toContain('href="/topics/sap-hana-cloud-data-lake/"');
    expect(contentHash).toMatch(/^[a-f0-9]{64}$/);
  });
  it('throws when slug or label missing', () => {
    expect(() => renderTopicDetail({ slug: '', label: 'x' })).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/topic-detail-render.test.js --project unit`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```js
// srv/lib/topic-detail-render.js
import { createHash } from 'node:crypto';

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function renderTopicDetail(topic) {
  if (!topic?.slug || !topic?.label) throw new Error('renderTopicDetail: slug and label required');
  const tutorials = (topic.tutorials || []).map(t => `
      <li class="topic-tutorials__item">
        <a class="topic-tutorials__link" href="${esc(t.href)}">${esc(t.title)}</a>
        ${t.isNew ? '<span class="topic-tutorials__new">NEW</span>' : ''}
        ${t.level ? `<span class="topic-tutorials__level">${esc(t.level)}</span>` : ''}
      </li>`).join('');
  const concepts = (topic.concepts || []).map(c => `
      <li class="topic-concepts__item"><a href="/concepts/${esc(c.slug)}/">${esc(c.name)}</a></li>`).join('');
  const related = (topic.relatedTags || []).map(r => `
      <li class="topic-related__item"><a href="/topics/${esc(r.slug)}/">${esc(r.label)}</a></li>`).join('');

  const conceptsSection = concepts
    ? `<section class="topic-concepts" aria-labelledby="topic-concepts-h">
        <h2 id="topic-concepts-h">Concepts in this topic</h2>
        <ul class="topic-concepts__list" role="list">${concepts}</ul>
      </section>`
    : '';
  const relatedSection = related
    ? `<section class="topic-related" aria-labelledby="topic-related-h">
        <h2 id="topic-related-h">Related topics</h2>
        <ul class="topic-related__list" role="list">${related}</ul>
      </section>`
    : '';

  const body = `<main>
  <article class="topic-detail">
    <nav class="topic-breadcrumb" aria-label="Breadcrumb">
      <ol class="topic-breadcrumb__list">
        <li><a href="/">Home</a></li>
        <li><a href="/topics/">Topics</a></li>
        <li aria-current="page">${esc(topic.label)}</li>
      </ol>
    </nav>
    <header class="topic-detail__header">
      <h1 class="topic-detail__title">${esc(topic.label)}</h1>
      <p class="topic-detail__facet">${esc(topic.facet)}</p>
    </header>
    <section class="topic-tutorials" aria-labelledby="topic-tutorials-h">
      <h2 id="topic-tutorials-h">Tutorials</h2>
      <ul class="topic-tutorials__list" role="list">${tutorials || '<li>No tutorials yet.</li>'}</ul>
    </section>
    ${conceptsSection}
    ${relatedSection}
  </article>
</main>`;
  const contentHash = createHash('sha256').update(body).digest('hex');
  return { body, contentHash };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/topic-detail-render.test.js --project unit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add srv/lib/topic-detail-render.js test/unit/topic-detail-render.test.js
git commit -m "feat(topics): topic detail body renderer"
```

---

## Task 6: Blob publisher (`srv/lib/publish-topics.js`)

**Files:**
- Create: `srv/lib/publish-topics.js`

**Interfaces:**
- Consumes: `loadLiveTags`, `buildTopicDetailPayload` (Task 2); `renderTopicDetail` (Task 5); `composeShell` (chrome-shell).
- Produces: `renderTopicsIntoSession({ db, sessionId, helpers, priorHashes = {}, shell, deps = {} }): Promise<{ topicsSeen, topicsChanged, topicsSkipped, topicsErrored, durationMs }>`. Key = `topic-${slug}`. Meta = `{ kind: 'topic', slug, title: label, description }`.

**Reference to mirror:** `srv/lib/publish-concepts.js:78-171` — per-item loop, `composeShell` wrap, `sha256(fullDoc)`, delta-skip on `priorHashes[key] === contentHash`, `gzipSync(fullDoc).toString('base64')`, `MAX_ERROR_RATE = 0.05` abort, `BATCH_SIZE = 20` append via `helpers.appendToSession`, `loadPriorTopicHashes` filtering `slug.startsWith('topic-')`.

- [ ] **Step 1: Write the implementation**

```js
// srv/lib/publish-topics.js
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { loadLiveTags, buildTopicDetailPayload } from './topics-query.js';
import { renderTopicDetail } from './topic-detail-render.js';
import { composeShell } from './chrome-shell.js';

const BATCH_SIZE = 20;
const MAX_ERROR_RATE = 0.05;
const META_DESC_MAX = 160;

function topicMetaDescription(topic) {
  const n = topic.tutorials?.length ?? 0;
  const c = topic.concepts?.length ?? 0;
  return `${topic.label}: ${n} tutorials and ${c} concepts on developers.sap.com.`.slice(0, META_DESC_MAX);
}

export async function renderTopicsIntoSession({ db, sessionId, helpers, priorHashes = {}, shell, deps = {} }) {
  const start = Date.now();
  const live = deps.loadLiveTags ? await deps.loadLiveTags(db) : await loadLiveTags(db);
  let seen = 0, changed = 0, skipped = 0, errored = 0;
  let batch = [];
  const flush = async () => {
    if (!batch.length) return;
    await helpers.appendToSession({ sessionId, files: Object.fromEntries(batch) });
    batch = [];
  };
  for (const tag of live) {
    seen++;
    try {
      const topic = await buildTopicDetailPayload(db, tag.slug);
      if (topic.notFound || topic.error) { errored++; continue; }
      const { body } = renderTopicDetail(topic);
      const meta = { kind: 'topic', slug: topic.slug, title: topic.label, description: topicMetaDescription(topic) };
      const fullDoc = composeShell(shell, body, meta);
      const key = `topic-${topic.slug}`;
      const contentHash = createHash('sha256').update(fullDoc).digest('hex');
      if (priorHashes[key] === contentHash) { skipped++; continue; }
      batch.push([key, gzipSync(Buffer.from(fullDoc, 'utf8')).toString('base64')]);
      changed++;
      if (batch.length >= BATCH_SIZE) await flush();
    } catch {
      errored++;
      if (seen > 20 && errored / seen > MAX_ERROR_RATE) throw new Error('renderTopicsIntoSession: error rate exceeded');
    }
  }
  await flush();
  return { topicsSeen: seen, topicsChanged: changed, topicsSkipped: skipped, topicsErrored: errored, durationMs: Date.now() - start };
}
```

> **NOTE for implementer:** wiring `renderTopicsIntoSession` into the actual publish orchestration (the POST `/content/publish/render-*` chain and `loadPriorConceptHashes` equivalent) mirrors `publish-concepts.js:159-194`. Locate where `renderConceptsIntoSession` is invoked during a publish run and register a sibling `renderTopicsIntoSession` call in the same place, loading prior hashes filtered by `slug.startsWith('topic-')`. Confirm the `shell`/`helpers`/`sessionId` objects passed to concepts are reused verbatim.

- [ ] **Step 2: Commit**

```bash
git add srv/lib/publish-topics.js
git commit -m "feat(topics): per-slug HANA blob publisher (renderTopicsIntoSession)"
```

---

## Task 7: Dynamic-slug discovery in publish (`page-key-map.js` + `publish-content.ts`)

**Files:**
- Modify: `srv/lib/page-key-map.js` (add `TOPIC_KEY_PREFIX`, `isTopicKey`, `discoverTopicPages`)
- Modify: `scripts/publish-content.ts:~1058-1071` (call site)
- Test: extend `test/unit` page-key-map coverage if present; else add `test/unit/page-key-map-topics.test.js`.

**Interfaces:**
- Produces: `TOPIC_KEY_PREFIX = 'topic-'`; `isTopicKey(key): boolean`; `discoverTopicPages(hugoDir): Map<string, string>`.

> **DESIGN NOTE:** topic detail blobs are produced server-side by `renderTopicsIntoSession` (Task 6), NOT from Hugo files on disk — there is no `hugo/.../topic-<slug>/index.html`. So `discoverTopicPages` is only relevant if topics are published as file-backed blobs. Since topics are **server-rendered at publish time**, the canonical publish path is the `renderTopicsIntoSession` server call (Task 6), invoked in the publish orchestration alongside `renderConceptsIntoSession`. **Confirm which mechanism the concepts subsystem actually uses at publish time** (recon shows concepts use the *server-side* `renderConceptsIntoSession`, not `discoverPageFiles`). If concepts are server-rendered, SKIP the `discoverTopicPages` file-walker entirely and rely solely on Task 6's server call — this task then reduces to registering that call.

- [ ] **Step 1: Determine the actual publish mechanism**

Read `scripts/publish-content.ts` around the concepts publish step and `srv/lib/publish-concepts.js:159-194`. Decide:
- **(A) Server-rendered** (expected): concepts blobs are generated by a POST to `/content/publish/render-concepts`. → Register a sibling topics render call; **do not** add `discoverTopicPages`. Skip Steps 2-4 below.
- **(B) File-backed**: concepts index/detail come from disk via `discoverPageFiles`. → Add `discoverTopicPages` (Steps 2-4).

- [ ] **Step 2 (only if B): Add discovery helper**

```js
// srv/lib/page-key-map.js — near AUTHOR/ADVOCATE prefixes
export const TOPIC_KEY_PREFIX = 'topic-';
export const isTopicKey = (key) => key.startsWith(TOPIC_KEY_PREFIX);

export function discoverTopicPages(hugoDir) {
  const out = new Map();
  const base = path.join(hugoDir, 'topics');
  let entries = [];
  try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const slug = e.name;
    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) continue;
    const idx = path.join(base, slug, 'index.html');
    if (fs.existsSync(idx)) out.set(`${TOPIC_KEY_PREFIX}${slug}`, idx);
  }
  return out;
}
```

- [ ] **Step 3 (only if B): Wire the call site** in `scripts/publish-content.ts` next to the author/advocate discovery block:

```ts
const topics = discoverTopicPages(opts.hugoDir);
for (const [key, absPath] of topics) tutorials.set(key, absPath);
```

- [ ] **Step 4 (only if B): Test + commit.**

- [ ] **Step 5 (path A): Register the server render call**

Add the `renderTopicsIntoSession` invocation to the publish orchestration alongside the concepts call (mirror `publish-concepts.js`'s `createRenderConcepts`/handler registration; expose `POST /content/publish/render-topics` in `srv/server.js` if concepts has an analogous route). Load prior hashes filtering `slug.startsWith('topic-')`.

- [ ] **Step 6: Commit**

```bash
git add srv/lib/page-key-map.js scripts/publish-content.ts srv/server.js
git commit -m "feat(topics): register topic-blob publish step in content publish path"
```

---

## Task 8: Register CAP routes (`srv/server.js`)

**Files:**
- Modify: `srv/server.js`

**Interfaces:**
- Consumes: `buildTopicsTreeHandler`, `buildTopicDetailHandler` (Task 3); `topicsIndexHandler`, `createTopicListPage` (Task 4); `buildTopicDetailPayload`, `resolveTopicBySlug` (Task 2); `renderTopicDetail` (Task 5); shell loader + serve helpers already used by `/content/concepts/:slug`.

**Reference to mirror:** imports `server.js:15-37`; `/build/*` registrations `:296-306`; `/content/concepts/:slug` wrapper `:503-528`; `/content/concepts-index` `:533`.

- [ ] **Step 1: Add imports** (top of `srv/server.js`, with sibling imports)

```js
import { buildTopicsTreeHandler, buildTopicDetailHandler } from './lib/build-topics.js';
import { topicsIndexHandler } from './lib/topic-list-page.js';
import { resolveTopicBySlug, buildTopicDetailPayload } from './lib/topics-query.js';
import { renderTopicDetail } from './lib/topic-detail-render.js';
```

- [ ] **Step 2: Register build feeds** (next to `:298-300`)

```js
app.get('/build/topics-tree', buildTopicsTreeHandler);
app.get('/build/topics/:slug', buildTopicDetailHandler);
```

- [ ] **Step 3: Register content index** (next to `:533`)

```js
app.get('/content/topics-index', topicsIndexHandler);
```

- [ ] **Step 4: Register content detail** — serves the published `topic-<slug>` blob, with legacy/retired redirect fallthrough. Mirror the `/content/concepts/:slug` wrapper (`:503-528`) that rewrites `req.params.slug = \`concept-${lower}\`` then delegates to `serveHandler`. For topics, resolve legacy/retired slugs to a 301 before the blob lookup:

```js
app.get('/content/topics/:slug', async (req, res, next) => {
  let raw = String(req.params.slug || '').replace(/\.html$/, '');
  const lower = raw.toLowerCase();
  if (raw !== lower) { res.redirect(301, `/topics/${lower}/`); return; }
  // legacy -N / retired resolution
  try {
    const db = await cds.connect.to('db');
    const { tag, redirectTo } = await resolveTopicBySlug(db, lower);
    if (!tag && redirectTo) { res.redirect(301, redirectTo); return; }
    if (tag && redirectTo) { res.redirect(301, redirectTo); return; }
  } catch { /* fail-open to blob lookup */ }
  // delegate to the shared blob serve handler with topic- key prefix (same as concepts)
  req.params.slug = `topic-${lower}`;
  return serveHandler(req, res, next);
});
```

> **NOTE for implementer:** `serveHandler` is the same content-store serve function `/content/concepts/:slug` delegates to (`server.js:526-527`). Confirm its exact name/signature at that line and match it. If a served `topic-<slug>` blob is missing (never published), `serveHandler` will 404 — acceptable; the resolve step above catches *known-live-but-unpublished* only insofar as it doesn't redirect them. For a fully fail-open detail path, when `serveHandler` would 404 AND the slug resolves to a live tag, fall back to on-the-fly render:
> ```js
> // optional fallback inside a wrapper around serveHandler's 404
> const payload = await buildTopicDetailPayload(db, lower);
> if (!payload.notFound) { /* renderTopicDetail + composeShell + send */ }
> ```
> Decide based on whether concepts has an equivalent live-render fallback; prefer parity.

- [ ] **Step 5: Verify build feeds live**

```bash
cds watch &   # or npm run dev:hybrid for real HANA
sleep 8
curl -s http://localhost:4004/build/topics-tree | jq '.tree | length, .error'
curl -s http://localhost:4004/build/topics/sap-hana-cloud | jq '{tutorials: (.tutorials|length), concepts: (.concepts|length), error}'
```
Expected: tree length ≥ 1, `error: null`; detail returns tutorials/concepts arrays (may be empty in a bare in-memory DB — verify against seeded/hybrid data).

- [ ] **Step 6: Commit**

```bash
git add srv/server.js
git commit -m "feat(topics): register /build/topics-tree, /build/topics/:slug, /content/topics-index, /content/topics/:slug"
```

---

## Task 9: Approuter routes + search redirect (`approuter/xs-app.json`)

**Files:**
- Modify: `approuter/xs-app.json`

**Reference:** concepts index route `:546-550`, detail route `:552-556`, `/build/*` allow-list `:399`, current `/topics/` route `:585`, `/search/` OData route `:375-376`, catch-all `:605`.

- [ ] **Step 1: Add `topics-tree` to the `/build/*` allow-list alternation** (`:399`) — insert `|topics-tree` into the group (keep `topics-gallery` until Task 11 retires it, or replace it):

```json
{ "source": "^/build/(breadcrumb-context|catalog|co-completions|concepts|homepage-shelves|kg-stats|mission|my-progress|navigator|repo-catalog|slug-mapping|tag-labels|topics-gallery|topics-tree|topics)(/.*)?(\\?.*)?$", "target": "/build/$1$2$3", "destination": "srv-api", "authenticationType": "none" }
```

> `topics` (bare) covers `/build/topics/:slug`; `topics-tree` covers the index feed. Ensure `topics` does not shadow `topics-tree` — regex alternation is ordered but both are matched as whole path segments by the `(/.*)?` boundary, so list `topics-tree` before `topics`.

- [ ] **Step 2: Replace the `page-topics` index route** (`:585`) with the dynamic index route, and add the detail route immediately after. Both MUST precede the catch-all `^(.*)$` (`:605`):

```json
{ "source": "^/topics/?(\\?.*)?$", "target": "/content/topics-index$1", "destination": "srv-api", "authenticationType": "none" },
{ "source": "^/topics/(.*)$", "target": "/content/topics/$1", "destination": "srv-api", "authenticationType": "none" }
```

- [ ] **Step 3: Add the `/search/` → `/tutorial-navigator/` redirect, scoped to bare `/search/` + query only** so it does NOT shadow the OData `SearchService` routes (`^/search/(.*)$` at `:375-376`). Place this redirect BEFORE the OData `/search/` route:

```json
{ "source": "^/search/?(\\?.*)?$", "target": "/tutorial-navigator/$1", "status": 301, "authenticationType": "none" }
```

> Verify `/search/SearchableItems` etc. still route to `srv-api` (the `^/search/(.*)$` route must remain and must be reached for non-empty paths). Test both after deploy.

- [ ] **Step 4: Validate JSON**

Run: `jq . approuter/xs-app.json > /dev/null && echo OK`
Expected: `OK` (no parse error).

- [ ] **Step 5: Commit**

```bash
git add approuter/xs-app.json
git commit -m "feat(topics): approuter dynamic /topics routes + /search 301 to navigator"
```

---

## Task 10: Progressive-enhancement island (`hugo-apps/src/topics-tree/`)

**Files:**
- Create: `hugo-apps/src/topics-tree/main.ts`, `hugo-apps/src/topics-tree/App.vue`
- Modify: `hugo-apps/vite.config.ts:~316` (add entry)

**Interfaces:**
- Consumes: server-embedded `<script type="application/json" id="topics-tree-data">` (Task 4) and mount root `#topics-tree-root`.
- Produces: island bundle `topics-tree` in the Vite manifest → picked up by `scripts/build-island-manifest.cjs` → `islandSrc('topics-tree')`.

- [ ] **Step 1: Register the entry** in `hugo-apps/vite.config.ts` `rollupOptions.input` (next to `'concepts-filter'` `:316`):

```ts
'topics-tree': resolve(__dirname, 'src/topics-tree/main.ts'),
```

- [ ] **Step 2: Write the island**

```ts
// hugo-apps/src/topics-tree/main.ts
// Progressive enhancement over the server-rendered tree. Adds a type-ahead
// filter + expand/collapse-all. Inert until JS loads; the server markup is
// fully functional without it.
function boot() {
  const root = document.getElementById('topics-tree-root');
  const input = document.getElementById('topics-filter-input') as HTMLInputElement | null;
  if (!root || !input) return;

  const items = Array.from(root.querySelectorAll('li'));
  const details = Array.from(root.querySelectorAll('details')) as HTMLDetailsElement[];

  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    if (!q) {
      items.forEach((li) => (li.style.display = ''));
      return;
    }
    // Show any li whose text matches; open ancestor details.
    items.forEach((li) => {
      const match = (li.textContent || '').toLowerCase().includes(q);
      li.style.display = match ? '' : 'none';
    });
    // Reveal matches by opening every details that contains a visible match.
    details.forEach((d) => {
      const hasVisible = Array.from(d.querySelectorAll('li')).some((li) => (li as HTMLElement).style.display !== 'none');
      d.open = hasVisible;
      (d.closest('li') as HTMLElement | null && ((d.closest('li') as HTMLElement).style.display = hasVisible ? '' : 'none'));
    });
  });

  // Deep-link: open the node whose slug is in the hash (#topic=<slug>).
  const m = location.hash.match(/topic=([a-z0-9-]+)/);
  if (m) {
    const link = root.querySelector(`a[href="/topics/${m[1]}/"]`);
    let el = link?.closest('details') as HTMLDetailsElement | null;
    while (el) { el.open = true; el = el.parentElement?.closest('details') as HTMLDetailsElement | null; }
    link?.scrollIntoView({ block: 'center' });
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
```

> **NOTE:** this island is plain TS DOM enhancement (no Vue component tree needed — the tree HTML is server-rendered). An `App.vue` is unnecessary; delete it from the file list if you keep this approach. If you prefer a Vue mount for future features, mirror `concepts-filter`'s `createApp(...).mount(...)` pattern instead. Keep it inert-until-loaded either way.

- [ ] **Step 3: Build + verify the island lands in the manifest**

```bash
cd hugo-apps && npx vite build
cd .. && node scripts/build-island-manifest.cjs
jq '."topics-tree"' hugo/data/island_manifest.json
```
Expected: a `/js/topics-tree-<hash>.js` path (non-null).

- [ ] **Step 4: Commit**

```bash
git add hugo-apps/src/topics-tree hugo-apps/vite.config.ts
git commit -m "feat(topics): topics-tree progressive-enhancement island (filter + deep-link)"
```

---

## Task 11: Retire legacy topics + search-form interim fix

**Files:**
- Modify (interim, then delete): `hugo/layouts/topics/list.html`
- Delete: `hugo/content/topics/btp-basics.md`, `hugo/content/topics/cap-fundamentals.md`, `hugo/layouts/topics/list.html`, `hugo/layouts/topics/single.html`, `hugo/data/topics_gallery.json`, `scripts/fetch-topics-gallery.ts`
- Sweep: orphaned tests referencing `topics_gallery` / `build-topics-gallery` / `fetch-topics-gallery` / the deleted layouts.

> **KEEP:** `srv/lib/build-topics-gallery.js` + `/build/topics-gallery` + `hugo/data/topic_clusters.json` + `hugo/data/featured_topics.json` are the **homepage** band — untouched. Only the `/topics/` section is retired. Confirm no homepage code imports the deleted files.

- [ ] **Step 1: Grep for consumers of what you're deleting**

```bash
grep -rn "topics_gallery\|fetch-topics-gallery\|layouts/topics\|topics/single\|topics/list" \
  --include=*.js --include=*.ts --include=*.cjs --include=*.html --include=*.json \
  scripts srv test hugo package.json | grep -v node_modules
```
Record every hit; each must be updated or deleted in this same commit.

- [ ] **Step 2: Remove the `fetch-topics-gallery` build wiring** — check `package.json` scripts and `scripts/fetch-tutorials.ts` / `build:*` chains for a `fetch-topics-gallery` invocation; remove it. Confirm nothing else calls it.

- [ ] **Step 3: Delete the files**

```bash
git rm hugo/content/topics/btp-basics.md hugo/content/topics/cap-fundamentals.md \
       hugo/layouts/topics/list.html hugo/layouts/topics/single.html \
       hugo/data/topics_gallery.json scripts/fetch-topics-gallery.ts
```

- [ ] **Step 4: Delete/adjust orphaned tests** found in Step 1 (per the deleting-source-file rule — sweep in the same commit).

- [ ] **Step 5: Verify build still green**

```bash
npm run fetch-tutorials && npm run build:all 2>&1 | tail -30
```
Expected: no reference-to-deleted-file errors; Hugo build completes. `/topics/` no longer produced by Hugo (now CAP-served).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore(topics): retire legacy topics_gallery section (homepage band untouched)"
```

---

## Task 12: srv-qa cp-list audit (`.deploy/mta.yaml`)

**Files:**
- Modify: `.deploy/mta.yaml` (`srv-qa` module `cp` list)

- [ ] **Step 1: Walk transitive `./` imports from `content-store.js`** and confirm reachability of the new modules. `publish-topics.js` is reached from the publish path; if `content-store.js` (or anything it imports) now transitively imports any of `topics-query.js`, `topic-slug.js`, `topic-detail-render.js`, `publish-topics.js`, `topic-list-page.js`, `build-topics.js`, they must all appear in the `srv-qa` `cp` list.

```bash
grep -rn "from './topic\|from './build-topics\|from './publish-topics" srv/lib/content-store.js srv/lib/*.js
```

- [ ] **Step 2: Add every reachable new `srv/lib/*` file to the `srv-qa` `cp` list** in `.deploy/mta.yaml`, matching the existing concepts entries (`concept-list-page.js`, `published-concepts-query.js`, `chrome-shell.js`, etc.). Also confirm no NEW npm package is introduced that srv-qa's stripped deps lack (this plan adds none — all imports are `node:*` + existing `@sap/cds`).

- [ ] **Step 3: Validate**

```bash
grep -n "topic" .deploy/mta.yaml
```
Expected: each reachable new file listed under `srv-qa`.

- [ ] **Step 4: Commit**

```bash
git add .deploy/mta.yaml
git commit -m "chore(topics): add topics srv/lib modules to srv-qa cp list"
```

---

## Task 13: e2e + smoke coverage

**Files:**
- Create: `test/e2e/topics.spec.ts`
- Extend: existing smoke suite (add `/topics/` + a `/topics/<slug>/` route assertion).
- Create/extend: `test/hybrid/topics-publish-serve.test.js`.

**Interfaces:** consumes deployed endpoints; self-skips without `SMOKE_BASE_URL` (e2e convention).

- [ ] **Step 1: e2e spec (post-deploy, self-skipping)**

```ts
// test/e2e/topics.spec.ts
import { test, expect } from '@playwright/test';

const BASE = process.env.SMOKE_BASE_URL;
test.skip(!BASE, 'SMOKE_BASE_URL not set');

test('topics index renders a tree and search links to navigator', async ({ page }) => {
  await page.goto(`${BASE}/topics/`);
  await expect(page.locator('#topics-tree-root')).toBeVisible();
  await expect(page.locator('details summary').first()).toBeVisible();
  await expect(page.locator('a[href="/tutorial-navigator/"]').first()).toBeVisible();
});

test('a topic leaf navigates to a detail page with tutorials', async ({ page }) => {
  await page.goto(`${BASE}/topics/`);
  const firstTopic = page.locator('#topics-tree-root a[href^="/topics/"]').first();
  await firstTopic.click();
  await expect(page).toHaveURL(/\/topics\/[a-z0-9-]+\//);
  await expect(page.locator('h1')).toBeVisible();
  await expect(page.locator('.topic-tutorials, main')).toBeVisible();
});

test('/search/?q= redirects to the navigator', async ({ page }) => {
  await page.goto(`${BASE}/search/?q=cap`);
  await expect(page).toHaveURL(/\/tutorial-navigator\//);
});
```

- [ ] **Step 2: Hybrid round-trip** (`--project hybrid`, real HANA via `cds bind --exec`)

```js
// test/hybrid/topics-publish-serve.test.js
import { describe, it, expect } from 'vitest';
// Assert /build/topics-tree and /build/topics/:slug are non-empty against real
// tag + KG data; publish→serve round-trip for a sample topic blob; slug lowercased.
// Mirror the structure of test/hybrid/page-publish-serve.test.js.
```

Fill this in mirroring `test/hybrid/page-publish-serve.test.js` (publish a `topic-<slug>` blob, GET `/content/topics/<slug>`, assert 200 + `X-Content-Source`).

- [ ] **Step 3: Smoke** — add to the existing smoke suite: `GET /topics/` → 200 with `x-content-source`; `GET /topics/<known-live-slug>/` → 200. Use a slug guaranteed live (derive from `/build/topics-tree` at test time rather than hardcoding).

- [ ] **Step 4: Run what's runnable locally**

```bash
npx vitest run test/unit --project unit
# hybrid requires cf login + cds bind:
npm run test:hybrid -- topics-publish-serve 2>&1 | tail -20
```

- [ ] **Step 5: Commit**

```bash
git add test/e2e/topics.spec.ts test/hybrid/topics-publish-serve.test.js
git commit -m "test(topics): e2e + hybrid + smoke coverage for tag-tree topics"
```

---

## Task 14: Full-suite gate + PR

- [ ] **Step 1: Run the unit suite**

```bash
npm test 2>&1 | tail -30
```
Expected: green (fix any regressions from Task 11 deletions before proceeding).

- [ ] **Step 2: Confirm branch base + push**

```bash
git fetch origin
git log --oneline origin/DEV -1        # confirm base
git push -u origin worktree-tag-tree-topics
```

- [ ] **Step 3: Open a DRAFT PR targeting DEV**

```bash
gh pr create --base DEV --draft \
  --title "feat(topics): tag-tree topics — CAP-served index + detail, concept enrichment, search fix" \
  --body "Implements docs/superpowers/specs/2026-09-01-tag-tree-topics-design.md. Rebuilds /topics/ to concept-parity: stable SAP-tag slugs, CAP tree index + per-slug HANA-blob detail, deterministic concept enrichment via TutorialConceptLinks, /search/ → navigator redirect. Legacy topics_gallery section retired (homepage band untouched). Deploy: full MTA (approuter route + srv/lib changes); topic blobs publish via gh workflow rebuild-content.yml."
```

- [ ] **Step 4: Report to Tom** — PR URL, deploy scope (full MTA: approuter + srv/lib), and that topic-blob content publish runs via `gh workflow run rebuild-content.yml` post-deploy.

---

## Self-Review

**Spec coverage:**
- §1 defect 1 (404s) → Tasks 8, 9 (dynamic `/topics/(.*)` route + CAP detail handler). ✓
- §1 defect 2 (empty concepts) → Task 2 `buildTopicDetailPayload` concept-enrichment via `TutorialConceptLinks` replacing the `KgCommunity` join. ✓
- §1 defect 3 (search) → Tasks 9, 11 (approuter 301 + form repoint). ✓
- §1 link-rot (LLM Louvain slugs) → Task 1 stable tag-hierarchy slugs. ✓
- §3 slug scheme + collision → Task 1 (`buildTopicSlugMap`, tested). ✓
- §4.1 `/build/topics-tree` → Tasks 2, 3, 8. ✓
- §4.2 `/build/topics/:slug` → Tasks 2, 3, 8. ✓
- §4.3 retire gallery from `/topics/` (keep homepage) → Task 11. ✓
- §5 CAP-rendered tree index + island → Tasks 4, 10. ✓
- §5.1 CAP detail renderer → Tasks 5, 6, 8. ✓
- §6 serve/publish backbone → Tasks 6, 7, 8, 9, 12. ✓
- §6.1 legacy `-N` / retired 301 → Tasks 2 (`resolveTopicBySlug`), 8. ✓
- §7 search fix → Tasks 9, 11. ✓
- §8 testing (unit/hybrid/e2e/smoke) → Tasks 1-5 unit, 13 hybrid/e2e/smoke. ✓
- §9 rollout (branch off DEV, fail-open) → Global Constraints + Task 14; fail-open in Tasks 2, 4. ✓

**Placeholder scan:** Code steps carry real code. Two deliberate implementer-decision notes (Task 7 path A/B, Task 8 serveHandler name/fallback) are flagged because the exact concepts publish/serve wiring must be read from source at execution time — each names the precise reference lines and the decision rule, not a vague "handle it." Task 2 flags the one unverified column name (`timeToComplete`) with resolution steps.

**Type consistency:** `Tag` shape (Task 1) consumed unchanged in Tasks 2/6. `buildTopicDetailPayload` return shape (Task 2) consumed by `renderTopicDetail` (Task 5: `{slug,label,facet,tutorials,concepts,relatedTags}`) and `renderTopicsIntoSession` (Task 6). Tree node shape (Task 2) consumed by `renderTopicListBody` (Task 4) and the island's embedded JSON (Task 10). `topic-<slug>` key prefix consistent across Tasks 6, 7, 8. Meta `{kind:'topic'|'topics-index'}` consistent across Tasks 4 (chrome-shell cases), 5, 6.

**Open questions from spec** (§10) resolved by design defaults: bare-leaf slug + qualify-on-collision (Task 1); retired → `/topics/` unless legacy `-N` base resolves (Task 2); no left-rail (index-tree + relatedTags only); CAP-only, no Hugo topics data file (Task 11 retires the Hugo section). No task needed for the deferred items.
