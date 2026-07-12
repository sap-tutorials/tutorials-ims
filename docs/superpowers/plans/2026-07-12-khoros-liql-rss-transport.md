# Khoros LiQL RSS Transport Implementation Plan (#1144)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Cloudflare-403'd community RSS fetch with the unauthenticated SAP Community Khoros LiQL JSON API, adapted into RSS-compatible XML so the existing parser chain is untouched.

**Architecture:** A new `fetch`-shaped transport (`srv/lib/khoros-transport.js`) calls the Khoros `/api/2.0/search` JSON API and synthesizes RSS XML from `data.items`. It is injected into the existing `safeFetch(url, {fetchImpl})` seam exactly like `curlFetch`, preserving all SSRF guards. `RSS_TRANSPORT` becomes tri-state (`khoros` default / `curl` rollback / `fetch`). Sources carry their LiQL predicate in a new nullable `apiQuery` column.

**Tech Stack:** Node.js (native `fetch`), SAP CAP (CDS + `@sap/cds`), Vitest, SAP HANA (prod) / SQLite (unit tests).

## Global Constraints

- **Only unauthenticated Khoros access** — never add credentials to the API call.
- **SSRF guards preserved** — the transport does NO validation of its own; it runs inside `safeFetch` with `allowedHosts: new Set(['community.sap.com'])`.
- **`RSS_TRANSPORT` kill switch retained** — `curl` reverts to #1145 behavior instantly via `cf set-env`.
- **Any new `srv/lib/*.js` file must be added to the `srv-qa` `cp` list in `.deploy/mta.yaml`** — else QA boot crashes at MTA deploy.
- **Schema change to `db/community-blogs.cds` requires `cds build --production`** (not `cds compile`) to regenerate `db/last-dev/csn.json`.
- **Run `npx cds deploy --to sqlite::memory:` before committing any `db/**/*.cds` change** — catches runtime-only `@assert.unique` violations.
- **`CommunityBlogSources` is admin-editable** — do NOT add `apiQuery` to the seed CSV (`.hdbtabledata` re-import wipes editable columns). Seed via runtime backfill only.
- **Khoros mode uses native `fetch`** — unlike curl mode, khoros-mode tests CAN `vi.stubGlobal('fetch', ...)`. Document this inversion (contrast memory `curl-transport-bypasses-fetch-stub`).
- **Windows line endings** — write files LF; JS regex `$` excludes CR.

---

## File Structure

- **Create** `srv/lib/khoros-transport.js` — JSON→XML transport + URL builder + LiQL validation. One responsibility: adapt the Khoros API into the `fetch`/RSS contract.
- **Create** `test/unit/khoros-transport.test.js` — unit tests for the transport.
- **Modify** `srv/lib/community-blogs-fetcher.js` — tri-state transport resolver; build Khoros URL from `apiQuery`; per-source curl fallback when `apiQuery` missing.
- **Modify** `srv/lib/homepage-rss-fetcher.js` — tri-state resolver; community lane uses a fixed `apiQuery`.
- **Modify** `db/community-blogs.cds` — add `apiQuery : String(500);`.
- **Modify** `srv/admin-service.js` — seed `apiQuery` in auto-init defaults; targeted backfill for managed rows with null `apiQuery`; write-time `apiQuery` validation.
- **Modify** `.deploy/mta.yaml` — add `khoros-transport.js` to `srv-qa` cp list.
- **Regenerate** `db/last-dev/csn.json` — via `cds build --production`.

---

### Task 1: Khoros transport — URL builder + LiQL validation

**Files:**
- Create: `srv/lib/khoros-transport.js`
- Test: `test/unit/khoros-transport.test.js`

**Interfaces:**
- Produces: `buildKhorosUrl(apiQuery: string): string` — returns full `https://community.sap.com/api/2.0/search?q=<encoded LiQL>`.
- Produces: `validateApiQuery(apiQuery: string): boolean` — true if the predicate is allowlist-clean.
- Consumes: nothing (leaf module).

- [ ] **Step 1: Write the failing test**

```js
// test/unit/khoros-transport.test.js
import { describe, it, expect } from 'vitest';
import { buildKhorosUrl, validateApiQuery } from '../../srv/lib/khoros-transport.js';

describe('buildKhorosUrl', () => {
  it('wraps the predicate in parens and appends fixed clauses, URL-encoded', () => {
    const url = buildKhorosUrl("board.id='technology-blog-sap'");
    expect(url.startsWith('https://community.sap.com/api/2.0/search?q=')).toBe(true);
    const q = decodeURIComponent(new URL(url).searchParams.get('q'));
    expect(q).toBe(
      "SELECT subject,post_time,view_href,teaser,author.login FROM messages " +
      "WHERE (board.id='technology-blog-sap') AND depth=0 ORDER BY post_time DESC LIMIT 20"
    );
  });
});

describe('validateApiQuery', () => {
  it('accepts clean board/category predicates', () => {
    expect(validateApiQuery("board.id='technology-blog-sap'")).toBe(true);
    expect(validateApiQuery("category.id='technology' AND conversation.style='blog'")).toBe(true);
  });
  it('rejects injection attempts', () => {
    expect(validateApiQuery("x=1; DROP")).toBe(false);        // semicolon
    expect(validateApiQuery("x=1 LIMIT 999")).toBe(false);    // LIMIT
    expect(validateApiQuery("x=1) SELECT")).toBe(false);      // paren + SELECT
    expect(validateApiQuery("x=1 ORDER BY y")).toBe(false);   // ORDER
    expect(validateApiQuery('x=1\\')).toBe(false);            // backslash
    expect(validateApiQuery('')).toBe(false);                 // empty
    expect(validateApiQuery(null)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/khoros-transport.test.js`
Expected: FAIL — `buildKhorosUrl is not a function` (module doesn't exist yet).

- [ ] **Step 3: Write minimal implementation**

```js
// srv/lib/khoros-transport.js
//
// (#1144) Khoros LiQL JSON transport for community blog fetches — the durable
// successor to the curl transport (#1145). community.sap.com runs on Khoros
// (Lithium) and exposes an UNAUTHENTICATED LiQL JSON API at
// /api/2.0/search?q=<LiQL>. We hit that instead of the Cloudflare-403'd RSS
// feeds, then synthesize RSS-compatible XML from the JSON so the existing
// parseRss() chain is untouched.
//
// SECURITY: like curl-transport.js, this is a `fetch`-shaped TRANSPORT only —
// it performs NO SSRF validation of its own. It is injected into safeFetch()
// (srv/lib/safe-fetch.js) as `fetchImpl`, with allowedHosts pinned to
// community.sap.com, so the host allowlist + private-IP rejection + per-hop
// redirect re-validation all still run in safeFetch.
//
// TEST NOTE: unlike curl-transport.js (which shells out and bypasses
// vi.stubGlobal('fetch')), THIS transport uses native fetch — so khoros-mode
// tests CAN stub global.fetch. Contrast memory curl-transport-bypasses-fetch-stub.

const KHOROS_API_BASE = 'https://community.sap.com/api/2.0/search';
const SELECT_CLAUSE = 'SELECT subject,post_time,view_href,teaser,author.login FROM messages';
const FIXED_TAIL = 'AND depth=0 ORDER BY post_time DESC LIMIT 20';

// Allowlist: a LiQL WHERE predicate is field comparisons joined by AND/OR.
// Permit letters, digits, underscore, dot, single-quote, equals, spaces only.
// Reject anything that could break out of the WHERE clause we build: we add
// our own SELECT/ORDER/LIMIT and parens, so those keywords in admin input are
// rejected outright.
const ALLOWED_CHARS = /^[A-Za-z0-9_.'= ]+$/;
const FORBIDDEN_WORDS = /\b(SELECT|LIMIT|ORDER|FROM|DELETE|INSERT|UPDATE)\b/i;

export function validateApiQuery(apiQuery) {
  if (!apiQuery || typeof apiQuery !== 'string') return false;
  if (!ALLOWED_CHARS.test(apiQuery)) return false;
  if (FORBIDDEN_WORDS.test(apiQuery)) return false;
  return true;
}

export function buildKhorosUrl(apiQuery) {
  const liql = `${SELECT_CLAUSE} WHERE (${apiQuery}) ${FIXED_TAIL}`;
  return `${KHOROS_API_BASE}?q=${encodeURIComponent(liql)}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/khoros-transport.test.js`
Expected: PASS (both describe blocks).

- [ ] **Step 5: Commit**

```bash
git add srv/lib/khoros-transport.js test/unit/khoros-transport.test.js
git commit -m "feat(#1144): Khoros LiQL URL builder + query validation"
```

---

### Task 2: Khoros transport — JSON→RSS-XML adapter + fetch shape

**Files:**
- Modify: `srv/lib/khoros-transport.js`
- Test: `test/unit/khoros-transport.test.js`

**Interfaces:**
- Produces: `itemsToRssXml(items: object[]): string` — RSS 2.0 XML string.
- Produces: `khorosFetch(url: string, init?: object): Promise<{ok:boolean, status:number, headers:{get(n:string):string|null}, text():Promise<string>}>` — the injectable transport.
- Consumes: `buildKhorosUrl` (Task 1) is used by callers, not here.

- [ ] **Step 1: Write the failing test** (append to `test/unit/khoros-transport.test.js`)

```js
import { itemsToRssXml, khorosFetch } from '../../srv/lib/khoros-transport.js';
import { parseRss } from '../../srv/lib/rss-parse.js';
import { vi, afterEach } from 'vitest';

// Real Khoros payload captured 2026-07-12 from
// /api/2.0/search?q=...board.id='technology-blog-sap'...LIMIT 2
const KHOROS_FIXTURE = {
  status: 'success', message: '', http_code: 200,
  data: {
    type: 'messages', list_item_type: 'message', size: 2,
    items: [
      {
        type: 'message',
        view_href: 'https://community.sap.com/t5/technology-blog-posts-by-sap/api-centric-integration-on-sap-integration-suite-part-2-api-governance-with/ba-p/14438473',
        author: { type: 'user', login: 'Ashutosh_KSingh' },
        subject: 'API-Centric Integration on SAP Integration Suite – Part 2: API Governance with Developer Hub',
        teaser: "<P>In this artcile, you'll learn how to govern and publish deployed APIs using <STRONG>Developer Hub</STRONG>.</P>",
        post_time: '2026-07-12T13:10:31.131+02:00',
        message_type: 'blog_topic_message',
      },
      {
        type: 'message',
        view_href: 'https://community.sap.com/t5/technology-blog-posts-by-sap/api-centric-integration-on-sap-integration-suite-part-1-build-and-deploy/ba-p/14438357',
        author: { type: 'user', login: 'Ashutosh_KSingh' },
        subject: 'API-Centric Integration on SAP Integration Suite – Part 1: Build and Deploy Your API',
        teaser: '<P class="">Looking to get started with API-centric integration?</P>',
        post_time: '2026-07-12T05:04:44.084+02:00',
        message_type: 'blog_topic_message',
      },
    ],
    next_cursor: 'abc',
  },
  metadata: {},
};

describe('itemsToRssXml → parseRss round-trip', () => {
  it('produces XML that parseRss reads into the expected item shape', () => {
    const xml = itemsToRssXml(KHOROS_FIXTURE.data.items);
    const items = parseRss(xml);
    expect(items).toHaveLength(2);
    expect(items[0].title).toContain('API Governance with Developer Hub');
    expect(items[0].link).toBe(KHOROS_FIXTURE.data.items[0].view_href);
    expect(items[0].author).toBe('Ashutosh_KSingh');
    expect(items[0].publishedAt).toBe(new Date('2026-07-12T13:10:31.131+02:00').toISOString());
    expect(items[0].language).toBe('en');           // channel <language>en so isEnglish accepts
    expect(items[0].description).toContain('Developer Hub');
  });

  it('escapes XML metacharacters in subject/teaser', () => {
    const xml = itemsToRssXml([{
      view_href: 'https://community.sap.com/x/ba-p/1',
      subject: 'A & B <tag> "q"', teaser: 'x & y', post_time: '2026-01-01T00:00:00.000+00:00',
      author: { login: 'u' },
    }]);
    expect(xml).not.toMatch(/<title>A & B <tag>/);   // raw & / < must be escaped
    const items = parseRss(xml);
    expect(items[0].title).toBe('A & B <tag> "q"');   // round-trips back to literal
  });
});

describe('khorosFetch', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('fetches JSON and returns a Response-shaped object whose text() is RSS XML', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => KHOROS_FIXTURE,
      text: async () => JSON.stringify(KHOROS_FIXTURE),
    })));
    const res = await khorosFetch('https://community.sap.com/api/2.0/search?q=x');
    expect(res.status).toBe(200);
    expect(res.ok).toBe(true);
    const items = parseRss(await res.text());
    expect(items).toHaveLength(2);
  });

  it('propagates a non-2xx status (CF egress 403 signal)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 403, json: async () => ({}), text: async () => 'blocked',
    })));
    const res = await khorosFetch('https://community.sap.com/api/2.0/search?q=x');
    expect(res.status).toBe(403);
    expect(res.ok).toBe(false);
  });

  it('fails open on malformed JSON → empty item list', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => { throw new Error('bad json'); },
      text: async () => 'not json',
    })));
    const res = await khorosFetch('https://community.sap.com/api/2.0/search?q=x');
    expect(res.status).toBe(200);
    expect(parseRss(await res.text())).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/khoros-transport.test.js`
Expected: FAIL — `itemsToRssXml is not a function` / `khorosFetch is not a function`.

- [ ] **Step 3: Write minimal implementation** (append to `srv/lib/khoros-transport.js`)

```js
const MAX_BODY_BYTES = 1 << 20; // 1 MiB cap on the JSON response

function xmlEscape(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Adapt Khoros JSON `data.items` into RSS 2.0 XML that parseRss() consumes.
 * We emit channel-level <language>en so isEnglish() short-circuits to accept
 * (the Khoros query is already board/category-scoped to English content).
 * subject/teaser/author are wrapped in CDATA-free escaped text; view_href is
 * the permalink used as both <link> and (downstream) sourceUrl.
 */
export function itemsToRssXml(items) {
  const list = Array.isArray(items) ? items : [];
  const body = list.map((it) => {
    const title = xmlEscape(it.subject);
    const link = xmlEscape(it.view_href);
    const pubDate = it.post_time ? new Date(it.post_time).toUTCString() : '';
    const desc = xmlEscape(it.teaser);
    const author = xmlEscape(it.author?.login || '');
    return (
      `<item>` +
      `<title>${title}</title>` +
      `<link>${link}</link>` +
      (pubDate ? `<pubDate>${pubDate}</pubDate>` : '') +
      `<description>${desc}</description>` +
      (author ? `<dc:creator>${author}</dc:creator>` : '') +
      `</item>`
    );
  }).join('');
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">` +
    `<channel><language>en</language>${body}</channel></rss>`
  );
}

/**
 * fetch-shaped transport backed by the Khoros JSON API. `url` is the fully
 * built /api/2.0/search URL (see buildKhorosUrl). Returns a Response-shaped
 * object whose text() yields synthesized RSS XML.
 */
export function khorosFetch(url, init = {}) {
  return (async () => {
    const res = await fetch(url, {
      ...init,
      redirect: 'manual', // safeFetch re-validates each hop
    });
    if (res.status < 200 || res.status >= 300) {
      // Non-2xx (e.g. CF egress 403) — surface status; body irrelevant.
      return {
        ok: false, status: res.status,
        headers: { get: (n) => res.headers?.get?.(n) ?? null },
        async text() { return ''; },
      };
    }
    let xml = '';
    try {
      const raw = await res.text();
      if (raw.length > MAX_BODY_BYTES) throw new Error('khoros body too large');
      const json = JSON.parse(raw);
      xml = itemsToRssXml(json?.data?.items);
    } catch {
      xml = itemsToRssXml([]); // fail-open → empty <rss>
    }
    return {
      ok: true, status: 200,
      headers: { get: (n) => res.headers?.get?.(n) ?? null },
      async text() { return xml; },
    };
  })();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/khoros-transport.test.js`
Expected: PASS (all describe blocks).

- [ ] **Step 5: Commit**

```bash
git add srv/lib/khoros-transport.js test/unit/khoros-transport.test.js
git commit -m "feat(#1144): Khoros JSON→RSS-XML adapter + fetch-shaped transport"
```

---

### Task 3: Schema — add `apiQuery` column

**Files:**
- Modify: `db/community-blogs.cds:25-32`
- Regenerate: `db/last-dev/csn.json`

**Interfaces:**
- Produces: `CommunityBlogSources.apiQuery : String(500)` (nullable) available to services & fetchers.

- [ ] **Step 1: Add the column**

In `db/community-blogs.cds`, change the entity body:

```cds
entity CommunityBlogSources : cuid, managed {
  label       : String(120) not null;
  feedUrl     : String(500) not null;
  topicSlug   : String(60);
  isActive    : Boolean default true;
  sortOrder   : Integer default 100;
  managed     : Boolean default false;
  apiQuery    : String(500); // (#1144) LiQL WHERE predicate for the Khoros transport
}
```

- [ ] **Step 2: Verify runtime deploy (catches @assert.unique violations)**

Run: `npx cds deploy --to sqlite::memory:`
Expected: exits 0, no `UNIQUE constraint failed`. (Adding a nullable column is safe; this confirms.)

- [ ] **Step 3: Regenerate the CDS build staging model**

Run: `npx cds build --production`
Expected: exits 0; `db/last-dev/csn.json` updated to include `apiQuery`.

- [ ] **Step 4: Commit**

```bash
git add db/community-blogs.cds db/last-dev/csn.json
git commit -m "feat(#1144): add apiQuery column to CommunityBlogSources"
```

---

### Task 4: Admin service — seed defaults, backfill, write validation

**Files:**
- Modify: `srv/admin-service.js` (auto-init defaults ~line 656; add backfill + validation near the `before('READ','CommunityBlogSources')` block ~line 685)
- Test: `test/unit/community-blogs-apiquery.test.js` (create)

**Interfaces:**
- Consumes: `validateApiQuery` from `srv/lib/khoros-transport.js` (Task 1).
- Produces: managed rows carry `apiQuery`; invalid `apiQuery` on write is rejected 400.

The 3 managed sources map to these predicates (verified 2026-07-12):
- `...c81001` (all Technology blogs) → `category.id='technology' AND conversation.style='blog'`
- `...c81002` (Technology by SAP)    → `board.id='technology-blog-sap'`
- `...c81003` (Technology by Members)→ `board.id='technology-blog-members'`

- [ ] **Step 1: Write the failing test**

```js
// test/unit/community-blogs-apiquery.test.js
import { describe, it, expect } from 'vitest';
import cds from '@sap/cds';

describe('CommunityBlogSources apiQuery', () => {
  const { GET, POST, PATCH } = cds.test(process.cwd());

  it('managed rows are backfilled with a valid apiQuery after READ', async () => {
    const { data } = await GET(`/odata/v4/admin/CommunityBlogSources?$filter=managed eq true`);
    expect(data.value.length).toBeGreaterThanOrEqual(3);
    for (const row of data.value) {
      expect(row.apiQuery, `${row.label} apiQuery`).toBeTruthy();
    }
    const sap = data.value.find((r) => r.topicSlug === 'technology-sap');
    expect(sap.apiQuery).toBe("board.id='technology-blog-sap'");
  });

  it('rejects an apiQuery with injection on write', async () => {
    await expect(
      PATCH(`/odata/v4/admin/CommunityBlogSources(00000000-0000-0000-0000-000000c81002)`,
        { apiQuery: "x=1; DROP" })
    ).rejects.toMatchObject({ response: { status: 400 } });
  });
});
```

> Note: adjust the OData base path (`/odata/v4/admin/...`) to match this project's AdminService mount if different — check `srv/admin-service.cds` `@path`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/community-blogs-apiquery.test.js`
Expected: FAIL — `apiQuery` is null/undefined on managed rows (no backfill yet).

- [ ] **Step 3: Add apiQuery to auto-init defaults**

In `srv/admin-service.js`, add `apiQuery` to each `COMMUNITY_BLOG_SOURCE_DEFAULTS` entry:

```js
    const COMMUNITY_BLOG_SOURCE_DEFAULTS = [
      {
        ID:        '00000000-0000-0000-0000-000000c81001',
        label:     'Community — Technology (all blogs)',
        feedUrl:   'https://community.sap.com/khhcw49343/rss/Community?interaction.style=blog',
        topicSlug: 'community-technology',
        isActive:  true, sortOrder: 10, managed: true,
        apiQuery:  "category.id='technology' AND conversation.style='blog'",
      },
      {
        ID:        '00000000-0000-0000-0000-000000c81002',
        label:     'Technology Blogs by SAP',
        feedUrl:   'https://community.sap.com/khhcw49343/rss/board?board.id=technology-blog-sap',
        topicSlug: 'technology-sap',
        isActive:  true, sortOrder: 20, managed: true,
        apiQuery:  "board.id='technology-blog-sap'",
      },
      {
        ID:        '00000000-0000-0000-0000-000000c81003',
        label:     'Technology Blogs by Members',
        feedUrl:   'https://community.sap.com/khhcw49343/rss/board?board.id=technology-blog-members',
        topicSlug: 'technology-members',
        isActive:  true, sortOrder: 30, managed: true,
        apiQuery:  "board.id='technology-blog-members'",
      },
    ];
```

- [ ] **Step 4: Add targeted backfill for existing managed rows**

The auto-init only inserts when the table is EMPTY — existing DEV rows won't get `apiQuery`. Add a backfill inside the same `before('READ','CommunityBlogSources')` handler, replacing it with:

```js
    this.before('READ', 'CommunityBlogSources', async () => {
      const CBS = 'com.sap.developers.ims.CommunityBlogSources';
      const existing = await SELECT.from(CBS).columns('ID');
      if (existing.length === 0) {
        await INSERT.into(CBS).entries(COMMUNITY_BLOG_SOURCE_DEFAULTS);
        return;
      }
      // Backfill apiQuery on managed rows that predate the #1144 column.
      const byId = new Map(COMMUNITY_BLOG_SOURCE_DEFAULTS.map((d) => [d.ID, d.apiQuery]));
      const stale = await SELECT.from(CBS).columns('ID').where({ managed: true, apiQuery: null });
      for (const row of stale) {
        const q = byId.get(row.ID);
        if (q) await UPDATE(CBS).set({ apiQuery: q }).where({ ID: row.ID });
      }
    });
```

- [ ] **Step 5: Add write-time apiQuery validation**

Near the top of the AdminService `init()` (after the `require`/import area), import the validator and add a `before` handler. At the top of `srv/admin-service.js`, add the import (match the file's existing import style — if it uses dynamic import elsewhere, mirror that):

```js
import { validateApiQuery } from './lib/khoros-transport.js';
```

Then inside `init()`, alongside the other `CommunityBlogSources` handlers:

```js
    this.before(['CREATE', 'UPDATE'], 'CommunityBlogSources', (req) => {
      const q = req.data?.apiQuery;
      // Null/absent is allowed (source falls back to curl); only validate when set.
      if (q != null && q !== '' && !validateApiQuery(q)) {
        return req.reject(400, `Invalid apiQuery — allowed: field comparisons joined by AND/OR only`);
      }
    });
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run test/unit/community-blogs-apiquery.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add srv/admin-service.js test/unit/community-blogs-apiquery.test.js
git commit -m "feat(#1144): seed/backfill apiQuery + write validation on CommunityBlogSources"
```

---

### Task 5: Wire the tri-state transport into community-blogs-fetcher

**Files:**
- Modify: `srv/lib/community-blogs-fetcher.js:22-33` (imports + resolver), `:142-160` (fetch call)
- Test: `test/unit/community-blogs-fetcher-khoros.test.js` (create)

**Interfaces:**
- Consumes: `buildKhorosUrl`, `khorosFetch` (Tasks 1-2); `curlFetch` (existing).
- Produces: khoros-mode fetch of one source hits `community.sap.com/api/2.0/search` with `khorosFetch` injected into `safeFetch`.

- [ ] **Step 1: Write the failing test**

```js
// test/unit/community-blogs-fetcher-khoros.test.js
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchOneSource } from '../../srv/lib/community-blogs-fetcher.js';
import { _setLookupForTests } from '../../srv/lib/safe-fetch.js';

const KHOROS_FIXTURE = {
  status: 'success', http_code: 200,
  data: { items: [{
    view_href: 'https://community.sap.com/t5/x/ba-p/1',
    author: { login: 'u' }, subject: 'Hello World Blog Post',
    teaser: '<p>body text here</p>', post_time: '2026-07-12T13:10:31.131+02:00',
  }] },
};

describe('fetchOneSource — khoros mode', () => {
  beforeEach(() => {
    process.env.RSS_TRANSPORT = 'khoros';
    _setLookupForTests(async () => [{ address: '104.18.0.1', family: 4 }]); // public IP
  });
  afterEach(() => {
    delete process.env.RSS_TRANSPORT;
    _setLookupForTests(null);
    vi.unstubAllGlobals();
  });

  it('fetches via the Khoros API URL and upserts items', async () => {
    const fetchSpy = vi.fn(async (url) => {
      expect(url).toContain('community.sap.com/api/2.0/search');
      expect(decodeURIComponent(url)).toContain("board.id='technology-blog-sap'");
      return { ok: true, status: 200, headers: { get: () => null },
        text: async () => JSON.stringify(KHOROS_FIXTURE) };
    });
    vi.stubGlobal('fetch', fetchSpy);

    const db = { run: vi.fn(async () => undefined) }; // no existing row → INSERT path
    const source = { ID: 's1', label: 'SAP', topicSlug: 'technology-sap',
      feedUrl: 'https://community.sap.com/khhcw49343/rss/board?board.id=technology-blog-sap',
      apiQuery: "board.id='technology-blog-sap'" };

    const stats = await fetchOneSource(source, { db });
    expect(fetchSpy).toHaveBeenCalled();
    expect(stats.fetched).toBe(1);
    expect(stats.inserted).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/community-blogs-fetcher-khoros.test.js`
Expected: FAIL — fetch called with the raw `feedUrl` (RSS), not the Khoros API URL; assertion on `/api/2.0/search` fails.

- [ ] **Step 3: Update imports + resolver**

In `srv/lib/community-blogs-fetcher.js`, replace the import + resolver block (lines ~20-33):

```js
import { safeFetch } from './safe-fetch.js';
import { parseRss, RSS_FETCH_HEADERS } from './rss-parse.js';
import { curlFetch } from './curl-transport.js';
import { buildKhorosUrl, khorosFetch } from './khoros-transport.js';
import * as metrics from './metrics.js';

const log = cds.log('community-blogs-fetcher');

// (#1144) Tri-state transport. Default 'khoros' hits the unauthenticated
// Khoros LiQL JSON API (dodges the Cloudflare egress-IP 403 that curl also
// hit — see memory cloudflare-ja3-blocks-node-fetch-not-ua). 'curl' reverts
// to the #1145 curl transport (kill switch); 'fetch' uses native fetch on
// the raw RSS feed (local/tests). Toggle: cf set-env RSS_TRANSPORT curl.
function rssMode() {
  const m = process.env.RSS_TRANSPORT;
  return m === 'curl' || m === 'fetch' ? m : 'khoros';
}
```

- [ ] **Step 4: Update the fetch call in `fetchOneSource`**

Replace the `safeFetch(...)` call (lines ~148-154) with mode-aware target + transport selection:

```js
  let res;
  try {
    const mode = rssMode();
    let target = source.feedUrl;
    let fetchImpl;
    let allowedHosts;
    if (mode === 'khoros' && source.apiQuery) {
      target = buildKhorosUrl(source.apiQuery);
      fetchImpl = khorosFetch;
      allowedHosts = new Set(['community.sap.com']);
    } else if (mode === 'khoros' || mode === 'curl') {
      // khoros mode with no apiQuery → degrade to curl on the raw RSS feed.
      fetchImpl = curlFetch;
    } // mode === 'fetch' → fetchImpl stays undefined (native fetch on RSS)

    res = await safeFetch(target, {
      allowedProtocols: ['https:'],
      allowedHosts,
      timeoutMs: TIMEOUT_MS,
      maxRedirects: MAX_REDIRECTS,
      fetchInit: { headers: RSS_FETCH_HEADERS },
      fetchImpl,
    });
  } catch (err) {
    log.warn(`fetchOneSource: ${source.label}: fetch failed:`, err.code || '', err.message);
    metrics.counter(`homepage.community_blogs.fetch[source=${source.topicSlug || source.ID},result=fetch_error]`);
    stats.errored = 1;
    return stats;
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/unit/community-blogs-fetcher-khoros.test.js`
Expected: PASS.

- [ ] **Step 6: Run the existing fetcher tests for regressions**

Run: `npx vitest run test/unit/community-blogs-fetcher.test.js test/unit/srv-fetchers-ssrf-guard.test.js`
Expected: PASS. If any test drove the RSS path expecting native fetch, set `process.env.RSS_TRANSPORT='fetch'` in its `beforeEach` (see memory `curl-transport-bypasses-fetch-stub`).

- [ ] **Step 7: Commit**

```bash
git add srv/lib/community-blogs-fetcher.js test/unit/community-blogs-fetcher-khoros.test.js
git commit -m "feat(#1144): route community-blogs-fetcher through Khoros transport (default)"
```

---

### Task 6: Wire the tri-state transport into homepage-rss-fetcher

**Files:**
- Modify: `srv/lib/homepage-rss-fetcher.js:14-24` (imports + resolver), `:73-79` (fetch call)
- Test: `test/unit/homepage-rss-fetcher.test.js` (extend)

**Interfaces:**
- Consumes: `buildKhorosUrl`, `khorosFetch`, `curlFetch`.
- Note: `fetchRssItems(url)` is called with a raw RSS URL by the homepage lane. In khoros mode we derive `apiQuery` from the URL's `board.id` param; if none, fall back to curl.

- [ ] **Step 1: Write the failing test** (append to `test/unit/homepage-rss-fetcher.test.js`)

```js
describe('fetchRssItems — khoros mode', () => {
  beforeEach(() => { process.env.RSS_TRANSPORT = 'khoros'; _resetForTests(); });
  afterEach(() => { delete process.env.RSS_TRANSPORT; vi.unstubAllGlobals(); });

  it('derives board.id from the feed URL and hits the Khoros API', async () => {
    const fetchSpy = vi.fn(async (u) => {
      expect(u).toContain('community.sap.com/api/2.0/search');
      expect(decodeURIComponent(u)).toContain("board.id='technology-blog-sap'");
      return { ok: true, status: 200, headers: { get: () => null }, text: async () =>
        JSON.stringify({ data: { items: [{ view_href: 'https://community.sap.com/x/ba-p/1',
          subject: 'T', teaser: 'x', post_time: '2026-07-12T00:00:00.000+00:00', author: { login: 'u' } }] } }) };
    });
    vi.stubGlobal('fetch', fetchSpy);
    const items = await fetchRssItems(
      'https://community.sap.com/khhcw49343/rss/board?board.id=technology-blog-sap', { limit: 5 });
    expect(items).toHaveLength(1);
    expect(items[0].link).toBe('https://community.sap.com/x/ba-p/1');
  });
});
```

Make sure `_resetForTests`, `vi`, `beforeEach`, `afterEach` are imported at the top of the file.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/homepage-rss-fetcher.test.js`
Expected: FAIL — hits raw RSS URL, assertion on `/api/2.0/search` fails.

- [ ] **Step 3: Update imports + resolver + URL derivation**

In `srv/lib/homepage-rss-fetcher.js`, replace the import + resolver block (lines ~13-24):

```js
import cds from '@sap/cds';
import { safeFetch } from './safe-fetch.js';
import { parseRss, RSS_FETCH_HEADERS } from './rss-parse.js';
import { curlFetch } from './curl-transport.js';
import { buildKhorosUrl, khorosFetch } from './khoros-transport.js';

const log = cds.log('homepage-rss-fetcher');

// (#1144) Tri-state transport — see community-blogs-fetcher.js. Default khoros.
function rssMode() {
  const m = process.env.RSS_TRANSPORT;
  return m === 'curl' || m === 'fetch' ? m : 'khoros';
}

// Derive a Khoros LiQL predicate from a community.sap.com RSS feed URL.
// board feeds carry ?board.id=<id>; returns null if not derivable.
function apiQueryFromFeedUrl(url) {
  try {
    const boardId = new URL(url).searchParams.get('board.id');
    if (boardId && /^[A-Za-z0-9_-]+$/.test(boardId)) return `board.id='${boardId}'`;
  } catch { /* fall through */ }
  return null;
}
```

- [ ] **Step 4: Update the fetch call in `fetchRssItems`**

Replace the `safeFetch(...)` call (lines ~73-79):

```js
    const mode = rssMode();
    let target = url;
    let fetchImpl;
    let allowedHosts;
    const apiQuery = mode === 'khoros' ? apiQueryFromFeedUrl(url) : null;
    if (mode === 'khoros' && apiQuery) {
      target = buildKhorosUrl(apiQuery);
      fetchImpl = khorosFetch;
      allowedHosts = new Set(['community.sap.com']);
    } else if (mode === 'khoros' || mode === 'curl') {
      fetchImpl = curlFetch;
    }
    res = await safeFetch(target, {
      allowedProtocols: ['https:'],
      allowedHosts,
      timeoutMs: TIMEOUT_MS,
      maxRedirects: 3,
      fetchInit: { headers: RSS_FETCH_HEADERS },
      fetchImpl,
    });
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/unit/homepage-rss-fetcher.test.js`
Expected: PASS.

- [ ] **Step 6: Regression — homepage news filter test**

Run: `npx vitest run test/unit/homepage-news-filter.test.js`
Expected: PASS. This test stubs fetch on the RSS path; if it now hits khoros logic unexpectedly, set `process.env.RSS_TRANSPORT='fetch'` in its `beforeEach` (memory `curl-transport-bypasses-fetch-stub`).

- [ ] **Step 7: Commit**

```bash
git add srv/lib/homepage-rss-fetcher.js test/unit/homepage-rss-fetcher.test.js
git commit -m "feat(#1144): route homepage-rss-fetcher through Khoros transport (default)"
```

---

### Task 7: Add khoros-transport.js to the srv-qa cp list

**Files:**
- Modify: `.deploy/mta.yaml` (the `srv-qa` build `cp` bash line ~122)

**Interfaces:** none — deploy-time file placement only.

- [ ] **Step 1: Add the file to the cp list**

In `.deploy/mta.yaml`, find the long `cp ../../srv/lib/... srv/lib/` segment that already lists `curl-transport.js` and `rss-parse.js`. Add `../../srv/lib/khoros-transport.js` adjacent to `../../srv/lib/curl-transport.js` in that same `cp` invocation:

```
... ../../srv/lib/community-blogs-fetcher.js ../../srv/lib/community-blogs-classifier.js ../../srv/lib/safe-fetch.js ../../srv/lib/curl-transport.js ../../srv/lib/khoros-transport.js ../../srv/lib/explainer-generator.js ...
```

- [ ] **Step 2: Verify the YAML still parses**

Run: `npx js-yaml .deploy/mta.yaml > /dev/null && echo OK` (or `yq '.' .deploy/mta.yaml > /dev/null && echo OK`)
Expected: `OK`.

- [ ] **Step 3: Re-walk transitive deps (per CLAUDE.md srv-qa audit rule)**

Confirm `khoros-transport.js` imports nothing outside what's already in the cp list. It imports only Node built-ins + is imported BY `community-blogs-fetcher.js`/`homepage-rss-fetcher.js` (both already listed). No new transitive dep.

Run: `grep -E "^import|require\(" srv/lib/khoros-transport.js`
Expected: only relative/built-in imports already covered.

- [ ] **Step 4: Commit**

```bash
git add .deploy/mta.yaml
git commit -m "build(#1144): add khoros-transport.js to srv-qa cp list"
```

---

### Task 8: Full unit suite + docs + PR

**Files:**
- Modify: `docs/developers/reference/tutorials-ims-gotchas.md` (or the RSS section) — document the tri-state transport + deploy-observe verification.

- [ ] **Step 1: Run the full unit suite**

Run: `npm test`
Expected: PASS (green). Investigate any RSS-path failures for the `RSS_TRANSPORT` stub inversion.

- [ ] **Step 2: Document the transport**

Add a short entry to `docs/developers/reference/tutorials-ims-gotchas.md` (RSS section) covering: tri-state `RSS_TRANSPORT` (`khoros` default / `curl` rollback / `fetch`), the Khoros LiQL API + field map, the `apiQuery` column, and the **deploy-observe verification** (the API sits behind the same Cloudflare edge; the only real proof it works from CF egress is `fetched>0` on the cron). Link the memory note.

- [ ] **Step 3: Commit docs**

```bash
git add docs/developers/reference/tutorials-ims-gotchas.md
git commit -m "docs(#1144): document Khoros tri-state RSS transport + deploy-observe verify"
```

- [ ] **Step 4: Push and open a draft PR**

```bash
git push -u origin worktree-khoros-rss-transport-1144
gh pr create --draft --title "feat(#1144): Khoros LiQL transport as durable RSS successor" \
  --body "Closes #1144. Routes community blog fetch through the unauthenticated SAP Community Khoros LiQL JSON API, adapted to RSS XML so the parser chain is untouched. RSS_TRANSPORT tri-state (khoros default / curl rollback / fetch). SSRF guards preserved (host-pinned community.sap.com). See docs/superpowers/specs/2026-07-12-khoros-liql-rss-transport-design.md.

⚠️ Verification is deploy-observe: the API is behind the same Cloudflare edge as the RSS feeds; whether it 200s from the CF eu10-005 egress is unverifiable locally. After merge+deploy, trigger the community-blogs-fetch cron and confirm fetched>0. If it 403s, cf set-env RSS_TRANSPORT curl to roll back and escalate to a proxy egress (Option 2)."
```

- [ ] **Step 5: Post-deploy verification (manual, after merge + MTA deploy — NOT part of the branch)**

Trigger the cron via the admin board force-trigger, then:
Run: `cf logs tutorials-srv --recent | grep community-blogs-fetcher`
Expected: `fetched=<N>` with N>0 and `errored=0`. If `errored>=sources` with HTTP 403 → the API path is IP-blocked from CF egress; roll back with `cf set-env tutorials-srv RSS_TRANSPORT curl && cf restart tutorials-srv` and open the Option-2 proxy follow-up.

---

## Self-Review

**Spec coverage:**
- Transport seam / synthesize RSS XML → Tasks 1-2. ✔
- `RSS_TRANSPORT` tri-state → Tasks 5-6. ✔
- `apiQuery` column + seed-via-auto-init (not CSV) + injection allowlist → Tasks 3-4. ✔
- SSRF guard preserved / host-pin → Tasks 5-6 (`allowedHosts`). ✔
- srv-qa cp list → Task 7. ✔
- `db/last-dev/csn.json` via `cds build --production` → Task 3. ✔
- Test-stub inversion documented → Task 2 file header + Tasks 5-6 regression steps. ✔
- Deploy-observe verification + kill-switch rollback → Task 8. ✔
- Out-of-scope (proxy, events fetcher) → not built. ✔

**Placeholder scan:** No TBD/TODO; all code steps contain full code. Task 4 notes an OData-path adjustment (`@path` check) — this is a verify-against-codebase instruction, not a placeholder.

**Type consistency:** `buildKhorosUrl`, `khorosFetch`, `itemsToRssXml`, `validateApiQuery`, `rssMode`, `apiQueryFromFeedUrl` used consistently across tasks. `apiQuery` column name consistent. Fixture shape consistent between Tasks 2/5/6.
