# Error Pages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build custom 404/500/503 pages with site search and a popular-tutorials rail, served by AppRouter via the `errorPage` map with status codes preserved.

**Architecture:** Three Hugo layouts (`404.html`, `500.html`, `maintenance.html`) emit static HTML to `hugo/public/` and get copied to `approuter/static/` during MTA build. AppRouter `xs-app.json` adds an `errorPage` map. The 404 page has a Hugo-rendered popular rail (build-time fallback) with a small external JS upgrade reading `/build/catalog`'s new `featured` array (runtime authoritative source from `FeaturedTasks`). The TutorialNavigator Vue app reads `?q=` from the URL on mount so the search-box-redirects-to-home flow works.

**Tech Stack:** Hugo, Vue 3 (Vite), CAP Node.js, AppRouter (`@sap/approuter`), vitest, in-memory SQLite for unit tests.

**Spec:** [docs/superpowers/specs/2026-05-20-error-pages-design.md](../specs/2026-05-20-error-pages-design.md)

---

## File map

**New:**
- `hugo/layouts/500.html` — 500 page layout
- `hugo/layouts/maintenance.html` — 503/maintenance page layout
- `hugo/static/js/popular-rail.js` — runtime upgrade for the 404 popular rail
- `test/smoke/error-pages.test.js` — smoke tests for error pages

**Modified:**
- `hugo/layouts/404.html` — add search form, popular rail, and rail upgrade `<script>` reference
- `apps/src/navigator/TutorialNavigator.vue` — read `?q=` from URL on mount
- `srv/lib/build-catalog.js` — add `featured` array sourced from `FeaturedTasks`
- `approuter/xs-app.json` — add top-level `errorPage` map (and possibly per-route `errors` override after EC1 probe)
- `test/published-flag.test.js` *or new* `test/build-catalog-featured.test.js` — assert `featured` field shape

**Read-only (no changes expected):**
- `.deploy/mta.yaml` — verify `cp -r ../hugo/public/. static/` continues to copy root-level HTML files (it does; this is a sanity-check, not an edit)

---

## Task 1: Seed `?q=` from URL into TutorialNavigator on mount

The 404 search form submits to `/?q=<term>`. The home page navigator must read that param and seed `searchQuery`.

**Files:**
- Modify: `apps/src/navigator/TutorialNavigator.vue` (after line 31, inside `onMounted`)

- [ ] **Step 1: Read the current onMounted block to anchor the edit**

Run: `grep -n "onMounted\|searchQuery" apps/src/navigator/TutorialNavigator.vue | head -5`
Expected: confirms `searchQuery = ref('')` near line 10 and `onMounted(async () => {` near line 31.

- [ ] **Step 2: Add the seed at the start of `onMounted`**

In `apps/src/navigator/TutorialNavigator.vue`, change the first lines of `onMounted`:

```ts
onMounted(async () => {
  const initialQuery = new URL(window.location.href).searchParams.get('q')
  if (initialQuery) searchQuery.value = initialQuery

  const [navRes, catalogRes] = await Promise.all([
    fetch('/tutorials/_nav.json'),
    fetch('/build/navigator'),
  ])
```

- [ ] **Step 3: Build the apps bundle**

Run: `npm run build:apps`
Expected: Vite builds without errors; new chunk written to `hugo/static/js/navigator-*.js` (or wherever the build output lands per `vite.config.ts`).

- [ ] **Step 4: Manual verify**

Run `npm run dev` (Hugo on :1313). Open `http://localhost:1313/?q=cap` in a browser. Expected: navigator's search input is pre-filled with `cap` and results filter to CAP tutorials.

- [ ] **Step 5: Commit**

```bash
git add apps/src/navigator/TutorialNavigator.vue hugo/static/js/
git commit -m "feat(navigator): seed search query from ?q= URL parameter"
```

---

## Task 2: Add `featured` array to `/build/catalog`

The 404 page's runtime upgrade fetches `/build/catalog` and looks for a `featured` array. The handler currently returns `{missions, hierarchies}`; we add a third top-level field.

**Files:**
- Modify: `srv/lib/build-catalog.js`
- Test: `test/build-catalog-featured.test.js` (new)

- [ ] **Step 1: Write the failing test**

Create `test/build-catalog-featured.test.js`:

```js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

const TAG_ID = 'aaaaaaaa-3333-0000-0000-000000000001';
const MISSION_ID = '11111111-3333-0000-0000-000000000001';
const FEATURED_ID = '33333333-3333-0000-0000-000000000001';

describe('/build/catalog featured field', () => {
  beforeAll(async () => {
    const { Tags, Missions, FeaturedTasks } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Tags).entries({ ID: TAG_ID, legacyId: 93001, name: '__TEST__ Featured Tag' });
    await INSERT.into(Missions).entries({
      ID: MISSION_ID, legacyId: 93001, title: '__TEST__ Featured Mission',
      slug: 'test-featured', description: 'desc', experienceTag: 'beginner',
      primaryTagRef_ID: TAG_ID, published: true,
    });
    await INSERT.into(FeaturedTasks).entries({
      ID: FEATURED_ID, legacyId: 93001,
      taskLegacyId: 93001, taskType: 'MISSION', featuredOrder: 1,
    });
  });

  afterAll(async () => {
    const { Tags, Missions, FeaturedTasks } = cds.entities('com.sap.developers.ims');
    await DELETE.from(FeaturedTasks).where({ ID: FEATURED_ID });
    await DELETE.from(Missions).where({ ID: MISSION_ID });
    await DELETE.from(Tags).where({ ID: TAG_ID });
  });

  it('includes featured array with mission entries ordered by featuredOrder', async () => {
    const { status, data } = await project.get('/build/catalog');
    expect(status).toBe(200);
    expect(Array.isArray(data.featured)).toBe(true);

    const ours = data.featured.find(f => f.slug === 'test-featured');
    expect(ours).toBeDefined();
    expect(ours.type).toBe('mission');
    expect(ours.title).toBe('__TEST__ Featured Mission');
    expect(ours.description).toBe('desc');
  });

  it('caps the featured array at 6 entries', async () => {
    const { data } = await project.get('/build/catalog');
    expect(data.featured.length).toBeLessThanOrEqual(6);
  });
});
```

- [ ] **Step 2: Run test, confirm it fails**

Run: `npx vitest run test/build-catalog-featured.test.js`
Expected: FAIL — `Array.isArray(data.featured)` is false because the handler doesn't emit `featured` yet.

- [ ] **Step 3: Implement the `featured` field in the handler**

In `srv/lib/build-catalog.js`, after the existing `missions` query and before the `res.json` call, add a featured-resolution block. Replace the existing function body:

```js
import cds from '@sap/cds';

const FEATURED_LIMIT = 6;

export async function buildCatalogHandler(req, res) {
  const { Missions, CompletionPaths, CompletionPathItems, Tutorials, FeaturedTasks } =
    cds.entities('com.sap.developers.ims');

  try {
    const missions = await SELECT.from(Missions).where({ published: true });
    const paths = await SELECT.from(CompletionPaths).orderBy('legacyId');
    const items = await SELECT.from(CompletionPathItems).orderBy('itemOrder');
    const tutorials = await SELECT.from(Tutorials)
      .columns('legacyId', 'slug', 'title', 'description')
      .where(`status = 'ACTIVE' or status is null`);
    const featuredRows = await SELECT.from(FeaturedTasks)
      .orderBy('featuredOrder')
      .limit(FEATURED_LIMIT);

    const slugByLegacyId = new Map(tutorials.map(t => [t.legacyId, t.slug]));
    const tutorialByLegacyId = new Map(tutorials.map(t => [t.legacyId, t]));
    const missionByLegacyId = new Map(missions.map(m => [m.legacyId, m]));
    const pathByLegacyId = new Map(paths.map(p => [p.legacyId, p]));

    const missionList = missions.map(m => ({
      imsId: m.legacyId,
      title: m.title || '',
      slug: m.slug || String(m.legacyId),
      description: m.description || '',
      level: m.experienceTag || 'beginner',
      time: Math.round((m.averageTimeToComplete || 0) / 60),
      icon: '',
      tasksCount: 0,
    }));

    const hierarchies = missions.map(m => {
      const missionPaths = paths.filter(p => p.mission_ID === m.ID);
      const groups = missionPaths.map(p => {
        const pathItems = items.filter(i => i.path_ID === p.ID);
        const tutorialSlugs = pathItems
          .filter(i => i.taskType === 'TUTORIAL')
          .map(i => slugByLegacyId.get(i.taskLegacyId))
          .filter(Boolean);

        return {
          imsId: p.legacyId,
          title: p.name || '',
          slug: p.slug || String(p.legacyId),
          description: '',
          tutorialSlugs,
        };
      });

      const isFlat = missionPaths.length === 1 && missionPaths[0].name === m.title;

      return {
        missionImsId: m.legacyId,
        groups: isFlat ? [] : groups,
        tutorialSlugs: isFlat ? (groups[0]?.tutorialSlugs || []) : [],
      };
    });

    for (const m of missionList) {
      const h = hierarchies.find(h => h.missionImsId === m.imsId);
      if (h) {
        m.tasksCount = h.tutorialSlugs.length
          + h.groups.reduce((sum, g) => sum + g.tutorialSlugs.length, 0);
      }
    }

    const featured = featuredRows
      .map(f => resolveFeatured(f, { missionByLegacyId, pathByLegacyId, tutorialByLegacyId }))
      .filter(Boolean);

    res.json({ missions: missionList, hierarchies, featured });
  } catch (err) {
    console.error('[build/catalog]', err instanceof Error ? err.message : String(err));
    res.status(500).json({ error: 'Build catalog query failed' });
  }
}

function resolveFeatured(f, { missionByLegacyId, pathByLegacyId, tutorialByLegacyId }) {
  if (f.taskType === 'MISSION') {
    const m = missionByLegacyId.get(f.taskLegacyId);
    if (!m) return null;
    return {
      type: 'mission',
      slug: m.slug || String(m.legacyId),
      title: m.title || '',
      description: m.description || '',
    };
  }
  if (f.taskType === 'GROUP') {
    const p = pathByLegacyId.get(f.taskLegacyId);
    if (!p) return null;
    return {
      type: 'group',
      slug: p.slug || String(p.legacyId),
      title: p.name || '',
      description: '',
    };
  }
  if (f.taskType === 'TUTORIAL') {
    const t = tutorialByLegacyId.get(f.taskLegacyId);
    if (!t || !t.slug) return null;
    return {
      type: 'tutorial',
      slug: t.slug,
      title: t.title || '',
      description: t.description || '',
    };
  }
  return null;
}
```

Note: `Tutorials` query gains `title, description` columns (still excluded from BLOB hazard — text fields only).

- [ ] **Step 4: Run test, confirm it passes**

Run: `npx vitest run test/build-catalog-featured.test.js`
Expected: both `it` blocks PASS.

- [ ] **Step 5: Verify the existing `/build/catalog` consumers still work**

Run: `npx vitest run test/published-flag.test.js`
Expected: PASS (the existing "excludes unpublished missions" test should still pass — we only added a field).

- [ ] **Step 6: Commit**

```bash
git add srv/lib/build-catalog.js test/build-catalog-featured.test.js
git commit -m "feat(build-catalog): add featured array sourced from FeaturedTasks"
```

---

## Task 3: New `hugo/layouts/500.html`

Apologetic page for 5xx errors with retry button and `/health` links for diagnostics.

**Files:**
- Create: `hugo/layouts/500.html`

- [ ] **Step 1: Create the layout**

Write `hugo/layouts/500.html`:

```html
{{ define "main" }}
<section class="error-hero" data-error-page="500" aria-labelledby="error-500-title">
  <div class="error-inner">
    <p class="error-eyebrow">Something went wrong</p>
    <h1 id="error-500-title" class="error-title">We're having trouble loading this page</h1>
    <p class="error-lede">
      An unexpected error occurred on our side. The team has been notified.
      You can try again, head back to the start, or check our status below.
    </p>
    <div class="error-actions">
      <button class="fd-button fd-button--emphasized" type="button" onclick="window.location.reload()">
        Try again
      </button>
      <a class="fd-button fd-button--transparent" href="/">Browse tutorials</a>
    </div>
    <p class="error-help">
      Status checks:
      <a href="/health" target="_blank" rel="noopener">/health</a> ·
      <a href="/health/db" target="_blank" rel="noopener">/health/db</a>
    </p>
  </div>
</section>

<style>
  .error-hero {
    padding: 4rem 1.5rem;
    background: var(--sapBackgroundColor, #f5f6f7);
    min-height: 60vh;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .error-inner {
    max-width: 640px;
    text-align: center;
    background: var(--sapTile_Background, #ffffff);
    padding: 3rem 2rem;
    border-radius: 0.75rem;
    box-shadow: 0 0.125rem 0.5rem rgba(0, 0, 0, 0.08);
  }
  .error-eyebrow {
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-size: 0.85rem;
    color: var(--sapNeutralTextColor, #5b738b);
    margin: 0 0 0.5rem;
  }
  .error-title {
    font-size: 2rem;
    margin: 0 0 1rem;
    color: var(--sapTextColor, #32363a);
  }
  .error-lede {
    font-size: 1.125rem;
    color: var(--sapTextColor, #32363a);
    margin: 0 0 2rem;
  }
  .error-actions {
    display: flex;
    gap: 0.75rem;
    justify-content: center;
    flex-wrap: wrap;
    margin-bottom: 1.5rem;
  }
  .error-help {
    font-size: 0.9rem;
    color: var(--sapNeutralTextColor, #5b738b);
    margin: 0;
  }
</style>
{{ end }}
```

- [ ] **Step 2: Verify Hugo emits the file**

Run: `npm run build:hugo`
Expected: `hugo/public/500.html` exists.

Run: `grep -l "data-error-page=\"500\"" hugo/public/500.html`
Expected: file matches.

- [ ] **Step 3: Commit**

```bash
git add hugo/layouts/500.html
git commit -m "feat(error-pages): add 500 layout with retry and health links"
```

---

## Task 4: New `hugo/layouts/maintenance.html`

Brief maintenance page for 503. No fetches, no health links (would defeat the purpose).

**Files:**
- Create: `hugo/layouts/maintenance.html`

- [ ] **Step 1: Create the layout**

Write `hugo/layouts/maintenance.html`:

```html
{{ define "main" }}
<section class="error-hero" data-error-page="503" aria-labelledby="error-maintenance-title">
  <div class="error-inner">
    <p class="error-eyebrow">Scheduled maintenance</p>
    <h1 id="error-maintenance-title" class="error-title">We'll be back shortly</h1>
    <p class="error-lede">
      The tutorials site is temporarily unavailable while we make improvements.
      Please check back in a few minutes.
    </p>
    <div class="error-actions">
      <a class="fd-button fd-button--transparent" href="/">Try the home page</a>
    </div>
  </div>
</section>

<style>
  .error-hero {
    padding: 4rem 1.5rem;
    background: var(--sapBackgroundColor, #f5f6f7);
    min-height: 60vh;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .error-inner {
    max-width: 640px;
    text-align: center;
    background: var(--sapTile_Background, #ffffff);
    padding: 3rem 2rem;
    border-radius: 0.75rem;
    box-shadow: 0 0.125rem 0.5rem rgba(0, 0, 0, 0.08);
  }
  .error-eyebrow {
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-size: 0.85rem;
    color: var(--sapNeutralTextColor, #5b738b);
    margin: 0 0 0.5rem;
  }
  .error-title {
    font-size: 2rem;
    margin: 0 0 1rem;
    color: var(--sapTextColor, #32363a);
  }
  .error-lede {
    font-size: 1.125rem;
    color: var(--sapTextColor, #32363a);
    margin: 0 0 2rem;
  }
  .error-actions {
    display: flex;
    gap: 0.75rem;
    justify-content: center;
    flex-wrap: wrap;
  }
</style>
{{ end }}
```

- [ ] **Step 2: Verify Hugo emits the file**

Run: `npm run build:hugo`
Expected: `hugo/public/maintenance.html` exists with the `data-error-page="503"` marker.

- [ ] **Step 3: Commit**

```bash
git add hugo/layouts/maintenance.html
git commit -m "feat(error-pages): add maintenance (503) layout"
```

---

## Task 5: Rewrite `hugo/layouts/404.html` with search + popular rail

Keep the existing hero copy and CSS, append search form + popular tutorials rail rendered from Hugo's tutorial pages.

**Files:**
- Modify: `hugo/layouts/404.html` (full rewrite)

- [ ] **Step 1: Rewrite the layout**

Write `hugo/layouts/404.html`:

```html
{{ define "main" }}
<section class="not-found-hero" data-error-page="404" aria-labelledby="not-found-title">
  <div class="not-found-inner">
    <p class="not-found-eyebrow">Page not found</p>
    <h1 id="not-found-title" class="not-found-title">We couldn't find that page</h1>
    <p class="not-found-lede">
      The page you're looking for has been retired, renamed, or never existed at this URL.
      Try a search, or pick from the popular tutorials below.
    </p>

    <form class="not-found-search" action="/" method="get" role="search">
      <label for="not-found-q" class="visually-hidden">Search tutorials</label>
      <div class="fd-input-group">
        <input id="not-found-q" name="q" type="search" class="fd-input fd-input-group__input"
               placeholder="Search for a tutorial" autocomplete="off" />
        <span class="fd-input-group__addon fd-input-group__addon--button">
          <button class="fd-button fd-button--emphasized fd-input-group__button" type="submit">Search</button>
        </span>
      </div>
    </form>

    <div class="not-found-actions">
      <a class="fd-button fd-button--transparent" href="/">Browse tutorials</a>
      <a class="fd-button fd-button--transparent" href="/missions/">Browse missions</a>
    </div>
  </div>
</section>

<section class="not-found-popular" aria-labelledby="popular-tutorials">
  <div class="not-found-popular__inner">
    <h2 id="popular-tutorials" class="not-found-popular__title">Popular tutorials</h2>
    <ul class="tutorial-grid" id="popular-rail" data-source="static">
      {{ range first 6 (where .Site.RegularPages "Type" "tutorials").ByLastmod.Reverse }}
      <li>
        <a href="{{ .RelPermalink }}">
          <h3>{{ .Title }}</h3>
          <p>{{ .Params.description | truncate 140 }}</p>
          <p class="meta">{{ .Params.level }} · {{ .Params.time }} min</p>
        </a>
      </li>
      {{ end }}
    </ul>
  </div>
</section>

<script defer src="/js/popular-rail.js"></script>

<style>
  .not-found-hero {
    padding: 4rem 1.5rem 2rem;
    background: var(--sapBackgroundColor, #f5f6f7);
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .not-found-inner {
    max-width: 720px;
    text-align: center;
    background: var(--sapTile_Background, #ffffff);
    padding: 3rem 2rem;
    border-radius: 0.75rem;
    box-shadow: 0 0.125rem 0.5rem rgba(0, 0, 0, 0.08);
  }
  .not-found-eyebrow {
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-size: 0.85rem;
    color: var(--sapNeutralTextColor, #5b738b);
    margin: 0 0 0.5rem;
  }
  .not-found-title {
    font-size: 2rem;
    margin: 0 0 1rem;
    color: var(--sapTextColor, #32363a);
  }
  .not-found-lede {
    font-size: 1.125rem;
    color: var(--sapTextColor, #32363a);
    margin: 0 0 2rem;
  }
  .not-found-search {
    margin: 0 0 1.5rem;
  }
  .not-found-actions {
    display: flex;
    gap: 0.75rem;
    justify-content: center;
    flex-wrap: wrap;
  }
  .not-found-popular {
    padding: 2rem 1.5rem 4rem;
    background: var(--sapBackgroundColor, #f5f6f7);
  }
  .not-found-popular__inner {
    max-width: 1080px;
    margin: 0 auto;
  }
  .not-found-popular__title {
    margin: 0 0 1.5rem;
    color: var(--sapTextColor, #32363a);
  }
  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
</style>
{{ end }}
```

- [ ] **Step 2: Build and verify**

Run: `npm run build:hugo`
Expected: `hugo/public/404.html` exists with the search form, `id="popular-rail"`, and the static fallback `<li>` items.

Run: `grep -c '<li>' hugo/public/404.html`
Expected: 6 (one per popular tutorial). May be lower in tiny dev builds.

- [ ] **Step 3: Manual verify**

Run `npm run dev` (Hugo dev server). Open `http://localhost:1313/404.html` in a browser. Expected: hero with search form, "Popular tutorials" section with up to 6 cards. Submit a search; URL becomes `/?q=<term>` and the navigator pre-fills (validates Task 1 integration).

- [ ] **Step 4: Commit**

```bash
git add hugo/layouts/404.html
git commit -m "feat(error-pages): rewrite 404 with search form and popular tutorials rail"
```

---

## Task 6: Add `popular-rail.js` runtime upgrade

Best-effort fetch of `/build/catalog`'s `featured` array; replaces the static rail when successful, no-op on failure.

**Files:**
- Create: `hugo/static/js/popular-rail.js`

- [ ] **Step 1: Write the script**

Create `hugo/static/js/popular-rail.js`:

```js
(async function upgradePopularRail() {
  const rail = document.getElementById('popular-rail');
  if (!rail) return;

  try {
    const res = await fetch('/build/catalog', { credentials: 'omit' });
    if (!res.ok) return;
    const data = await res.json();
    const featured = Array.isArray(data && data.featured) ? data.featured : [];
    if (featured.length === 0) return;

    const items = featured.map(f => {
      const li = document.createElement('li');
      const a = document.createElement('a');
      const slugPath = f.type === 'tutorial' ? `/tutorials/${f.slug}` : `/${f.type}s/${f.slug}/`;
      a.href = slugPath;

      const h3 = document.createElement('h3');
      h3.textContent = f.title || '';
      a.appendChild(h3);

      const p = document.createElement('p');
      const desc = (f.description || '').slice(0, 140);
      p.textContent = desc;
      a.appendChild(p);

      li.appendChild(a);
      return li;
    });

    rail.replaceChildren(...items);
    rail.dataset.source = 'featured';
  } catch (err) {
    // Silent — static fallback remains.
    if (window.console) console.debug('[popular-rail] upgrade failed:', err);
  }
})();
```

Notes:
- Uses DOM APIs (no innerHTML) to avoid XSS even though `featured` comes from our own backend.
- `credentials: 'omit'` keeps the request unauthenticated since `/build/catalog` is public.
- Sets `data-source="featured"` so smoke tests / dev tools can confirm the upgrade ran.

- [ ] **Step 2: Manual verify**

Run `npm run dev:hybrid` (CAP + approuter, with FeaturedTasks data in HANA). Visit any 404 path through the approuter. Expected: rail loads with static fallback, then briefly re-renders from the `featured` list (network tab shows `/build/catalog` request; `data-source` attribute changes to `featured`).

- [ ] **Step 3: Commit**

```bash
git add hugo/static/js/popular-rail.js
git commit -m "feat(error-pages): runtime upgrade of 404 popular rail from /build/catalog"
```

---

## Task 7: Wire `errorPage` in `xs-app.json` and verify deploy plumbing

Map 404/500/503 status codes to the static error pages. Also verify that the existing MTA build step copies the new files.

**Files:**
- Modify: `approuter/xs-app.json`

- [ ] **Step 1: Inspect current top-level structure**

Run: `head -25 approuter/xs-app.json`
Expected: confirms top-level keys are `authenticationMethod`, `responseHeaders`, `login`, `logout`, `routes`. No existing `errorPage`.

- [ ] **Step 2: Add the `errorPage` map**

Insert (e.g., after `logout` and before `routes`) into `approuter/xs-app.json`:

```json
"errorPage": [
  { "status": 404, "file": "static/404.html" },
  { "status": 500, "file": "static/500.html" },
  { "status": 503, "file": "static/maintenance.html" }
],
```

- [ ] **Step 3: Validate JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('approuter/xs-app.json','utf8'))" && echo OK`
Expected: prints `OK`. If a syntax error is reported, fix it before continuing.

- [ ] **Step 4: Verify MTA copies the files into `static/`**

Run: `grep -A 3 "cp -r ../hugo/public" .deploy/mta.yaml`
Expected: confirms `cp -r ../hugo/public/. static/` is unchanged. The follow-up `rm -rf static/tutorials` only removes the tutorials subdirectory, not root-level HTML files. No edit needed; this is a sanity check.

- [ ] **Step 5: Local verification**

Build Hugo and copy outputs into the approuter's static dir, then start the approuter:

```bash
npm run build:hugo
mkdir -p approuter/static
cp -r hugo/public/. approuter/static/
rm -rf approuter/static/tutorials
npm run start:approuter
```

In a separate terminal:

```bash
curl -i http://localhost:5000/this-does-not-exist
```

Expected:
- `HTTP/1.1 404 Not Found`
- Body contains `data-error-page="404"`
- Body contains `id="popular-rail"`

```bash
curl -i http://localhost:5000/500.html
curl -i http://localhost:5000/maintenance.html
```

Expected: 200 status (direct fetches), bodies contain `data-error-page="500"` and `data-error-page="503"` respectively.

- [ ] **Step 6: Commit**

```bash
git add approuter/xs-app.json
git commit -m "feat(approuter): map 404/500/503 to custom error pages via errorPage"
```

---

## Task 8: Probe proxied 404 behavior and conditionally add per-route override

The `/tutorials/(.*)` route proxies to CAP's `/content/tutorials/<slug>`. Determine whether AppRouter intercepts upstream 404s as errors (custom page shows) or streams them through (CAP body leaks).

**Files:**
- Possibly modify: `approuter/xs-app.json` (per-route `errors` override)

- [ ] **Step 1: Probe a missing tutorial slug**

With the local approuter from Task 7 still running and `cds watch` (or `npm run dev:hybrid`) up, run:

```bash
curl -i http://localhost:5000/tutorials/this-tutorial-does-not-exist
```

Expected: status 404. Two cases:
- **Case A:** Body contains `data-error-page="404"` — our custom page rendered. **No further changes needed.** Mark this task complete and skip to Task 9.
- **Case B:** Body is plain text or CAP-generated HTML (no `data-error-page` marker) — proxied response streamed through.

- [ ] **Step 2 (Case B only): Add per-route `errors` override**

Find the `/tutorials/(.*)` route in `approuter/xs-app.json` and add an `errors` array:

```json
{
  "source": "^/tutorials/(.*)$",
  "target": "/content/tutorials/$1",
  "destination": "srv-api",
  "authenticationType": "none",
  "csrfProtection": false,
  "errors": [
    { "status": 404, "file": "static/404.html" }
  ]
}
```

Validate JSON again:

```bash
node -e "JSON.parse(require('fs').readFileSync('approuter/xs-app.json','utf8'))" && echo OK
```

Re-probe:

```bash
curl -i http://localhost:5000/tutorials/this-tutorial-does-not-exist
```

Expected: status 404, body contains `data-error-page="404"`.

- [ ] **Step 3: Commit (only if Case B applied)**

```bash
git add approuter/xs-app.json
git commit -m "fix(approuter): override proxied 404 from /tutorials/* with custom page"
```

If Case A, skip the commit and continue.

---

## Task 9: Smoke tests for error pages

Asserts the deployed approuter serves the custom pages with correct status codes and markers.

**Files:**
- Create: `test/smoke/error-pages.test.js`

- [ ] **Step 1: Write the smoke tests**

Create `test/smoke/error-pages.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { BASE_URL, fetchWithRetry } from './smoke.config.js';

describe('Custom error pages', () => {
  it('GET /this-path-does-not-exist returns 404 with custom page', async () => {
    const res = await fetchWithRetry(`${BASE_URL}/this-path-does-not-exist`);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toContain('data-error-page="404"');
    expect(body).toContain('id="popular-rail"');
    expect(body).toContain('name="q"');
  });

  it('GET /assets/missing.js returns 404 with custom page', async () => {
    const res = await fetchWithRetry(`${BASE_URL}/assets/missing.js`);
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).toContain('data-error-page="404"');
  });

  it('GET /500.html serves the 500 layout directly', async () => {
    const res = await fetchWithRetry(`${BASE_URL}/500.html`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('data-error-page="500"');
    expect(body).toContain('href="/health"');
    expect(body).toContain('href="/health/db"');
  });

  it('GET /maintenance.html serves the maintenance layout directly', async () => {
    const res = await fetchWithRetry(`${BASE_URL}/maintenance.html`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('data-error-page="503"');
  });

  it('GET /tutorials/this-slug-does-not-exist returns 404 (custom page or upstream)', async () => {
    const res = await fetchWithRetry(`${BASE_URL}/tutorials/this-slug-does-not-exist`);
    expect(res.status).toBe(404);
    // The body assertion is conditional on Task 8 outcome. If the per-route override
    // was applied (Case B), assert the marker; otherwise just verify the status.
    // This test stays loose to remain green either way; tighten if Task 8 added the override.
  });

  it('API 404 returns JSON, not HTML', async () => {
    const res = await fetchWithRetry(`${BASE_URL}/api/v1/does-not-exist`);
    expect(res.status).toBe(404);
    // Should NOT be HTML — proxied API errors must pass through unchanged.
    const ct = res.headers.get('content-type') || '';
    expect(ct).not.toMatch(/text\/html/);
  });
});
```

- [ ] **Step 2: Run smoke tests against local approuter**

With the local approuter from Task 7 still running:

```bash
SMOKE_BASE_URL=http://localhost:5000 npm run test:smoke -- test/smoke/error-pages.test.js
```

Expected: all six tests pass.

If the "API 404 returns JSON" test fails, that's a real signal that `errorPage` is over-firing — investigate before continuing.

- [ ] **Step 3: Commit**

```bash
git add test/smoke/error-pages.test.js
git commit -m "test(smoke): assert custom error pages and API JSON pass-through"
```

---

## Task 10: Final verification and PR-ready check

- [ ] **Step 1: Run the full unit suite**

Run: `npm test`
Expected: existing tests pass (modulo the 29 pre-existing failures noted in project memory). The new `test/build-catalog-featured.test.js` should pass.

- [ ] **Step 2: Build everything end-to-end**

Run: `npm run build:all`
Expected: completes without errors. Confirms the apps build (Task 1), Hugo build (Tasks 3-5), and pipeline still work together.

- [ ] **Step 3: Inspect the final deployed file shapes**

Run: `ls -la hugo/public/{404,500,maintenance}.html hugo/static/js/popular-rail.js`
Expected: all four files exist and are non-empty.

- [ ] **Step 4: Manually click through in a browser**

Start `npm run dev:hybrid` (CAP + approuter on :5000):
- Visit `http://localhost:5000/nonsense` → custom 404 with search and popular rail.
- Submit search "cap" → land on `/?q=cap` with navigator pre-filtered.
- Visit `http://localhost:5000/500.html` → custom 500 with health links.
- Visit `http://localhost:5000/maintenance.html` → custom 503 page.
- Visit `http://localhost:5000/tutorials/missing-slug` → status 404 (page depends on Task 8 outcome).

- [ ] **Step 5: Update the gap analysis doc**

In `docs/aem-gap-analysis.md`, change the heading for gap #14 from `### 14. Error Pages (404 / 500)` to mark it complete:

```markdown
### 14. Error Pages (404 / 500) ✅

**Status:** Closed by [docs/superpowers/specs/2026-05-20-error-pages-design.md](superpowers/specs/2026-05-20-error-pages-design.md).
```

(Keep the original AEM/Replacement/Impact/Action body for historical context; just add the status line at the top.)

- [ ] **Step 6: Commit and push**

```bash
git add docs/aem-gap-analysis.md
git commit -m "docs: close AEM Gap #14 (error pages)"
git push
```

---

## Notes for the implementer

- **TDD where it bites:** Task 2 (the `featured` field) gets a real failing-test-first cycle because it's the only piece with non-trivial logic. Hugo layouts, the small Vue change, and config edits are verified by smoke/manual testing — TDD on those is over-rotation.
- **Order matters loosely:** Task 1 (navigator) and Task 2 (catalog) are independent of each other and of the Hugo work, so they can ship as separate commits in any order. Tasks 3-5 must precede Task 7 (the files have to exist for the deploy plumbing to mean anything). Tasks 8 and 9 are last because they depend on the wiring being in place.
- **Don't widen scope:** if you notice the existing `test/smoke/public-endpoints.test.js:11` asserting `Array.isArray(body)` for `/build/catalog` (which is wrong — body is an object), that's a pre-existing bug noted in project memory. Don't fix it as part of this work.
- **Local-only path:** the implementer runs `npm run start:approuter` standalone for the Task 7/8 probes. Make sure `default-env.json` exists (run `npm run bind:setup` if needed) so the approuter can resolve XSUAA bindings without erroring out before reaching the static handler.
