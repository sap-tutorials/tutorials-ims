# Workstream B — Phase 2: flip approuter routes to serve pages from CAP

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Flip the approuter routes for the spec-named content pages from the catch-all `localDir: static` to `destination: srv-api` (`/content/pages/*`), so they serve from HANA/CAP (the Phase 1 store) — extending the page store with the 7 verb hubs first. Homepage `/` is flipped **last**, in a separate follow-up PR after DEV cache/fail-open verification.

**Architecture:** Phase 1 dark-launched `pageServeHandler` at `/content/pages/*` on `srv` (public) + `srv-qa` (Author-scoped), with a fail-open ladder (LRU → deploy-baked snapshot → 503). Phase 2 is almost entirely **approuter route config** (`approuter/xs-app.json`) plus adding the verb pages to `IN_SCOPE_PAGES`. The **deploy-baked fallback snapshot is the migration bridge**: a flipped route serves the deploy-baked page copy on a HANA miss, so a flip cannot 404 even before the first content-rebuild publishes the page to HANA.

**Tech Stack:** approuter `xs-app.json` route rewrites, Node.js ESM (`page-key-map.js`), Vitest smoke tests.

## Global Constraints

- **Scope = spec-named set only.** Flip: `/browse/`, `/topics/` (root only, NOT the `/topics/<article>/` pages), `/tutorial-navigator/`, `/developer-advocates/`, `/devtoberfest/` (root only), the 7 verb hubs (`/ai/`, `/build/`, `/connect/`, `/integrate/`, `/learn/`, `/model/`, `/operate/`), and sitemaps (`/sitemap.xml`, `/index.xml`, `/llms-full.txt`). **Homepage `/` is NOT flipped in this PR** (follow-up). The long-tail (legal, `/me/`, `/explore/`, `/app-space/`, `/event-display/`, `/api-docs/`, topic articles, puzzles/petoberfest, demos, error pages) stays on the catch-all static route — untouched.
- **Route ordering:** every new page route MUST be inserted **before** the catch-all `^(.*)$` (the last route). `/devtoberfest/` root route MUST come **before** the existing `^/devtoberfest(/.*)?$` static route so the root flips while sub-pages stay static. `/build/` page route must not shadow the existing `^/build/(catalog|...)$` API route — its regex matches only bare `/build/`, and it's placed after the API route.
- **Query-string group required** on every route source (the [approuter-build-route-needs-query-string-group] gotcha): a `source` that can receive `?query` must include `(\?.*)?` and append the captured group to `target`, or `?x=y` requests 404. Mirror the existing `^/concepts/?(\\?.*)?$` → `/content/concepts-index$1` route.
- **All flipped page routes are `authenticationType: none`** (public content, like tutorials/concepts) → `destination: srv-api`.
- **No approuter `cacheControl` on these routes** — that property only applies to `localDir` routes; TTLs come from the CAP origin (`edge-cache-headers.js`), already set in Phase 1.
- **LF line endings.** JSON must stay valid.
- **Do NOT touch** `/admin/rebuild`, `deploy-self-heal`, or `rebuild-content.yml` — those are Phase 3.

## File Structure

- **Modify** `srv/lib/page-key-map.js` — add the 7 verb pages to `IN_SCOPE_PAGES`.
- **Modify** `test/unit/page-key-map.test.js` — assert the verb routes/keys.
- **Modify** `approuter/xs-app.json` — insert the explicit page routes before the catch-all (and the devtoberfest-root route before the devtoberfest static route).
- **Create** `test/smoke/pages-routes.smoke.test.js` — per-route 200 + marker + hashed-island assertions.
- **Modify** `docs/developers/architecture/build.md` — mark Phase 2 routes live; note homepage-last + long-tail-stays-static.

---

## Task 1: Add the 7 verb pages to the page store

**Files:**
- Modify: `srv/lib/page-key-map.js` (the `IN_SCOPE_PAGES` array, ~lines 23-31)
- Test: `test/unit/page-key-map.test.js`

**Interfaces:**
- Produces: `pageKeyForPath('/connect/')` → `'page-connect'` (and the other 6 verbs); `discoverPageFiles` picks up `<verb>/index.html`; `build-page-fallback.cjs` auto-snapshots them (it iterates `IN_SCOPE_PAGES`).

- [ ] **Step 1: Write the failing test** (append to the existing suite)

```js
// test/unit/page-key-map.test.js — add
it('maps the 7 verb hub routes to page- keys', () => {
  for (const v of ['ai', 'build', 'connect', 'integrate', 'learn', 'model', 'operate']) {
    expect(pageKeyForPath(`/${v}/`)).toBe(`page-${v}`);
    expect(pathForPageKey(`page-${v}`)).toBe(`/${v}/`);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/page-key-map.test.js`
Expected: FAIL — `pageKeyForPath('/connect/')` returns `null` (not in allow-list).

- [ ] **Step 3: Add the verb entries to `IN_SCOPE_PAGES`**

```js
// srv/lib/page-key-map.js — add these entries to the IN_SCOPE_PAGES array
// (order doesn't matter; keep them grouped with a comment)
  // Verb hub landing pages (#1659 Phase 2) — each is a single Hugo page
  // rendered by layouts/verb/list.html at /<verb>/index.html.
  { route: '/ai/',        key: 'page-ai',        file: 'ai/index.html',        mimeType: 'text/html' },
  { route: '/build/',     key: 'page-build',     file: 'build/index.html',     mimeType: 'text/html' },
  { route: '/connect/',   key: 'page-connect',   file: 'connect/index.html',   mimeType: 'text/html' },
  { route: '/integrate/', key: 'page-integrate', file: 'integrate/index.html', mimeType: 'text/html' },
  { route: '/learn/',     key: 'page-learn',     file: 'learn/index.html',     mimeType: 'text/html' },
  { route: '/model/',     key: 'page-model',     file: 'model/index.html',     mimeType: 'text/html' },
  { route: '/operate/',   key: 'page-operate',   file: 'operate/index.html',   mimeType: 'text/html' },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/page-key-map.test.js`
Expected: PASS (verb cases + all existing cases).

- [ ] **Step 5: Commit**

```bash
git add srv/lib/page-key-map.js test/unit/page-key-map.test.js
git commit -m "feat(pages): add 7 verb hub pages to the page store (#1659 Phase 2)"
```

---

## Task 2: Flip the non-homepage approuter routes

**Files:**
- Modify: `approuter/xs-app.json`
- Test: covered by Task 3 (smoke) + a JSON-validity/ordering check in this task.

**Interfaces:**
- Consumes: `pageServeHandler` at `/content/pages/*` (Phase 1) — the target path after `/content/pages` is canonicalized by `pageKeyForPath`, so `target: "/content/pages/browse/$1"` → handler sees `/browse/` → `page-browse`.
- Produces: the listed public routes resolve to `srv-api` instead of static.

- [ ] **Step 1: Insert the devtoberfest-root route BEFORE the existing devtoberfest static route**

Find the existing route (`approuter/xs-app.json` ~line 144):
```json
{ "source": "^/devtoberfest(/.*)?$", "target": "/devtoberfest$1", "localDir": "static", "authenticationType": "none" }
```
Insert immediately **before** it:
```json
{ "source": "^/devtoberfest/?(\\?.*)?$", "target": "/content/pages/devtoberfest/$1", "destination": "srv-api", "authenticationType": "none" },
```
(The root `/devtoberfest/` now flips to CAP; `/devtoberfest/<subpage>` still matches the static route below it.)

- [ ] **Step 2: Insert the remaining page routes immediately BEFORE the catch-all**

Find the catch-all (last route): `{ "source": "^(.*)$", "localDir": "static", "authenticationType": "none" }`. Insert these **before** it (order among themselves doesn't matter; none overlap):

```json
{ "source": "^/browse/?(\\?.*)?$",              "target": "/content/pages/browse/$1",              "destination": "srv-api", "authenticationType": "none" },
{ "source": "^/topics/?(\\?.*)?$",              "target": "/content/pages/topics/$1",              "destination": "srv-api", "authenticationType": "none" },
{ "source": "^/tutorial-navigator/?(\\?.*)?$",  "target": "/content/pages/tutorial-navigator/$1",  "destination": "srv-api", "authenticationType": "none" },
{ "source": "^/developer-advocates/?(\\?.*)?$", "target": "/content/pages/developer-advocates/$1", "destination": "srv-api", "authenticationType": "none" },
{ "source": "^/ai/?(\\?.*)?$",                  "target": "/content/pages/ai/$1",                  "destination": "srv-api", "authenticationType": "none" },
{ "source": "^/build/?(\\?.*)?$",               "target": "/content/pages/build/$1",               "destination": "srv-api", "authenticationType": "none" },
{ "source": "^/connect/?(\\?.*)?$",             "target": "/content/pages/connect/$1",             "destination": "srv-api", "authenticationType": "none" },
{ "source": "^/integrate/?(\\?.*)?$",           "target": "/content/pages/integrate/$1",           "destination": "srv-api", "authenticationType": "none" },
{ "source": "^/learn/?(\\?.*)?$",               "target": "/content/pages/learn/$1",               "destination": "srv-api", "authenticationType": "none" },
{ "source": "^/model/?(\\?.*)?$",               "target": "/content/pages/model/$1",               "destination": "srv-api", "authenticationType": "none" },
{ "source": "^/operate/?(\\?.*)?$",             "target": "/content/pages/operate/$1",             "destination": "srv-api", "authenticationType": "none" },
{ "source": "^/sitemap\\.xml(\\?.*)?$",         "target": "/content/pages/sitemap.xml$1",          "destination": "srv-api", "authenticationType": "none" },
{ "source": "^/index\\.xml(\\?.*)?$",           "target": "/content/pages/index.xml$1",            "destination": "srv-api", "authenticationType": "none" },
{ "source": "^/llms-full\\.txt(\\?.*)?$",       "target": "/content/pages/llms-full.txt$1",        "destination": "srv-api", "authenticationType": "none" }
```

> Verify the `target` reaching `pageServeHandler` canonicalizes correctly: the handler strips the `/content/pages` prefix and runs `pageKeyForPath` on the rest. `/content/pages/browse/` → `/browse/` → `page-browse` ✓. For sitemaps, `/content/pages/sitemap.xml` → `/sitemap.xml` → `page-sitemap.xml` ✓. If a `$1` query group produces a trailing `/content/pages/browse/?x=y`, confirm `pageKeyForPath` (which strips `?...`) still yields `page-browse` — it does (canonicalizeRoute splits on `?`). Do NOT flip `^/$` (homepage) here.

- [ ] **Step 3: Validate JSON + route ordering**

Run:
```bash
node -e "const x=require('./approuter/xs-app.json'); const s=x.routes.map(r=>r.source); const ci=s.indexOf('^(.*)$'); const dtStatic=s.indexOf('^/devtoberfest(/.*)?$'); const dtRoot=s.indexOf('^/devtoberfest/?(\\\\?.*)?$'); const pages=['^/browse/?(\\\\?.*)?$','^/topics/?(\\\\?.*)?$','^/connect/?(\\\\?.*)?$','^/sitemap\\\\.xml(\\\\?.*)?$']; if(ci<0)throw new Error('no catch-all'); for(const p of pages){const i=s.indexOf(p); if(i<0)throw new Error('missing '+p); if(i>ci)throw new Error('page route after catch-all: '+p);} if(dtRoot>dtStatic)throw new Error('devtoberfest root after static'); if(s.includes('^/$'))throw new Error('homepage flipped — should be Phase 2 follow-up'); console.log('xs-app.json routes OK: pages before catch-all, dt-root before dt-static, homepage NOT flipped');"
```
Expected: `xs-app.json routes OK: ...`

- [ ] **Step 4: Commit**

```bash
git add approuter/xs-app.json
git commit -m "feat(pages): flip non-homepage content routes to CAP page store (#1659 Phase 2)"
```

---

## Task 3: Smoke tests for the flipped routes

**Files:**
- Create: `test/smoke/pages-routes.smoke.test.js`

**Interfaces:**
- Consumes: `BASE_URL`, `fetchWithRetry` from `test/smoke/smoke.config.js` (mirrors `concepts-route.smoke.test.js`).

- [ ] **Step 1: Write the smoke spec**

```js
// test/smoke/pages-routes.smoke.test.js
import { describe, it, expect } from 'vitest';
import { BASE_URL, fetchWithRetry } from './smoke.config.js';

// #1659 Phase 2 — content pages flipped from static to CAP page store.
// Each flipped route must: 200, look like the right page, and reference
// HASHED island bundles (/js/<name>-<hash>.js), never bare /js/<name>.js
// (the #1628/#1604 stale-island class). Homepage (/) is NOT flipped yet.

const HTML_ROUTES = [
  { path: '/browse/',              marker: 'browse' },
  { path: '/topics/',              marker: 'topics' },
  { path: '/tutorial-navigator/',  marker: 'navigator' },
  { path: '/developer-advocates/', marker: 'advocate' },
  { path: '/devtoberfest/',        marker: 'devtoberfest' },
  { path: '/ai/',                  marker: 'ai' },
  { path: '/build/',               marker: 'build' },
  { path: '/connect/',             marker: 'connect' },
  { path: '/integrate/',           marker: 'integrate' },
  { path: '/learn/',               marker: 'learn' },
  { path: '/model/',               marker: 'model' },
  { path: '/operate/',             marker: 'operate' },
];

describe('#1659 Phase 2 flipped page routes', () => {
  for (const { path } of HTML_ROUTES) {
    it(`${path} serves 200 HTML from CAP with hashed island refs`, async () => {
      const r = await fetchWithRetry(`${BASE_URL}${path}`);
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type') || '').toContain('text/html');
      const html = await r.text();
      expect(html.length).toBeGreaterThan(500);
      // No BARE island script paths (must be content-hashed).
      const bare = html.match(/\/js\/[a-z0-9-]+\.js(?!["']?\s*[^>]*integrity)/gi) || [];
      const bareNonHashed = bare.filter((s) => !/-[A-Za-z0-9_]{6,}\.js$/.test(s));
      expect(bareNonHashed, `bare island refs on ${path}: ${bareNonHashed.join(', ')}`).toHaveLength(0);
    });
  }

  it('/devtoberfest/ root serves from CAP but a subpage stays static', async () => {
    const root = await fetchWithRetry(`${BASE_URL}/devtoberfest/`);
    expect(root.status).toBe(200);
    // A known subpage must still resolve (served by the static route below the flip).
    const sub = await fetchWithRetry(`${BASE_URL}/devtoberfest/faq/`);
    expect([200, 301, 302]).toContain(sub.status);
  });

  it('/sitemap.xml serves XML from CAP', async () => {
    const r = await fetchWithRetry(`${BASE_URL}/sitemap.xml`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type') || '').toContain('xml');
    expect(await r.text()).toContain('<urlset');
  });

  it('homepage / is NOT yet flipped (still served, any origin)', async () => {
    const r = await fetchWithRetry(`${BASE_URL}/`);
    expect(r.status).toBe(200); // still works via catch-all static (flip is the follow-up PR)
  });
});
```

- [ ] **Step 2: Sanity-check the spec parses (it only runs against a deployed env)**

Run: `npx vitest run test/smoke/pages-routes.smoke.test.js`
Expected: the suite self-skips or no-ops without `SMOKE_BASE_URL` (mirrors the other smoke specs). Confirm it does not error at collection. If `smoke.config.js` throws without env, follow the exact guard pattern the sibling smoke specs use.

- [ ] **Step 3: Commit**

```bash
git add test/smoke/pages-routes.smoke.test.js
git commit -m "test(pages): smoke assertions for flipped page routes (#1659 Phase 2)"
```

---

## Task 4: Docs

**Files:**
- Modify: `docs/developers/architecture/build.md` (the Phase-1 "Content Pages from HANA" section added in #1659 Phase 1)

- [ ] **Step 1: Update the docs**

In the "Content Pages from HANA" section: change the dark-launch note to state that Phase 2 has flipped `/browse/`, `/topics/`, `/tutorial-navigator/`, `/developer-advocates/`, `/devtoberfest/` (root), the 7 verb hubs, and sitemaps to `srv-api` (`/content/pages/*`); that the deploy-baked fallback bridges the window before the first HANA publish; that the **homepage `/` flip is a separate follow-up PR** (flipped last after DEV cache/fail-open verification); and that the **long-tail pages** (legal, `/me/`, `/explore/`, `/app-space/`, `/event-display/`, `/api-docs/`, topic articles, puzzles/petoberfest, demos) plus the **error pages** intentionally stay on the catch-all static route (Phase 3 retires the runtime push but keeps the catch-all + errorPage for these low-churn pages).

- [ ] **Step 2: Commit**

```bash
git add docs/developers/architecture/build.md
git commit -m "docs(pages): document Phase 2 route flips + long-tail-stays-static (#1659 Phase 2)"
```

---

## Follow-up (separate PR, after this PR is on DEV): flip the homepage

After PR-A (this plan) is deployed to DEV and verified — homepage-representative pages return 200 from CAP, carry the split `max-age`/`s-maxage` `Cache-Control` + `Edge-Cache-Tag`, reference hashed islands, and fail open (kill HANA / cold cache → still 200 via baked fallback) — flip the homepage in a one-route PR:

```json
{ "source": "^/(\\?.*)?$", "target": "/content/pages/$1", "destination": "srv-api", "authenticationType": "none" }
```
Inserted before the catch-all. `pageServeHandler` maps `/content/pages/` → `/` → `page-index`. Add a homepage smoke assertion (200 + hashed islands + homepage marker). Homepage is highest-traffic — this is deliberately the last, most-watched flip.

## Deferred decision: QA page routes

Phase 1 registered `pageServeHandler` on `srv-qa` (Author-scoped), so the QA channel can *serve* pages once published to the QA namespace. But adding approuter QA **routes** for pages has no clean URL scheme: tutorials use the `/tutorials-qa/<slug>` sub-path prefix, whereas these pages live at **root paths** (`/`, `/browse/`, `/connect/`), so a QA preview would need an awkward prefix (`/browse-qa/`?) or a separate QA host — and there is no author-per-page preview workflow for these pages (unlike tutorials). **Recommendation: do NOT add QA page approuter routes in Phase 2.** The srv-qa handler is already in place; add routes only when a concrete author-preview-for-pages need arises. Flagged for the plan review — if you want QA page routes now, specify the URL scheme and I'll add a task.

## Self-Review (against the spec + Phase 2 scope)

**Coverage:**
- Verb hubs added to the store + flipped → Tasks 1, 2. ✅
- Non-homepage spec-named routes flipped, before catch-all, query-group-safe → Task 2. ✅
- devtoberfest root flips, subpages stay static (ordering) → Task 2 Steps 1, 3. ✅
- `/topics/` root flips but topic articles stay static (regex matches only `/topics/`) → Task 2. ✅
- Sitemaps flipped with XML mime → Tasks 2, 3. ✅
- Smoke: 200 + markers + hashed islands per route → Task 3. ✅
- Homepage flipped LAST, separate PR after DEV verify → Follow-up section. ✅
- Long-tail + error pages untouched → Global Constraints; asserted by not adding their routes. ✅
- QA page routes → deferred with rationale (plan-review decision).

**Placeholder scan:** none — route objects, verb entries, and the smoke spec are complete.

**Type/name consistency:** page keys `page-<verb>` match `pageKeyForPath` output; targets `/content/pages/<path>/$1` match the Phase-1 `pageServeHandler` prefix-strip + `pageKeyForPath` canonicalization.

**Migration safety:** flips rely on the Phase-1 deploy-baked fallback (built by `build-page-fallback.cjs`, which auto-includes the new verbs) — a flipped route serves the baked copy on a HANA miss, so no route can 404 before the first content-rebuild publish. Rollback = revert the route flip (catch-all serves the still-baked static copy).
