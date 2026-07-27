# Concepts page scale: virtualization + CAP takeover — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/concepts/` scale from ~700 to 5k-10k concepts by moving the list page to CAP with SSR-shell + client virtualization, and moving concept detail rendering out of Hugo into CAP entirely.

**Architecture:** Two independent workstreams sharing the `PublishedConcepts` read path and one rollback flag. Thread A: CAP-rendered list page with top-100 SSR cards + embedded JSON + `vue-virtual-scroller` windowing. Thread B: `POST /content/publish/render-concepts` phase in `publish-content.ts` calls a new CAP endpoint that queries `PublishedConcepts` + phase-4 tables and writes `concept-<slug>` BLOBs into `ContentFiles` via existing session helpers.

**Tech Stack:** Node.js 22, CAP (Node.js runtime), HANA Cloud, Vue 3 + Vite (hugo-apps island), `vue-virtual-scroller`, EJS templating, TypeScript, Vitest.

---

## Status & errata (re-verified against `main` 2026-07-27, #1327)

The design + Task 1 were authored 2026-07-08 on a branch that never merged. When salvaged and re-verified against current `main`, several assumptions proved stale. This section is the source of truth where it disagrees with the per-task text below.

**Progress:**
- ✅ **Task 1 — `renderConceptDetail`** — DONE, merged in PR #1330 (`srv/lib/concept-detail-render.js`, `srv/lib/templates/concept-detail.ejs`, 10 unit tests, `ejs` promoted to direct prod dep). Tasks 2–6 below are re-specced against real interfaces.

**Corrections that supersede the original per-task prose:**

1. **`buildConceptsPayload(db)` already exists** (`srv/lib/published-concepts-query.js`) and is the single query both threads reuse — do NOT write new `PublishedConcepts`/phase-4 queries. It returns `{ concepts: [{ slug, name, description, teaches:[{slug,title}], requires:[{slug,name}], requiredBy:[{slug,name}], relatedTo:[{slug,name}], learningJourneys:[…], blogPosts:[…], discoveryMissions:[…], videos:[…], apiDocs:[…], samples:[…], helpDocs:[…], communityEvents:[…] }], generatedAt }`. Powers today's `GET /build/concepts`.
2. **Concept field is `name`, not `title`.** Tutorial/journey/blog/etc. cards use `title`; concept-to-concept refs (`requires`/`requiredBy`/`relatedTo`) use `name`. Task 1's template + tests already reflect this. The original plan's `concept-detail-render` interface said `{title}` — wrong for concepts.
3. **`PublishedConcepts` projection is `{ID, slug, name, description, publishedAt, publishedBy, status}`** (`srv/knowledge-graph-service.cds:92`) — no `teachesCount`/`tutorialCoverageCount`/`title`. Per-concept tutorial count = `teaches.length` from the payload (derived from `TutorialConceptLinks` where `predicate='teaches'`). `GraphMetadata.teachesCount` is a global, not per-concept.
4. **List-card wire shape** (from `hugo/layouts/concepts/list.html` + `filter-logic.ts:ConceptCard`): `{ slug, name, description (truncate 140 for display), tutorialCount }` + derived `firstLetter`. That is the slim JSON the list endpoint embeds.
5. **Island mounts by ID, not `data-app`.** `list.html` uses `#concepts-filter-root/-list/-controls/-count/-empty` and loads `/js/concepts-filter.js`. `filter-logic.ts` already exposes `applyFilters`, `availableLetters`, `toQueryString`/`fromQueryString`, `ConceptCard`, `FilterState`, `SortKey` operating on an **array** — Task 4 is a mount/render rewrite, not a filter-logic rewrite.
6. **`vue-virtual-scroller@3.0.4` is in root `package.json`** but absent from `hugo-apps/package.json` — Task 4 adds it there.
7. **Publish client is `scripts/lib/publish-client.ts`** exposing `beginSession`/`appendBatch`/`commitSession`/`abortSession`. `appendBatch({sessionId, files, metadata, bodyTexts, branchSpecs?, sources?})`. Server-side session helpers are `createSessionHelpers({namespace})` → `beginPublishSession`/`appendToSession`/`commitSession`/`abortSession` (`srv/lib/content-publish-session.js`).
8. **Concept BLOBs already flow through publish today** via `concept-<slug>` keys walked from `hugo/public/concepts/<slug>/index.html` (`scripts/publish-content.ts:100-135`). Thread B *replaces the Hugo-walk source* with CAP-rendered BLOBs — the key convention, serve path, and delta machinery are unchanged.
9. **Serve path** `GET /content/concepts/:slug` (`srv/server.js:400`) canonicalises + delegates to `serveHandler` with `concept-` prefix — reused as-is.
10. **AppRouter route to flip is `approuter/xs-app.json:408-409`** (`^/concepts/?$` → `/concepts/index.html`). The detail route `^/concepts/(.*)$ → /content/concepts/$1` (line 414) stays.
11. **`ConceptRank` sidecar** = `{key slug String(80), score Double, computedAt}` (`db/knowledge-graph.cds:189`) — top-100 SSR ranking source; fail-open to alphabetical.

## Global Constraints

- **DEV only.** PROD cutover is end-of-July 2026 — out of scope.
- **No changes to `PublishedConcepts` projection** in `srv/knowledge-graph-service.cds:72-75`.
- **No changes to phase-4 link tables.**
- **No changes to `/content/concepts/:slug` serve path** in `srv/server.js:332` — reused as-is.
- **Legacy Hugo concept path stays dormant** (guarded by `LEGACY_CONCEPT_RENDER=true`), not deleted.
- **BLOB fetches from HANA use raw SQL, not CDS QL.** Reference `srv/lib/content-store.js:1043-1048` — mixing LOB and non-LOB columns in one CDS QL query is banned per project gotchas.
- **All new concept BLOBs use the `concept-<slug>` key prefix** in `ContentFiles` (existing convention).
- **The publish session order is: begin → tutorials appendBatch × N → renderConcepts → commit.** Render-concepts runs after ALL tutorial batches so the `__shell__` sidecar is available.
- **Snapshot parity test is a required PR check** before Step 5 lands.
- **Every new/modified file gets an accompanying test.** TDD: failing test first, then code.
- **Commits after every step.** Small commits, imperative subject line, `feat(concepts):` / `test(concepts):` / `chore(concepts):` prefix.

---

## File Structure

**New files:**
- `srv/lib/concept-list-page.js` — `GET /content/concepts-index` handler; reads `PublishedConcepts`, renders shell, owns version-keyed cache
- `srv/lib/concept-detail-render.js` — pure function: `(concept, phase4, shell) → gzipped HTML buffer`
- `srv/lib/publish-concepts.js` — orchestrates `POST /content/publish/render-concepts`
- `srv/lib/templates/concept-detail.ejs` — HTML template mirroring `hugo/layouts/concepts/single.html`
- `srv/lib/templates/concept-list.ejs` — HTML shell template for the list page
- `hugo-apps/src/concepts-filter/ConceptCard.vue` — extracted card component
- `test/unit/concept-detail-render.test.js`
- `test/unit/concept-list-page.test.js`
- `test/unit/publish-concepts.test.js`
- `test/hybrid/concept-render-hybrid.test.js`
- `test/snapshot/concept-parity.test.js`
- `test/fixtures/concept-parity-slugs.json`
- `test/smoke/concepts-page.test.js`

**Modified files:**
- `srv/server.js:19,321,332` — new route registrations
- `hugo-apps/src/concepts-filter/App.vue` — rewrite for JSON-array + virtualization
- `hugo-apps/src/concepts-filter/filter-logic.ts` — minor extension (existing shape is close)
- `hugo-apps/package.json` — add `vue-virtual-scroller`
- `hugo/layouts/concepts/list.html` — trimmed to preserve as dormant fallback only
- `approuter/xs-app.json:349-353` — flip `/concepts/?$` route to CAP
- `scripts/publish-content.ts:1092-1101` — insert `renderConcepts` phase
- `scripts/lib/publish-client.ts` — add `renderConceptsPhase` client function
- `scripts/fetch-concepts.ts` — early-exit unless `LEGACY_CONCEPT_RENDER=true`
- `.github/workflows/rebuild-content.yml` — add `legacy-concept-render` input; guard fetch-concepts step

---

## Task 1: `concept-detail-render.js` — pure render function + unit tests ✅ DONE (PR #1330)

> Shipped. Interface as built: `renderConceptDetail(concept, phase4, shell) → { html, gzipped, contentHash }` where `concept` uses `name` (not `title`) and relationship arrays are `{slug,title}` for `teaches` / `{slug,name}` for concept refs. Template mirrors `single.html`. See errata #1–#2. The steps below are the original spec, retained for provenance.

**Files:**
- Create: `srv/lib/concept-detail-render.js`
- Create: `srv/lib/templates/concept-detail.ejs`
- Create: `test/unit/concept-detail-render.test.js`
- Create: `test/fixtures/concept-render-shell.html` (minimal shell fragments for tests)

**Interfaces:**
- Consumes: nothing yet
- Produces: `async function renderConceptDetail(concept, phase4, shell) → { html: string, gzipped: Buffer, contentHash: string }`
  - `concept`: `{slug, name, description, teaches, requires, requiredBy, relatedTo}`
  - `phase4`: `{learningJourneys, blogPosts, discoveryMissions, videos, apiDocs, samples, helpDocs, communityEvents}` — each an array
  - `shell`: `{shellHead: string, shellHeader: string, shellFooter: string}`
  - `contentHash`: hex SHA-256 of the un-gzipped HTML bytes

- [ ] **Step 1: Add `ejs` as a direct dependency**

Currently transitive only per `package-lock.json:4393`. Add explicit dep.

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/concepts-scale-design
npm install ejs@^3.1.10 --save
```

Expected: `package.json` `dependencies` gains `"ejs": "^3.1.10"`; no lockfile churn beyond that.

- [ ] **Step 2: Write the failing test — empty phase-4 arrays**

Create `test/unit/concept-detail-render.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import { renderConceptDetail } from '../../srv/lib/concept-detail-render.js';

const SHELL = {
  shellHead: '<link rel="stylesheet" href="/css/site.css">',
  shellHeader: '<header>SAP</header>',
  shellFooter: '<footer>© SAP</footer>',
};

describe('renderConceptDetail', () => {
  it('renders a concept with empty phase-4 arrays — omits all optional sections', async () => {
    const concept = {
      slug: 'cap',
      name: 'Cloud Application Programming Model',
      description: 'SAP CAP framework.',
      teaches: [],
      requires: [],
      requiredBy: [],
      relatedTo: [],
    };
    const phase4 = {
      learningJourneys: [], blogPosts: [], discoveryMissions: [],
      videos: [], apiDocs: [], samples: [], helpDocs: [], communityEvents: [],
    };
    const result = await renderConceptDetail(concept, phase4, SHELL);
    expect(result.html).toContain('<h1>Cloud Application Programming Model</h1>');
    expect(result.html).toContain('SAP CAP framework.');
    expect(result.html).not.toContain('data-kg-section="learning-journeys"');
    expect(result.html).not.toContain('Prerequisites');
    expect(result.gzipped).toBeInstanceOf(Buffer);
    expect(result.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/unit/concept-detail-render.test.js`
Expected: FAIL with `Cannot find module '../../srv/lib/concept-detail-render.js'`.

- [ ] **Step 4: Create the EJS template**

Create `srv/lib/templates/concept-detail.ejs` with the shape below. Study `hugo/layouts/concepts/single.html:13-450` and mirror it — same class names (`data-kg-section` attributes preserved for telemetry), same section iteration order.

```ejs
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title><%= name %> - SAP Developers</title>
  <meta name="description" content="<%= description %>">
  <link rel="canonical" href="/concepts/<%= slug %>/">
  <meta property="og:title" content="<%= name %>">
  <meta property="og:type" content="article">
  <meta property="og:url" content="/concepts/<%= slug %>/">
  <%- shellHead %>
</head>
<body>
  <%- shellHeader %>
  <main class="concept-detail" data-concept-slug="<%= slug %>">
    <nav class="breadcrumb"><a href="/">Home</a> / <a href="/concepts/">Concepts</a> / <%= name %></nav>
    <h1><%= name %></h1>
    <p class="concept-description"><%= description %></p>

    <% if (teaches.length) { %>
      <section data-kg-section="teaches">
        <h2>Tutorials that teach this</h2>
        <ul>
        <% teaches.forEach(t => { %>
          <li><a href="/tutorials/<%= t.slug %>/"><%= t.title %></a></li>
        <% }) %>
        </ul>
      </section>
    <% } %>

    <% if (learningJourneys.length) { %>
      <section data-kg-section="learning-journeys">
        <h2>Learning journeys</h2>
        <ul>
        <% learningJourneys.forEach(lj => { %>
          <li><a href="<%= lj.url %>"><%= lj.title %></a><% if (lj.level) { %> — <%= lj.level %><% } %><% if (lj.durationHours) { %> · <%= lj.durationHours %>h<% } %></li>
        <% }) %>
        </ul>
      </section>
    <% } %>

    <% if (helpDocs.length) { %>
      <section data-kg-section="help-docs">
        <h2>Help docs</h2>
        <ul>
        <% helpDocs.forEach(hd => { %>
          <li><a href="<%= hd.url %>"><%= hd.title %></a><% if (hd.sourceLabel) { %> <span class="source"><%= hd.sourceLabel %></span><% } %></li>
        <% }) %>
        </ul>
      </section>
    <% } %>

    <% if (blogPosts.length) { %>
      <section data-kg-section="blog-posts">
        <h2>Blog posts</h2>
        <ul>
        <% blogPosts.forEach(bp => { %>
          <li><a href="<%= bp.url %>"><%= bp.title %></a><% if (bp.authorName) { %> — <%= bp.authorName %><% } %></li>
        <% }) %>
        </ul>
      </section>
    <% } %>

    <% if (discoveryMissions.length) { %>
      <section data-kg-section="discovery-missions">
        <h2>Discovery missions</h2>
        <ul>
        <% discoveryMissions.forEach(dm => { %>
          <li><a href="<%= dm.url %>"><%= dm.title %></a><% if (dm.effortLevel) { %> — <%= dm.effortLevel %><% } %></li>
        <% }) %>
        </ul>
      </section>
    <% } %>

    <% if (videos.length) { %>
      <section data-kg-section="videos">
        <h2>Videos</h2>
        <ul>
        <% videos.forEach(v => { %>
          <li><a href="<%= v.url %>"><%= v.title %></a><% if (v.channelTitle) { %> — <%= v.channelTitle %><% } %></li>
        <% }) %>
        </ul>
      </section>
    <% } %>

    <% if (apiDocs.length) { %>
      <section data-kg-section="api-docs">
        <h2>API docs</h2>
        <ul>
        <% apiDocs.forEach(a => { %>
          <li><a href="<%= a.url %>"><%= a.title %></a><% if (a.apiType) { %> — <%= a.apiType %><% } %></li>
        <% }) %>
        </ul>
      </section>
    <% } %>

    <% if (samples.length) { %>
      <section data-kg-section="samples">
        <h2>Code samples</h2>
        <ul>
        <% samples.forEach(s => { %>
          <li><a href="<%= s.url %>"><%= s.title %></a><% if (s.language) { %> — <%= s.language %><% } %></li>
        <% }) %>
        </ul>
      </section>
    <% } %>

    <% if (communityEvents.length) { %>
      <section data-kg-section="community-events">
        <h2>Community events</h2>
        <ul>
        <% communityEvents.forEach(e => { %>
          <li><a href="<%= e.url %>"><%= e.title %></a><% if (e.location) { %> — <%= e.location %><% } %></li>
        <% }) %>
        </ul>
      </section>
    <% } %>

    <% if (requires.length) { %>
      <section data-kg-section="requires">
        <h2>Prerequisites</h2>
        <ul>
        <% requires.forEach(r => { %>
          <li><a href="/concepts/<%= r.slug %>/"><%= r.name %></a></li>
        <% }) %>
        </ul>
      </section>
    <% } %>

    <% if (requiredBy.length) { %>
      <section data-kg-section="required-by">
        <h2>Required by</h2>
        <ul>
        <% requiredBy.forEach(r => { %>
          <li><a href="/concepts/<%= r.slug %>/"><%= r.name %></a></li>
        <% }) %>
        </ul>
      </section>
    <% } %>

    <% if (relatedTo.length) { %>
      <section data-kg-section="related-to">
        <h2>Related</h2>
        <ul>
        <% relatedTo.forEach(r => { %>
          <li><a href="/concepts/<%= r.slug %>/"><%= r.name %></a></li>
        <% }) %>
        </ul>
      </section>
    <% } %>

    <div class="kg-telemetry" data-render-source="cap" hidden></div>
  </main>
  <%- shellFooter %>
</body>
</html>
```

- [ ] **Step 5: Create the render module**

Create `srv/lib/concept-detail-render.js`:

```javascript
import ejs from 'ejs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = join(__dirname, 'templates', 'concept-detail.ejs');
const TEMPLATE_SRC = readFileSync(TEMPLATE_PATH, 'utf-8');
const TEMPLATE = ejs.compile(TEMPLATE_SRC, { filename: TEMPLATE_PATH });

/**
 * Renders one concept detail page.
 * Pure function of its inputs — no I/O beyond the compiled template.
 *
 * @param {object} concept  {slug,name,description,teaches[],requires[],requiredBy[],relatedTo[]}
 * @param {object} phase4   {learningJourneys[],blogPosts[],discoveryMissions[],videos[],apiDocs[],samples[],helpDocs[],communityEvents[]}
 * @param {object} shell    {shellHead,shellHeader,shellFooter}
 * @returns {{html: string, gzipped: Buffer, contentHash: string}}
 */
export function renderConceptDetail(concept, phase4, shell) {
  if (!concept || typeof concept.slug !== 'string' || typeof concept.name !== 'string') {
    throw new Error('renderConceptDetail: concept.slug and concept.name are required');
  }
  if (!shell || typeof shell.shellHead !== 'string') {
    throw new Error('renderConceptDetail: shell fragments missing — __shell__ sidecar not yet published');
  }
  const ctx = {
    slug: concept.slug,
    name: concept.name,
    description: concept.description || '',
    teaches: concept.teaches || [],
    requires: concept.requires || [],
    requiredBy: concept.requiredBy || [],
    relatedTo: concept.relatedTo || [],
    learningJourneys: phase4.learningJourneys || [],
    blogPosts: phase4.blogPosts || [],
    discoveryMissions: phase4.discoveryMissions || [],
    videos: phase4.videos || [],
    apiDocs: phase4.apiDocs || [],
    samples: phase4.samples || [],
    helpDocs: phase4.helpDocs || [],
    communityEvents: phase4.communityEvents || [],
    shellHead: shell.shellHead,
    shellHeader: shell.shellHeader || '',
    shellFooter: shell.shellFooter || '',
  };
  const html = TEMPLATE(ctx);
  const gzipped = gzipSync(Buffer.from(html, 'utf-8'));
  const contentHash = createHash('sha256').update(html, 'utf-8').digest('hex');
  return { html, gzipped, contentHash };
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run test/unit/concept-detail-render.test.js`
Expected: PASS.

- [ ] **Step 7: Add more test cases — populated arrays + escaping + shell-missing error**

Extend `test/unit/concept-detail-render.test.js`:

```javascript
it('renders learning journeys and blog posts when populated', async () => {
  const concept = {
    slug: 'cap', name: 'CAP', description: 'x',
    teaches: [], requires: [], requiredBy: [], relatedTo: [],
  };
  const phase4 = {
    learningJourneys: [{slug:'lj1',title:'Get started',url:'/lj/1',level:'BEGINNER',durationHours:2}],
    blogPosts: [{slug:'bp1',title:'CAP intro',url:'https://blog/1',authorName:'Alice'}],
    discoveryMissions: [], videos: [], apiDocs: [], samples: [], helpDocs: [], communityEvents: [],
  };
  const result = renderConceptDetail(concept, phase4, SHELL);
  expect(result.html).toContain('data-kg-section="learning-journeys"');
  expect(result.html).toContain('Get started');
  expect(result.html).toContain('BEGINNER');
  expect(result.html).toContain('CAP intro');
  expect(result.html).toContain('Alice');
});

it('escapes HTML in title and description', async () => {
  const concept = {
    slug: 'x', name: '<script>alert(1)</script>', description: 'A & B',
    teaches: [], requires: [], requiredBy: [], relatedTo: [],
  };
  const phase4 = { learningJourneys:[], blogPosts:[], discoveryMissions:[], videos:[], apiDocs:[], samples:[], helpDocs:[], communityEvents:[] };
  const result = renderConceptDetail(concept, phase4, SHELL);
  expect(result.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  expect(result.html).not.toContain('<script>alert(1)</script>');
  expect(result.html).toContain('A &amp; B');
});

it('throws when shell fragments are missing', () => {
  const concept = { slug:'x', name:'X', description:'', teaches:[], requires:[], requiredBy:[], relatedTo:[] };
  const phase4 = { learningJourneys:[], blogPosts:[], discoveryMissions:[], videos:[], apiDocs:[], samples:[], helpDocs:[], communityEvents:[] };
  expect(() => renderConceptDetail(concept, phase4, {})).toThrow(/shell fragments missing/);
});

it('throws when concept.slug or name is missing', () => {
  expect(() => renderConceptDetail({}, {}, SHELL)).toThrow(/concept\.slug and concept\.name/);
});

it('contentHash is stable for the same input', () => {
  const concept = { slug:'x', name:'X', description:'y', teaches:[], requires:[], requiredBy:[], relatedTo:[] };
  const phase4 = { learningJourneys:[], blogPosts:[], discoveryMissions:[], videos:[], apiDocs:[], samples:[], helpDocs:[], communityEvents:[] };
  const a = renderConceptDetail(concept, phase4, SHELL);
  const b = renderConceptDetail(concept, phase4, SHELL);
  expect(a.contentHash).toBe(b.contentHash);
});
```

- [ ] **Step 8: Run all tests, verify pass**

Run: `npx vitest run test/unit/concept-detail-render.test.js`
Expected: 5+ tests PASS.

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json srv/lib/concept-detail-render.js srv/lib/templates/concept-detail.ejs test/unit/concept-detail-render.test.js
git commit -m "feat(concepts): pure render function for concept detail HTML

Adds renderConceptDetail(concept, phase4, shell) that produces gzipped
HTML from a PublishedConcept row + its phase-4 arrays + the shared
__shell__ sidecar fragments. Uses EJS. No I/O — pure function of inputs.

Unit tests cover empty + populated arrays, HTML escaping, missing shell
error, missing key fields error, hash stability."
```

---

*Task 1 shipped in PR #1330.*

---

## Task 2: `concept-list-page.js` — `GET /content/concepts-index` backend (Thread A, dark launch)

**Goal:** CAP serves the `/concepts/` list page: an SSR shell with the top-100 concepts as real `<li>` (SEO / no-JS) plus the full slim array embedded as JSON for the Vue island. Version-keyed in-process cache. **No AppRouter route flip in this task** — endpoint reachable directly only.

**Files:**
- Create: `srv/lib/concept-list-page.js`
- Create: `srv/lib/templates/concept-list.ejs`
- Create: `test/unit/concept-list-page.test.js`
- Modify: `srv/server.js` — register `app.get('/content/concepts-index', …)` near the other `/content/*` GETs (after `:slug`, ~line 425)

**Interfaces:**
- Consumes: `buildConceptsPayload(db)` (errata #1) for the full concept array; `ConceptRank` (errata #11) for top-100 ordering; `ContentManifest` active `version` for the cache key + ETag.
- Produces:
  - `async function buildConceptListModel(db) → { cards: SlimCard[], top: SlimCard[], count: number, version: number|null }` — pure data assembly. `SlimCard = { slug, name, description, tutorialCount, firstLetter }` (errata #4). `top` = up to 100 cards ordered by `ConceptRank.score DESC`, fail-open to `cards` alphabetical when the sidecar is empty/throws.
  - `function renderConceptListHtml(model) → string` — EJS shell render.
  - `async function conceptsIndexHandler(req, res)` — Express handler: manifest-version cache lookup → hit returns cached gzip Buffer; miss builds model, renders, gzips, caches, serves. Headers: `Content-Type: text/html; charset=utf-8`, `Content-Encoding: gzip`, `Cache-Control: public, max-age=300`, `ETag: "<version>"`, `X-Content-Source: memcache|fresh`. Honors `If-None-Match` → 304.

- [ ] **Step 1: Failing test — `buildConceptListModel` slim shape + tutorialCount**

Create `test/unit/concept-list-page.test.js`. Seed an in-memory model by stubbing a `db` whose `buildConceptsPayload` returns 3 concepts (one with 2 `teaches`, one with 0, one with unicode name). Assert:
- `model.cards` length 3, each `{slug,name,description,tutorialCount,firstLetter}` only (no phase-4 arrays leaked).
- `tutorialCount` = `teaches.length` (2, 0, …).
- `firstLetter` upper-cased first char; non-alpha → `'#'`.
- Description passes through untruncated in the model (truncation is a display concern in the card component; the SSR `<li>` truncates via the template).

Prefer injecting a fake `buildConceptsPayload` via a small `deps` param — `buildConceptListModel(db, { buildConceptsPayload })` — so the unit test needs no HANA. Default the dep to the real import.

- [ ] **Step 2: Run test → fails (module missing).**

- [ ] **Step 3: Write `concept-list-page.js` — `buildConceptListModel`**

Map `payload.concepts` → slim cards. `firstLetter`: `const c = (name[0]||'').toUpperCase(); return /[A-Z]/.test(c) ? c : '#'`. Fetch `ConceptRank` rows (`SELECT.from(ConceptRank).columns('slug','score')`), build a `Map`, sort a copy of cards by score desc (missing → -Infinity), slice 100 → `top`. Wrap the rank fetch in try/catch → on throw, `top = cards.slice().sort(byNameAsc).slice(0,100)` (fail-open, errata #11 + the `KG_PAGERANK_ENABLED` fail-open precedent).

- [ ] **Step 4: Create `concept-list.ejs`**

Mirror `hugo/layouts/concepts/list.html` (errata #4, #5): `<article class="concepts-index" id="concepts-filter-root">`, controls/count/list/empty containers with the same IDs, `<ul class="concepts-index__list" id="concepts-filter-list">` containing the top-100 `<li class="concepts-index__item" data-slug data-name data-description data-first-letter data-tutorial-count>` cards (description `truncate 140` equivalent — slice + ellipsis, HTML-escaped). Then a `<script type="application/json" id="concepts-data">` with the full `cards` array, and `<noscript>` "Showing 100 of N. Browse alphabetically:" + A-Z anchors. Reuse `<%- shellHead %>/<%- shellHeader %>/<%- shellFooter %>` like Task 1 (the handler must fetch shell fragments — see Step 6). Load `<script type="module" src="/js/concepts-filter.js" defer>`.

- [ ] **Step 5: Tests for `renderConceptListHtml`** — top-100 `<li>` count exactly min(100, N); `#concepts-data` JSON parses to full array; `<noscript>` present; empty-state (`count===0`) renders "No published concepts yet" and no `#concepts-data`; XSS escaping on name/description.

- [ ] **Step 6: `conceptsIndexHandler` + shell fetch + cache**

Shell fragments come from the `__shell__` sidecar already in `ContentFiles` (same source Task 3 uses). Add a tiny `readShellFragments(db)` helper (or reuse whatever `content-store.js` exposes — **verify at impl time** whether a shell getter already exists; do NOT duplicate). Cache keyed on `ContentManifest` active version: module-level `let cache = { version, gzip, etag }`. On request: read active version; if `cache.version === version` → serve cached (304 when `If-None-Match` matches etag); else rebuild. Metrics per errata / design "Metrics" section (`concept_list_render_ms`, `concept_list_cache_hits/misses`, `concept_list_query_failure`). On `buildConceptsPayload` throw: serve last-known-good cache if any, else 503 static "Concepts temporarily unavailable" HTML.

- [ ] **Step 7: Register route in `srv/server.js`** — `app.get('/content/concepts-index', conceptsIndexHandler)` (public, no auth — inherits nothing; it's a plain Express GET like `serveHandler`). Import from `./lib/concept-list-page.js`.

- [ ] **Step 8: Hybrid test** `test/hybrid/concept-list-page-hybrid.test.js` — against real HANA via `cds bind`: `GET /content/concepts-index` returns 200 gzip, `#concepts-data` length equals live PublishedConcepts count, top-100 `<li>` present, ETag stable across two calls (cache hit), `X-Content-Source: memcache` on the second.

- [ ] **Step 9: Commit** `feat(concepts): GET /content/concepts-index list-page backend (#1327)` — note "dark launch: route not flipped".

**Rollback:** revert PR. Endpoint unreferenced by AppRouter → zero user impact.

---

## Task 3: `publish-concepts.js` — `POST /content/publish/render-concepts` (Thread B, dark launch)

**Goal:** A session-scoped publish phase that renders every concept via Task 1's `renderConceptDetail` and appends `concept-<slug>` BLOBs to an open publish session — replacing the Hugo-walk source (errata #8). **No `publish-content.ts` caller in this task** — endpoint reachable but unused by CI.

**Files:**
- Create: `srv/lib/publish-concepts.js`
- Create: `test/unit/publish-concepts.test.js`
- Create: `test/hybrid/concept-render-hybrid.test.js`
- Modify: `srv/server.js` — register `app.post('/content/publish/render-concepts', express.json({limit:'1mb'}), contentAuthMiddleware, renderConceptsHandler)` next to the other `/content/publish/*` routes (~line 427).

**Interfaces:**
- Consumes: `buildConceptsPayload(db)` (errata #1); `renderConceptDetail` (Task 1); the `__shell__` sidecar fragments; `appendToSession` from `createSessionHelpers` (errata #7); previous ACTIVE `concept-<slug>` `contentHash`es for delta skip (same source `hashesHandler` uses).
- Produces:
  - `async function renderConceptsIntoSession({ db, sessionId, helpers, priorHashes }) → { conceptsSeen, conceptsChanged, conceptsSkipped, durationMs }`.
  - `async function renderConceptsHandler(req, res)` — auth via `contentAuthMiddleware` (already applied as middleware); reads `{sessionId}` from body; calls the orchestrator; returns counts JSON.

- [ ] **Step 1: Failing test — batch render + delta skip + append payload shape**

`test/unit/publish-concepts.test.js`: fake `buildConceptsPayload` → 3 concepts; fake `helpers.appendToSession` capturing calls; `priorHashes` matching 1 of 3 concepts' rendered hash. Assert: `appendToSession` called with `files` keyed `concept-<slug>` (base64 gzip) for the 2 changed; skipped count 1; each `renderConceptDetail` fed the concept + its phase-4 arrays + shell. Assert batch size 20 (4th batch boundary with 21 concepts in a second test).

- [ ] **Step 2: Run → fails.**

- [ ] **Step 3: Write `publish-concepts.js`**

Fetch payload once. Read shell fragments once (throw → whole phase fails: "shell sidecar not published"). For each batch of 20: `renderConceptDetail(concept, phase4, shell)` per concept; compare `contentHash` to `priorHashes['concept-'+slug]` → skip if equal (delta, errata #8 + tutorial parity); else add to `files['concept-'+slug] = base64(gzipped)`. `await appendToSession({sessionId, files, metadata})` per batch. Accumulate counts. Wrap per-concept render in try/catch → log `concept_render_error` + skip that concept (carry-forward keeps prior BLOB); if >5% skip-by-error → throw to abort (design "Error handling").

- [ ] **Step 4: More unit tests** — empty corpus (0 concepts → 0 appends, ok); shell-missing → throws; one concept render throws → skipped, others proceed; >5% error rate → throws.

- [ ] **Step 5: `renderConceptsHandler`** — parse `{sessionId}`; 400 if missing; look up `priorHashes`; call orchestrator; 200 with counts; 500 on orchestrator throw (session left for the caller to abort).

- [ ] **Step 6: Register route** (errata #7 path; `contentAuthMiddleware` like `publishHandler`).

- [ ] **Step 7: Hybrid test** `test/hybrid/concept-render-hybrid.test.js` — real HANA: begin a session, run render-concepts for a handful of concepts, assert `concept-<slug>` BLOBs land in `ContentFiles`, `GET /content/concepts/<slug>` returns unzipped HTML matching the template (guards LOB-alongside-metadata — errata; use raw `db.run` for BLOB read), carry-forward on commit. **Guards the `@assert.unique`/upsert-on-slug and LOB gotchas.**

- [ ] **Step 8: Commit** `feat(concepts): POST /content/publish/render-concepts phase (#1327)` — "dark launch: no CI caller".

**Rollback:** revert PR. Endpoint unreferenced by `publish-content.ts` → zero impact.

---

## Task 4: Vue island rewrite — array read + `RecycleScroller` virtualization (Thread A)

**Goal:** Rewrite `App.vue` to read the embedded JSON array (Task 2) and render only visible cards via `vue-virtual-scroller`'s `RecycleScroller`, instead of DOM-toggling 5k `<li>`. `filter-logic.ts` already operates on arrays (errata #5) — reuse it wholesale.

**Files:**
- Modify: `hugo-apps/src/concepts-filter/App.vue` — read `#concepts-data` JSON on mount; remove SSR top-100 `<li>` after hydrate; render windowed slice via `RecycleScroller`; filtering/sorting/A-Z/URL-sync operate on the array (existing `applyFilters`/`availableLetters`/query helpers).
- Create: `hugo-apps/src/concepts-filter/ConceptCard.vue` — card matching the `<li>` DOM/classes (`concepts-index__item/__link/__name/__description/__meta`).
- Modify: `hugo-apps/src/concepts-filter/filter-logic.ts` — only if a field rename is needed; the `ConceptCard` interface likely already matches the slim shape (**verify** — errata #4/#5).
- Modify: `hugo-apps/package.json` — add `vue-virtual-scroller@3.0.4` (errata #6; already in root).
- Modify/extend: `hugo-apps/src/concepts-filter/App.test.ts` + `filter-logic.test.ts` — read-from-JSON path; do NOT test `RecycleScroller` internals.

- [ ] **Step 1** Add `vue-virtual-scroller` to `hugo-apps/package.json`; `npm run setup` (hugo-apps install) — global `ignore-scripts=true` caveat.
- [ ] **Step 2** Failing test: mount island against a fixture DOM containing `#concepts-data` JSON + empty `#concepts-filter-list`; assert cards render from JSON, not from pre-existing `<li>`.
- [ ] **Step 3** Rewrite `App.vue` mount: `JSON.parse(document.getElementById('concepts-data').textContent)` → `cards.value`; clear SSR `<li>`; mount `RecycleScroller` into `#concepts-filter-list` with fixed item height (~140px, pin it). Wire `applyFilters(cards, state)` → `visible` computed → scroller `items`.
- [ ] **Step 4** `ConceptCard.vue` — props = one `SlimCard`; emit the same anchor/classes as the Hugo `<li>` so existing CSS applies; description `truncate 140`.
- [ ] **Step 5** Preserve controls: search debounce, A-Z jump (`availableLetters`), sort dropdown, count updater, clear-all, bidirectional URL sync (`toQueryString`/`fromQueryString`) — all already array-based.
- [ ] **Step 6** No-JS/empty paths: island absent → SSR top-100 + `<noscript>` remain (Task 2 shell). Empty array → island shows empty state.
- [ ] **Step 7** Run `hugo-apps` vitest; commit `feat(concepts): virtualize /concepts/ island via RecycleScroller (#1327)`.

**Rollback:** old App.vue in git history; revert PR. SSR top-100 still serves.

---

## Task 5: Wire it live — route flip + publish phase + legacy guard (Thread A + B cutover)

**Goal:** Turn on both threads on DEV. Flip the AppRouter list route to CAP, wire `publish-content.ts` to call render-concepts, and guard the legacy Hugo path behind `LEGACY_CONCEPT_RENDER`.

**Files:**
- Modify: `approuter/xs-app.json:408-409` — `^/concepts/?$` → `{destination:'srv-api', target:'/content/concepts-index', authenticationType:'none'}` (errata #10). Audit any `/concepts-qa/*` route too.
- Modify: `scripts/publish-content.ts` — insert `renderConceptsPhase` call between the append loop (~line 1141) and `commitSession` (~line 1148); guarded by `LEGACY_CONCEPT_RENDER !== 'true'`.
- Modify: `scripts/lib/publish-client.ts` — add `renderConceptsPhase({baseUrl, apiKey, sessionId})` POSTing to `/content/publish/render-concepts`.
- Modify: `scripts/fetch-concepts.ts` — early-exit `if (process.env.LEGACY_CONCEPT_RENDER !== 'true') process.exit(0)` (errata: still emits Hugo `.md` only under the flag).
- Modify: `.github/workflows/rebuild-content.yml` — add `legacy-concept-render` boolean input (default false); guard the "fetch concepts" step on it.

- [ ] **Step 1** Add `renderConceptsPhase` client fn (mirror `appendBatch`'s fetch+retry shape).
- [ ] **Step 2** Wire it into `publish-content.ts` after append, before commit; log counts; on failure `abortSession` (same as append failure path).
- [ ] **Step 3** Guard `fetch-concepts.ts` early-exit; guard the workflow step; add the workflow input.
- [ ] **Step 4** Flip `xs-app.json` route; audit QA route.
- [ ] **Step 5** Deploy DEV (primary tree, `main`, `build:all` before `mbt build`); smoke: `/concepts/` 200 gzip < 2MB, `#concepts-data` present, top-100 `<li>`, `/concepts/cap/` 200. Compare sample detail pages against pre-cutover (snapshot parity, Task 6). Time full rebuild (should drop — no 5k Hugo pages). Run once with `legacy-concept-render=true` to verify the escape hatch.
- [ ] **Step 6** Commit `feat(concepts): cut /concepts/ over to CAP list + render pipeline (#1327)`.

**Rollback:** Layer 1 = rerun rebuild with `legacy-concept-render=true`. Layer 2 = one-line `xs-app.json` route revert + redeploy (static `index.html` still in droplet). Layer 3 = revert PR (detail BLOBs persist; list reverts to static).

---

## Task 6: Parity gate + smoke + bake/cleanup

**Files:**
- Create: `test/snapshot/concept-parity.test.js` + `test/fixtures/concept-parity-slugs.json`
- Create: `test/smoke/concepts-page.test.js`
- (Deferred) delete `scripts/fetch-concepts.ts`, `hugo/layouts/concepts/{list,single}.html`, `LEGACY_CONCEPT_RENDER` branches.

- [ ] **Step 1** Snapshot parity (**required PR check before Task 5 lands**): 10 hand-picked slugs (varied shapes) in the fixture. Fetch legacy Hugo output from DEV; render same slugs via new pipeline; diff allowing an explicit expected-diff list (render-source marker, `<script>` whitespace). Fail on unexpected diffs.
- [ ] **Step 2** Smoke (`test/smoke/concepts-page.test.js`): `/concepts/` 200, `text/html`, gzip < 2MB, `#concepts-data` array of expected length, SSR `<li>` count == min(100,N), `/concepts/cap/` 200, cache headers, p50 cold < 200ms / warm < 30ms.
- [ ] **Step 3** Load characterization (`hyperfine`, not a merge gate) — document p50/p95 in PR; block cutover if p95 cold > 300ms pending investigation.
- [ ] **Step 4 (deferred, own PR)** After ~2 weeks DEV stability: delete legacy Hugo concept path + flag (~200 lines net deletion).

---

## Deploy pattern (per landing)

PR → merge → local `npm run build:all && cd .deploy && mbt build && cf deploy` from the **primary tree on `main`** (never a worktree; Hugo must finish before `mbt build` — see project memory). All tasks target **DEV only**; PROD cutover (end-of-July 2026) is out of scope.

## Global test/lint gates

- `npm test` green (unit, in-memory SQLite).
- `npm run test:hybrid` green (real HANA via `cds bind`) for Tasks 2, 3.
- Snapshot parity (Task 6 Step 1) required before Task 5.
- `srv-qa` cp-list audit when touching `srv/lib/` (project convention): re-walk transitive `./` imports and confirm each is in `.deploy/mta.yaml`'s `srv-qa` `cp` list — `concept-list-page.js`, `publish-concepts.js`, `concept-detail-render.js`, and `templates/` must be listed or QA boot crashes.

