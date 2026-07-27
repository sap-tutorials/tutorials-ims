# Concepts page scale: virtualization + CAP takeover — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/concepts/` scale from ~700 to 5k-10k concepts by moving the list page to CAP with SSR-shell + client virtualization, and moving concept detail rendering out of Hugo into CAP entirely.

**Architecture:** Two independent workstreams sharing the `PublishedConcepts` read path and one rollback flag. Thread A: CAP-rendered list page with top-100 SSR cards + embedded JSON + `vue-virtual-scroller` windowing. Thread B: `POST /content/publish/render-concepts` phase in `publish-content.ts` calls a new CAP endpoint that queries `PublishedConcepts` + phase-4 tables and writes `concept-<slug>` BLOBs into `ContentFiles` via existing session helpers.

**Tech Stack:** Node.js 22, CAP (Node.js runtime), HANA Cloud, Vue 3 + Vite (hugo-apps island), `vue-virtual-scroller`, EJS templating, TypeScript, Vitest.

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

## Task 1: `concept-detail-render.js` — pure render function + unit tests

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

*Continued in Task 2...*
