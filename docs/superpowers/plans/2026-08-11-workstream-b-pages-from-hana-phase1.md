# Workstream B — Pages from HANA/CAP: Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish and serve the remaining Hugo content pages (homepage, `/browse/`, `/topics/`, `/devtoberfest/`, `/tutorial-navigator/`, `/developer-advocates/`, verb/landing pages, sitemaps) as HANA-backed BLOBs through the existing content-store, dark-launched at internal `/content/pages/*` paths — **no approuter route flips, fully additive**.

**Architecture:** Pages are Hugo-built HTML, mechanically identical to tutorials. They ride the existing `ContentFiles`/`ContentManifest` delta pipeline under a new `page-` key namespace, published by `publish-content.ts` as extra entries in the existing publish map, and served by a new self-contained `pageServeHandler` (shares the content-store's LRU cache, active-version lookup, and edge-cache headers; fail-open ladder). Registered on both the prod `srv` and QA `srv-qa` CAP apps.

**Tech Stack:** Node.js ESM, SAP CAP (`@sap/cds`), Express handlers, HANA (raw SQL for BLOB reads), Vitest, TypeScript publish script.

## Global Constraints

- **No new DB migration in Phase 1** — reuse `ContentFiles`/`ContentManifest`; pages are rows keyed `page-<name>` alongside tutorials (bare slug) and concepts (`concept-<slug>`).
- **Key convention:** `page-<flattened-lowercased-route>`, e.g. `/`→`page-index`, `/browse/`→`page-browse`, `/sitemap.xml`→`page-sitemap.xml`. One module (`srv/lib/page-key-map.js`) owns the bijection and is the sole validator (an arbitrary path must never mint a page key).
- **Fail-open everywhere on the serve path** — a HANA error / cache miss on a page must never 500; serve last-good LRU → baked fallback → `503` with `max-age=60`.
- **Never SELECT a HANA BLOB alongside metadata in one CDS QL query** — LOB locators expire. Read the BLOB via raw `db.run()` (mirror the existing `serveHandler` pattern); HANA columns are UPPERCASE in raw SQL.
- **Secrets from the Credential Store**, never hardcoded (not touched in Phase 1, but the pattern holds).
- **Test bootstrap:** unit tests use `cds.test('serve', '--project', '.', '--in-memory')` (the bare `cds.deploy(cds.model)` bootstrap is broken in this repo). Hybrid tests MUST be run with `--project hybrid`; a bare `vitest <file>` silently skips hybrid setup.
- **Windows/CRLF:** normalize line endings at boundaries; JS regex `$` excludes `\r`.
- **Commit frequently**, one deliverable per task. Do not flip any approuter route in Phase 1.

---

## File Structure

- **Create** `srv/lib/page-key-map.js` — route↔key bijection, in-scope allow-list, `discoverPageFiles(hugoDir)`. Imported by `srv/server.js`, `srv-qa/server.js`, `scripts/publish-content.ts`.
- **Modify** `srv/lib/edge-cache-headers.js` — add the `page-` branch to `cacheTagsFor`.
- **Modify** `srv/lib/content-store.js` — add `pageServeHandler` inside `createContentHandlers`, add it to the returned object (~:1692) and the bottom-of-file re-exports (~:1717), plus a module-internal `serveStoredSlug` helper factored from `serveHandler`'s ContentFiles branch and reused by both.
- **Create** `srv/page-fallback/` (build-populated) + `srv/lib/page-fallback.js` — the deploy-baked fail-open snapshot reader.
- **Modify** `srv/server.js` — import + `app.get('/content/pages/*', pageServeHandler)` (dark launch).
- **Modify** `srv-qa/server.js` — register `pageServeHandler` on the QA instance.
- **Modify** `scripts/publish-content.ts` — import `discoverPageFiles`, merge pages into the publish map before `computeLocalHashes`.
- **Create** tests: `test/unit/page-key-map.test.js`, `test/unit/page-serve-handler.test.js`; **modify** `test/unit/edge-cache-headers.test.js`; **create** `test/hybrid/page-publish-serve.test.js`.

---

## Task 1: `page-key-map.js` — route↔key bijection + allow-list

**Files:**
- Create: `srv/lib/page-key-map.js`
- Test: `test/unit/page-key-map.test.js`

**Interfaces:**
- Produces:
  - `PAGE_KEY_PREFIX = 'page-'`
  - `pageKeyForPath(path: string): string | null` — canonical route → `page-<name>` key, or `null` if not an in-scope page.
  - `pathForPageKey(key: string): string | null` — inverse, or `null`.
  - `isPageKey(key: string): boolean`
  - `discoverPageFiles(hugoDir: string): Map<string,string>` — maps `page-<name>` → absolute file path for every in-scope page present under `hugoDir`.
  - `IN_SCOPE_PAGES: Array<{ route: string, key: string, file: string, mimeType: string }>`

- [ ] **Step 1: Write the failing test**

```js
// test/unit/page-key-map.test.js
import { describe, it, expect } from 'vitest';
import {
  pageKeyForPath, pathForPageKey, isPageKey, discoverPageFiles, IN_SCOPE_PAGES,
} from '../../srv/lib/page-key-map.js';

describe('page-key-map', () => {
  it('maps in-scope routes to page- keys', () => {
    expect(pageKeyForPath('/')).toBe('page-index');
    expect(pageKeyForPath('/browse/')).toBe('page-browse');
    expect(pageKeyForPath('/topics/')).toBe('page-topics');
    expect(pageKeyForPath('/tutorial-navigator/')).toBe('page-tutorial-navigator');
    expect(pageKeyForPath('/developer-advocates/')).toBe('page-developer-advocates');
    expect(pageKeyForPath('/devtoberfest/')).toBe('page-devtoberfest');
    expect(pageKeyForPath('/sitemap.xml')).toBe('page-sitemap.xml');
    expect(pageKeyForPath('/index.xml')).toBe('page-index.xml');
    expect(pageKeyForPath('/llms-full.txt')).toBe('page-llms-full.txt');
  });

  it('normalizes trailing slash and case', () => {
    expect(pageKeyForPath('/Browse')).toBe('page-browse');
    expect(pageKeyForPath('/browse')).toBe('page-browse');
  });

  it('rejects out-of-scope paths (allow-list is the validator)', () => {
    expect(pageKeyForPath('/tutorials/foo')).toBeNull();
    expect(pageKeyForPath('/../etc/passwd')).toBeNull();
    expect(pageKeyForPath('/admin/rebuild')).toBeNull();
    expect(pageKeyForPath('/random-page/')).toBeNull();
  });

  it('is a bijection for every in-scope page', () => {
    for (const p of IN_SCOPE_PAGES) {
      expect(pageKeyForPath(p.route)).toBe(p.key);
      expect(pathForPageKey(p.key)).toBe(p.route);
      expect(isPageKey(p.key)).toBe(true);
    }
  });

  it('isPageKey rejects tutorial/concept keys', () => {
    expect(isPageKey('abap-basics')).toBe(false);
    expect(isPageKey('concept-oauth')).toBe(false);
    expect(isPageKey('group-getting-started')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/page-key-map.test.js`
Expected: FAIL — cannot resolve `../../srv/lib/page-key-map.js`.

- [ ] **Step 3: Write minimal implementation**

```js
// srv/lib/page-key-map.js
import fs from 'node:fs';
import path from 'node:path';

export const PAGE_KEY_PREFIX = 'page-';

// The fixed allow-list IS the validator: only these routes become page keys.
// `file` is relative to the Hugo output dir (hugo/public).
// Verb/landing pages are enumerated here explicitly — add new ones to this list.
export const IN_SCOPE_PAGES = [
  { route: '/',                      key: 'page-index',               file: 'index.html',                mimeType: 'text/html' },
  { route: '/browse/',               key: 'page-browse',              file: 'browse/index.html',         mimeType: 'text/html' },
  { route: '/topics/',               key: 'page-topics',              file: 'topics/index.html',         mimeType: 'text/html' },
  { route: '/tutorial-navigator/',   key: 'page-tutorial-navigator',  file: 'tutorial-navigator/index.html', mimeType: 'text/html' },
  { route: '/developer-advocates/',  key: 'page-developer-advocates', file: 'developer-advocates/index.html', mimeType: 'text/html' },
  { route: '/devtoberfest/',         key: 'page-devtoberfest',        file: 'devtoberfest/index.html',   mimeType: 'text/html' },
  { route: '/sitemap.xml',           key: 'page-sitemap.xml',         file: 'sitemap.xml',               mimeType: 'application/xml' },
  { route: '/index.xml',             key: 'page-index.xml',           file: 'index.xml',                 mimeType: 'application/xml' },
  { route: '/llms-full.txt',         key: 'page-llms-full.txt',       file: 'llms-full.txt',             mimeType: 'text/plain' },
];

const _byRoute = new Map(IN_SCOPE_PAGES.map((p) => [p.route, p]));
const _byKey = new Map(IN_SCOPE_PAGES.map((p) => [p.key, p]));

// Canonicalize an inbound path to the allow-list route form:
// lowercase; ensure a leading slash; for extensionless routes ensure a single
// trailing slash. Paths containing '..' or backslashes are rejected outright.
function canonicalizeRoute(input) {
  if (typeof input !== 'string' || !input) return null;
  if (input.includes('..') || input.includes('\\')) return null;
  let p = input.split('?')[0].split('#')[0].toLowerCase();
  if (!p.startsWith('/')) p = `/${p}`;
  const hasExt = /\.[a-z0-9]+$/.test(p);
  if (!hasExt && !p.endsWith('/')) p = `${p}/`;
  return p;
}

export function pageKeyForPath(input) {
  const route = canonicalizeRoute(input);
  if (route === null) return null;
  const hit = _byRoute.get(route);
  return hit ? hit.key : null;
}

export function pathForPageKey(key) {
  const hit = _byKey.get(key);
  return hit ? hit.route : null;
}

export function isPageKey(key) {
  return typeof key === 'string' && _byKey.has(key);
}

export function mimeTypeForPageKey(key) {
  const hit = _byKey.get(key);
  return hit ? hit.mimeType : 'text/html';
}

// Map each in-scope page that actually exists under hugoDir to its page key.
export function discoverPageFiles(hugoDir) {
  const out = new Map();
  for (const p of IN_SCOPE_PAGES) {
    const abs = path.join(hugoDir, p.file);
    if (fs.existsSync(abs)) out.set(p.key, abs);
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/page-key-map.test.js`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add srv/lib/page-key-map.js test/unit/page-key-map.test.js
git commit -m "feat(pages): page-key-map route<->key bijection + allow-list (#1659)"
```

---

## Task 2: Extend `cacheTagsFor` with page tags

**Files:**
- Modify: `srv/lib/edge-cache-headers.js:33-48`
- Test: `test/unit/edge-cache-headers.test.js`

**Interfaces:**
- Consumes: `PAGE_KEY_PREFIX` from Task 1 (or inline the `'page-'` check to avoid a runtime import cycle — `edge-cache-headers.js` is imported widely; inline the literal and comment it).
- Produces: `cacheTagsFor('page-browse')` → `['content', 'page', 'page-browse']`; `cacheTagsFor('page-sitemap.xml')` → `['content', 'page', 'page-sitemap.xml']` (token sanitized).

- [ ] **Step 1: Write the failing test** (append to the existing suite)

```js
// test/unit/edge-cache-headers.test.js — add these cases
import { cacheTagsFor } from '../../srv/lib/edge-cache-headers.js';

it('emits page tags for page- keys', () => {
  expect(cacheTagsFor('page-browse')).toEqual(['content', 'page', 'page-browse']);
  expect(cacheTagsFor('page-index')).toEqual(['content', 'page', 'page-index']);
});

it('sanitizes dotted page keys into a valid tag token', () => {
  // '.' is not in [A-Za-z0-9_-] → replaced with '-'
  expect(cacheTagsFor('page-sitemap.xml')).toEqual(['content', 'page', 'page-sitemap-xml']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/edge-cache-headers.test.js`
Expected: FAIL — current `else` branch returns `['content', 'item-page-browse']`.

- [ ] **Step 3: Implement — add the `page-` branch before the final `else`**

```js
// srv/lib/edge-cache-headers.js — inside cacheTagsFor, add before the else:
  } else if (slug.startsWith('page-')) {
    // Content pages (#1659) — coarse `page` tag + a per-page tag so a publish
    // can purge one page or the whole page set.
    tags.push('page', `page-${tagToken(slug.slice('page-'.length))}`);
  } else {
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/edge-cache-headers.test.js`
Expected: PASS (new + existing cases).

- [ ] **Step 5: Commit**

```bash
git add srv/lib/edge-cache-headers.js test/unit/edge-cache-headers.test.js
git commit -m "feat(pages): page- Edge-Cache-Tag scheme (#1659)"
```

---

## Task 3: Factor `serveStoredSlug` helper + add `pageServeHandler`

**Files:**
- Modify: `srv/lib/content-store.js` — inside `createContentHandlers` (the ContentFiles-serve branch of `serveHandler`, ~:1049-1099); add `serveStoredSlug` and `pageServeHandler`; add both/handler to `return {}` (~:1692); re-export `pageServeHandler` at bottom (~:1717-1728).
- Test: `test/unit/page-serve-handler.test.js`

**Interfaces:**
- Consumes: `pageKeyForPath`, `mimeTypeForPageKey` (Task 1); `setContentCacheHeaders` (Task 2); the existing `createContentHandlers` internals — the `cache` (`ContentCache` instance), `getActiveVersion()`, `hanaTableName()`, and `refreshCacheGeneration()`.
- Produces: `pageServeHandler(req, res)` — Express handler mounted at `/content/pages/*`. Resolves the request path (strip the `/content/pages` prefix) → `page-` key via `pageKeyForPath`; serves the stored BLOB via `serveStoredSlug`; fail-open ladder on error.
- Produces: `serveStoredSlug(req, res, { slug, tagSlug, mimeType })` — module-internal reusable serve-from-ContentFiles core (also called by the existing tutorial ContentFiles branch to keep DRY).

- [ ] **Step 1: Write the failing test**

```js
// test/unit/page-serve-handler.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

// In-memory CAP bootstrap (the repo-standard pattern; bare cds.deploy is broken here).
const test = cds.test('serve', '--project', '.', '--in-memory');

const NS = 'com.sap.developers.ims';

async function seedPage(key, html, mimeType = 'text/html') {
  const db = await cds.connect.to('db');
  const { ContentFiles, ContentManifest } = cds.entities(NS);
  const gz = gzipSync(Buffer.from(html));
  const hash = createHash('sha256').update(html).digest('hex');
  await db.run(INSERT.into(ContentManifest).entries({
    version: 1, status: 'ACTIVE', fileCount: 1, changedSlugs: JSON.stringify([key]),
  }));
  await db.run(INSERT.into(ContentFiles).entries({
    slug: key, version: 1, content: gz, contentHash: hash,
    mimeType, sizeBytes: html.length, compressedBytes: gz.length,
  }));
}

describe('pageServeHandler', () => {
  let pageServeHandler;
  beforeAll(async () => {
    ({ pageServeHandler } = await import('../../srv/lib/content-store.js'));
    await seedPage('page-browse', '<!doctype html><title>Browse</title>');
  });

  function mockReqRes(path) {
    const req = { path, url: path, headers: {} };
    const res = {
      statusCode: 200, headers: {}, body: null,
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      status(c) { this.statusCode = c; return this; },
      send(b) { this.body = b; return this; },
      end(b) { if (b) this.body = b; return this; },
    };
    return { req, res };
  }

  it('serves a stored page BLOB with content + edge headers', async () => {
    const { req, res } = mockReqRes('/content/pages/browse/');
    await pageServeHandler(req, res);
    expect(res.statusCode).toBe(200);
    expect(String(res.body)).toContain('Browse');
    expect(res.headers['cache-control']).toContain('s-maxage=86400');
    expect(res.headers['edge-cache-tag']).toContain('page-browse');
  });

  it('404s an out-of-scope page path (fail-open, short TTL)', async () => {
    const { req, res } = mockReqRes('/content/pages/not-a-page/');
    await pageServeHandler(req, res);
    expect(res.statusCode).toBe(404);
    expect(res.headers['cache-control']).toContain('max-age=60');
  });

  it('404s an in-scope page that has not been published yet', async () => {
    const { req, res } = mockReqRes('/content/pages/topics/');
    await pageServeHandler(req, res);
    expect(res.statusCode).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/page-serve-handler.test.js`
Expected: FAIL — `pageServeHandler` is not exported.

- [ ] **Step 3a: Extract `serveStoredSlug` from `serveHandler`'s ContentFiles branch**

In `srv/lib/content-store.js`, inside `createContentHandlers`, lift the existing ContentFiles-serve logic (~:1049-1099: `getActiveVersion` → metadata SELECT → raw-SQL BLOB read → gunzip → LRU cache → `ETag` + `setContentCacheHeaders` + `X-Content-Source: db` → send; the not-found path → `serveNotFound`) into a local function. Keep the existing `serveHandler` calling it so tutorial behavior is byte-identical:

```js
// New module-internal helper (inside createContentHandlers)
// Serves a stored slug from ContentFiles + LRU cache, fail-open to 404.
// `tagSlug` drives Edge-Cache-Tag (defaults to slug); `mimeType` overrides the
// stored mime (used by pages for XML/text). Returns true if it sent a 200.
async function serveStoredSlug(req, res, { slug, tagSlug = slug, mimeType } = {}) {
  await refreshCacheGeneration();
  const cached = cache.get(slug);
  if (cached) {
    res.setHeader('ETag', `"${cached.contentHash}"`);
    if (req.headers['if-none-match'] === `"${cached.contentHash}"`) {
      setContentCacheHeaders(res, { slug: tagSlug });
      res.status(304).end();
      return true;
    }
    res.setHeader('Content-Type', mimeType || cached.mimeType || 'text/html; charset=utf-8');
    setContentCacheHeaders(res, { slug: tagSlug });
    res.setHeader('X-Content-Source', 'memcache');
    res.status(200).end(cached.buffer);
    return true;
  }
  const version = await getActiveVersion();
  if (version == null) return false;
  const { ContentFiles } = cds.entities(namespace);
  const [meta] = await SELECT.from(ContentFiles)
    .columns('contentHash', 'mimeType', 'version')
    .where`slug = ${slug} and version = ${version}`;
  if (!meta) return false;
  const db = await cds.connect.to('db');
  const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
  let gz;
  if (isHana) {
    const rows = await db.run(
      `SELECT TOP 1 "CONTENT" FROM ${hanaTableName()} WHERE SLUG = ? AND VERSION = ?`,
      [slug, version],
    );
    gz = toBuffer(rows?.[0]?.CONTENT);
  } else {
    const [row] = await SELECT.from(ContentFiles).columns('content').where`slug = ${slug} and version = ${version}`;
    gz = toBuffer(row?.content);
  }
  const buffer = gunzipSync(gz);
  cache.set(slug, { buffer, contentHash: meta.contentHash, mimeType: meta.mimeType });
  res.setHeader('ETag', `"${meta.contentHash}"`);
  res.setHeader('Content-Type', mimeType || meta.mimeType || 'text/html; charset=utf-8');
  setContentCacheHeaders(res, { slug: tagSlug });
  res.setHeader('X-Content-Source', 'db');
  res.status(200).end(buffer);
  return true;
}
```

> Note for the implementer: match the ACTUAL existing branch (exact cache field names, `toBuffer`, `gunzipSync`, `serveNotFound`, the `isHana` probe) rather than the sketch above — read `serveHandler` ~:1049-1099 first and factor verbatim so tutorial serving is unchanged. Verify `refreshCacheGeneration`, `cache`, `getActiveVersion`, `hanaTableName`, `toBuffer` are all in scope inside `createContentHandlers`.

- [ ] **Step 3b: Add `pageServeHandler`**

```js
// inside createContentHandlers
async function pageServeHandler(req, res) {
  // Strip the mount prefix; pageKeyForPath canonicalizes + validates.
  const rest = String(req.path || req.url || '').replace(/^\/content\/pages/, '') || '/';
  const key = pageKeyForPath(rest);
  if (!key) return serveNotFound(req, res); // out-of-scope → 404, max-age=60
  try {
    const mimeType = mimeTypeForPageKey(key);
    const sent = await serveStoredSlug(req, res, { slug: key, tagSlug: key, mimeType });
    if (sent) return;
    // In-scope but unpublished → fail-open ladder.
    if (servePageFallback(res, key)) return;   // Task 4 (baked snapshot)
    return serveNotFound(req, res);
  } catch (err) {
    LOG.warn(`[pages] serve failed for ${key}:`, err?.message ?? err);
    if (servePageFallback(res, key)) return;
    res.status(503);
    res.setHeader('Cache-Control', 'public, max-age=60');
    return res.end('Service Unavailable');
  }
}
```

> `servePageFallback` is added in Task 4; for Step 3 stub it as `function servePageFallback() { return false; }` so this task's tests pass, and replace the stub in Task 4. Import `pageKeyForPath`, `mimeTypeForPageKey` from `./page-key-map.js` at the top of `content-store.js`. Add `pageServeHandler` to the `return { ... }` object (~:1692) and add `export const pageServeHandler = _defaults.pageServeHandler;` at the bottom (~:1728).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/page-serve-handler.test.js`
Expected: PASS. Then run the tutorial serve regression: `npx vitest run test/unit/content-store*.test.js` — Expected: PASS (serveStoredSlug refactor is behavior-preserving).

- [ ] **Step 5: Commit**

```bash
git add srv/lib/content-store.js test/unit/page-serve-handler.test.js
git commit -m "feat(pages): pageServeHandler + serveStoredSlug refactor (#1659)"
```

---

## Task 4: Baked fallback snapshot + `servePageFallback`

**Files:**
- Create: `srv/lib/page-fallback.js`
- Create: `srv/page-fallback/.gitkeep` (build-populated dir; snapshot HTML copied here at build time)
- Modify: `srv/lib/content-store.js` — replace the Task 3 `servePageFallback` stub with a call into `page-fallback.js`.
- Modify: `scripts/build-page-fallback.cjs` (create) + wire into `build:all` explicitly (NOT a `post*` hook — those are silenced by `ignore-scripts=true` here).
- Test: `test/unit/page-fallback.test.js`

**Interfaces:**
- Produces: `loadPageFallback(key: string): { buffer: Buffer, mimeType: string } | null` — reads `srv/page-fallback/<key>.<ext>` if present; caches in-process. `servePageFallback(res, key): boolean` in content-store.js sends it with `X-Content-Source: fallback` + `max-age=60` and returns true, else false.

- [ ] **Step 1: Write the failing test**

```js
// test/unit/page-fallback.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPageFallback } from '../../srv/lib/page-fallback.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'srv', 'page-fallback');

describe('page-fallback', () => {
  beforeAll(() => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'page-index.html'), '<!doctype html><title>Home fallback</title>');
  });
  it('loads a baked fallback for a page key', () => {
    const fb = loadPageFallback('page-index');
    expect(fb).not.toBeNull();
    expect(String(fb.buffer)).toContain('Home fallback');
    expect(fb.mimeType).toBe('text/html');
  });
  it('returns null when no snapshot exists', () => {
    expect(loadPageFallback('page-topics')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/page-fallback.test.js`
Expected: FAIL — cannot resolve `page-fallback.js`.

- [ ] **Step 3: Implement `page-fallback.js`, wire `servePageFallback`, add the build step**

```js
// srv/lib/page-fallback.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mimeTypeForPageKey } from './page-key-map.js';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'page-fallback');
const EXT = { 'text/html': 'html', 'application/xml': 'xml', 'text/plain': 'txt' };
const _cache = new Map();

export function loadPageFallback(key) {
  if (_cache.has(key)) return _cache.get(key);
  const mimeType = mimeTypeForPageKey(key);
  const file = path.join(DIR, `${key}.${EXT[mimeType] || 'html'}`);
  let result = null;
  try {
    if (fs.existsSync(file)) result = { buffer: fs.readFileSync(file), mimeType };
  } catch { /* fail-open: no fallback */ }
  _cache.set(key, result);
  return result;
}
```

Replace the stub in `content-store.js`:

```js
import { loadPageFallback } from './page-fallback.js';
function servePageFallback(res, key) {
  const fb = loadPageFallback(key);
  if (!fb) return false;
  res.setHeader('Content-Type', `${fb.mimeType}; charset=utf-8`);
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.setHeader('X-Content-Source', 'fallback');
  res.status(200).end(fb.buffer);
  return true;
}
```

Build step `scripts/build-page-fallback.cjs` (copies in-scope page HTML from `hugo/public` into `srv/page-fallback/<key>.<ext>` using the same `IN_SCOPE_PAGES` list), added as an **explicit** line in the `build:all` script in `package.json` (after the Hugo build), and documented in CLAUDE.md's build gotchas as another artifact that must not rely on a lifecycle hook.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/page-fallback.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add srv/lib/page-fallback.js srv/page-fallback/.gitkeep scripts/build-page-fallback.cjs package.json srv/lib/content-store.js test/unit/page-fallback.test.js
git commit -m "feat(pages): deploy-baked fail-open fallback snapshot (#1659)"
```

---

## Task 5: Register `pageServeHandler` on `srv` and `srv-qa` (dark launch)

**Files:**
- Modify: `srv/server.js` — import `pageServeHandler`; `app.get('/content/pages/*', pageServeHandler)` near the other `/content/*` routes (~:447-486).
- Modify: `srv-qa/server.js` — register the QA instance's `pageServeHandler` on the QA content mount (mirror how it registers `serveHandler`, ~:81-110).
- Test: covered by Task 6 (hybrid round-trip); add a boot-smoke assertion here.

- [ ] **Step 1: Write the failing test** (route is registered, returns 404 not 501/crash for an unpublished page)

```js
// test/unit/page-route-registered.test.js
import { describe, it, expect } from 'vitest';
import cds from '@sap/cds';
const test = cds.test('serve', '--project', '.', '--in-memory');

describe('/content/pages route', () => {
  it('is mounted and 404s an unpublished in-scope page (not 500/unhandled)', async () => {
    const res = await test.get('/content/pages/topics/').catch((e) => e.response);
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/page-route-registered.test.js`
Expected: FAIL — route not mounted (unexpected status / unhandled).

- [ ] **Step 3: Register the route**

```js
// srv/server.js — with the other /content/* GET routes
import { /* …existing…, */ pageServeHandler } from './lib/content-store.js';
// #1659 Task 5 — CAP-served content PAGES. Dark launch: no AppRouter route
// points here yet (the per-page flips land in Phase 2). Public, no auth —
// like serveHandler.
app.get('/content/pages/*', pageServeHandler);
```

For `srv-qa/server.js`, obtain `pageServeHandler` from that file's `createContentHandlers({ namespace: 'com.sap.developers.ims.qa', ... })` result (not the prod re-export) and mount it on the QA content path.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/page-route-registered.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add srv/server.js srv-qa/server.js test/unit/page-route-registered.test.js
git commit -m "feat(pages): dark-launch /content/pages on srv + srv-qa (#1659)"
```

---

## Task 6: Publish pages in `publish-content.ts` + hybrid round-trip

**Files:**
- Modify: `scripts/publish-content.ts` — import `discoverPageFiles`; after `validateProductionBuild`/`stripCatalogSlugs` and before `computeLocalHashes` (~:973), merge page entries into the `tutorials` map.
- Test: `test/hybrid/page-publish-serve.test.js`

**Interfaces:**
- Consumes: `discoverPageFiles(hugoDir)` (Task 1); the existing `Map<string,string>` publish map + `computeLocalHashes`/`beginSession`/`appendBatch`/`commitSession` pipeline.
- Produces: pages are published as `page-<name>` ContentFiles rows in the same version as tutorials; served by `pageServeHandler`.

- [ ] **Step 1: Write the failing hybrid test**

```js
// test/hybrid/page-publish-serve.test.js
import { describe, it, expect } from 'vitest';
import cds from '@sap/cds';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const test = cds.test('serve', '--project', '.'); // hybrid: real HANA via cds bind --exec
const NS = 'com.sap.developers.ims';

// Simulate a committed page publish, then serve it back through the route.
describe('page publish→serve round-trip (hybrid)', () => {
  it('serves a published sitemap with XML mime from HANA', async () => {
    const db = await cds.connect.to('db');
    const { ContentFiles, ContentManifest } = cds.entities(NS);
    const xml = '<?xml version="1.0"?><urlset><url><loc>https://x/</loc></url></urlset>';
    const [{ maxv } = {}] = await db.run(SELECT.one.from(ContentManifest).columns({ func: 'max', args: [{ ref: ['version'] }], as: 'maxv' }));
    const version = (maxv || 0) + 1;
    await db.run(INSERT.into(ContentManifest).entries({ version, status: 'ACTIVE', fileCount: 1, changedSlugs: JSON.stringify(['page-sitemap.xml']) }));
    await db.run(UPDATE(ContentManifest).set({ status: 'SUPERSEDED' }).where`version < ${version}`);
    const gz = gzipSync(Buffer.from(xml));
    await db.run(INSERT.into(ContentFiles).entries({
      slug: 'page-sitemap.xml', version, content: gz,
      contentHash: createHash('sha256').update(xml).digest('hex'),
      mimeType: 'application/xml', sizeBytes: xml.length, compressedBytes: gz.length,
    }));
    const res = await test.get('/content/pages/sitemap.xml');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('xml');
    expect(String(res.data)).toContain('<urlset>');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project hybrid test/hybrid/page-publish-serve.test.js` (requires `cf login` + `cds bind`)
Expected: FAIL until the route/serve path handle the XML mime end-to-end (or PASS for serve if Tasks 3/5 landed — in that case this test is the regression guard; the publish-integration assertion below is the failing part).

- [ ] **Step 3: Wire page discovery into the publish map**

```ts
// scripts/publish-content.ts — near the top imports
import { discoverPageFiles } from '../srv/lib/page-key-map.js';

// …after stripCatalogSlugs / validateProductionBuild, before computeLocalHashes (~:973):
// #1659 — content pages ride the same delta pipeline as tutorials under the
// page- key namespace. Merge AFTER tutorial-only validation so page files are
// not subject to tutorial production checks, and BEFORE hashing so the whole
// begin/append/commit + carry-forward path handles them transparently.
// Skipped on single-tutorial hotfixes (opts.slug), like concepts.
if (!opts.slug) {
  const pages = discoverPageFiles(opts.hugoDir);
  for (const [key, absPath] of pages) tutorials.set(key, absPath);
  log(`[pages] merged ${pages.size} content page(s) into publish set`);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run --project hybrid test/hybrid/page-publish-serve.test.js`
Expected: PASS. Also run the publish-script unit tests: `npx vitest run scripts/__tests__` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/publish-content.ts test/hybrid/page-publish-serve.test.js
git commit -m "feat(pages): publish content pages via delta pipeline (#1659)"
```

---

## Task 7: Docs + full-suite gate

**Files:**
- Modify: `docs/developers/architecture/build.md` (or the tutorials-ims-gotchas reference) — document the `page-` namespace, `/content/pages/*` dark-launch, the baked fallback, and that Phase 2 flips routes.
- Modify: CLAUDE.md gotchas — add the `build-page-fallback` explicit-build-step note (mirrors the island-manifest gotcha).

- [ ] **Step 1: Update docs** (concrete prose describing the page store key convention, the dark-launch route, fail-open ladder, and the QA registration).
- [ ] **Step 2: Run the full unit suite**

Run: `npm test`
Expected: PASS (no regressions).

- [ ] **Step 3: Commit**

```bash
git add docs/ CLAUDE.md
git commit -m "docs(pages): document page store + dark-launch serving (#1659)"
```

---

## Self-Review (against the spec)

**Spec coverage (Phase 1 scope only):**
- Generic page store via `page-` key on existing tables → Tasks 1, 6. ✅
- Host/channel-aware serving (QA via separate `srv-qa` app) → Task 5 (both apps). ✅
- Fail-open serve path → Tasks 3, 4. ✅
- Sitemaps served from HANA with correct mime → Tasks 1, 3, 6. ✅
- Caching posture (LRU + generation + Edge-Cache-Tag) → Tasks 2, 3. ✅
- Publish via existing delta pipeline → Task 6. ✅
- Dark launch, no route flips → Task 5 (explicitly no approuter change). ✅
- **Deferred to Phase 2 plan:** approuter route flips (homepage last), `/…-qa/` page routes, per-route smoke/e2e.
- **Deferred to Phase 3 plan:** retire `/admin/rebuild` + `deploy-self-heal`; `rebuild-content.yml` tarball/asset-build removal; deployed-`island_manifest`-from-HANA; purge-by-tag on publish (may pull earlier if Akamai creds arrive — see spec Prerequisites).

**Placeholder scan:** No TBD/TODO in steps. The one implementer note (Task 3 Step 3a "factor verbatim from the real branch") is a correctness instruction, not a placeholder — the sketch code is complete and the real-branch reconciliation is explicit.

**Type consistency:** `pageServeHandler(req,res)`, `serveStoredSlug(req,res,{slug,tagSlug,mimeType})`, `pageKeyForPath`, `mimeTypeForPageKey`, `discoverPageFiles`, `loadPageFallback`, `servePageFallback(res,key)` — names/signatures consistent across Tasks 1–6.

**Phase 2/3 note:** These get their own plans, authored after Phase 1 ships and is verified on DEV/PROD (route flips gate on proven caching + fail-open; retirements gate on all flips proven; purge-by-tag gates on infra creds).
