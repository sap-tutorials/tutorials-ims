# Devtoberfest Gameboard — Plan D: Community-Data Facade & Khoros Utilities

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Every code step ships REAL, runnable code — no placeholders, no TODOs.

**Goal:** Port the SAP Community Activity Badges Khoros utilities into the new `sap-community-gameboard` CAP app as a **second `@path` surface `/community`**, implemented as an Express router mounted on the bootstrapped CAP `app`. All Khoros LiQL/search access is consolidated behind ONE facade module (`srv/lib/community/khoros.js`); nothing else calls Khoros directly. The SVG/PNG badge & activity cards, the `/community/user/:scnId` JSON (consumed by Plan E's signature builder), the `/community/khoros/*` proxy, `/community/tags`, and `POST /community/upload_selfie` all consume the facade. Reads fail soft (never 500 on a Khoros hiccup). Tests run against recorded fixtures — no live Khoros calls in CI.

**Architecture:** The gameboard CAP app (Plan A) already owns `srv/gameboard-service.js` (OData at `/gameboard`) and `srv/server.js` is its custom bootstrap. Plan D adds `srv/routes/community.js` exporting `register(app)`, wired from `cds.on('bootstrap', app => community.register(app))` — the **exact pattern** the tutorial repo uses for `srv/routes/devtoberfest-public.js` (`register(app)`) called from `srv/server.js` (`devtoberfestPublic.register(app)`, server.js:372). The facade (`srv/lib/community/khoros.js`) is a straight port of the source `srv/util/khoros.js`, refactored from `then-request`/`got` to **Node native `fetch`** (Node 20+ baseline, per global rules), preserving the `callUserAPI(scnId) → { data: <author> }` envelope, both API hosts (`community.sap.com/khhcw49343` LiQL search + `groups.community.sap.com` search), and the TTL file-cache pattern. `srv/lib/community/svg-render.js` is a verbatim port of the pure string builders in the source `srv/util/svgRender.js` plus one new native raster helper.

**Tech Stack:** SAP CAP (Node.js, `@sap/cds` v8 / CAP 10 baseline), Express (mounted via CAP bootstrap), `sharp` (SVG→PNG/GIF raster), `multer` (selfie upload), `text-wrapper` (badge title wrap). Node native `fetch` (no `got`/`then-request`). Vitest + chai for tests. Consumer-side changes land in the new `sap-community-gameboard` repo; the approuter route additions land in the `tutorials-ims` repo.

## Design Decision: Express router vs CAP custom handlers

**Recommendation: Express router mounted via `cds.on('bootstrap')`.** Justification: these endpoints emit raw `image/svg+xml`, `image/png`, `image/gif`, `text/html`, `application/json` (a hand-shaped Khoros envelope, not an OData entity), and consume `multipart/form-data` (multer). None of that is an OData entity/action shape, so modeling them as CAP service functions would force OData response serialization and fight the framework for byte-exact SVG/binary output. The tutorial repo already established this exact seam — `devtoberfest-public.js`/`devtoberfest-auth.js` export `register(app)` and are called from `server.js`'s `cds.on('bootstrap')` — so mirroring it keeps one convention across both apps and gives direct control over `res.type(...).send(buffer)`.

## Global Constraints

- **Node native `fetch` only** — the source uses `then-request` (`request('GET', url).getBody()`) and `got`; the port replaces both with `fetch`. No new HTTP-client dependency. Every outbound Khoros call wraps an `AbortController` timeout (default 8000 ms) so a hung upstream degrades to fail-soft, not a hung request.
- **ONE Khoros seam** — `srv/lib/community/khoros.js` is the *only* module that constructs a Khoros URL or parses a Khoros body. Routes import the facade; they never `fetch` Khoros themselves. A grep for `community.sap.com` / `groups.community.sap.com` outside the facade must return zero hits in `srv/routes/`.
- **Two hosts preserved** — user/badge/rank/signature data via `messages.author.*` expansion at `community.sap.com/khhcw49343/api/2.0/search`; boards/topics/threads/events/RSVPs/products at `groups.community.sap.com/api/2.0/search`. The mid-2026 anonymous-read revocation on the first host is the reason `callUserAPI` goes through `messages.author.*` and NOT the deprecated `/users/:id` endpoint — preserve that.
- **`callUserAPI` envelope is frozen** — returns `{ data: <author> }` where `<author>` carries `id, login, first_name, last_name, rank.name, metrics.posts, avatar.profile, signature, view_href, user_badges.items[].badge.{id,title,icon_url,description} + earned_date`. `showcaseBadges`, `activity`, and `user/:scnId` (Plan E) all depend on this shape unchanged.
- **Fail-soft reads** — a Khoros timeout/error on a *proxy* route (`/khoros/*`, `/tags`) returns an empty-but-valid payload (`[]` / `{}`) or last-known cached value, never a 500. The per-user card routes are the one exception: an *unknown user* is a 404-equivalent rendered error card (preserving the source's "user not found" image behavior), but an upstream *outage* still degrades to a rendered error card, not a 500.
- **TTL file cache preserved** — `checkFileAge(filePath)` (1-day) gates `tags.json`. The cache file lives under `srv/lib/community/cache/` (gitignored) — NOT under a path that ships read-only in the CF droplet. Writes are best-effort (wrapped in try/catch); a read-only FS degrades to live-fetch-every-time, never a crash.
- **Public reads anonymous; RSVP admin/export gated** — `/community/showcaseBadges/*`, `/activity/*`, `/user/*`, `/tags`, and the read-only `/khoros/{boards,board,topics,thread,events,event,eventRegsRaw,messagePosters,members}` proxy routes are anonymous. The `/community/khoros/eventRegs/:boardId` HTML admin page (carries the RSVP email/CSV/Excel export tooling with attendee PII) is gated on XSUAA scope **`$XSAPPNAME.Tutorial.Author`** (a shared scope on the shared `tutorials-xsuaa` xsappname — see Plan A §4.2; reused because event RSVP management is an author/organizer task and the tutorial approuter already declares this scope). Enforced at the approuter (route-level `authenticationType: 'xsuaa'` + `scope`) AND defensively in the handler (`req.user.is('Tutorial.Author')`).
- **`sharp` raster is animated-aware** — the `showcaseBadges/:scnId` PNG/GIF path uses `{ animated: true, pages: -1 }` exactly as the source (staggered-fade animation baked into the SVG). The other cards use plain `.png()`/`.gif()`.
- **No HANA for community data** — badge/tag/event data is Khoros-sourced by nature; the facade is the seam. Do NOT add a HANA table for it.
- **Static assets carry over** — the SVG builders reference `../images/sap_18.png`, `../images/blog.png`, `../images/comment.png`, `../images/error.png`, `../images/devtoberfest/selfie/*.png`, and the Joystix font. These are copied from the source repo's `srv/images/` into the new repo's `srv/lib/community/images/` and referenced relative to `svg-render.js`'s `__dirname`.

## Interface Contracts (locked — Plan E consumes `/community/user/:scnId`)

`GET /community/user/:scnId` returns HTTP 200 with `Content-Type: application/json` and this body (the `callUserAPI` envelope verbatim; unknown user → 404 `{ error:'notFound', ... }`, upstream failure → 500 `{ error:'unexpected', ... }`):

```json
{
  "data": {
    "id": "139",
    "login": "thomas_jung",
    "first_name": "Thomas",
    "last_name": "Jung",
    "rank": { "name": "SAP Developer Advocate" },
    "metrics": { "posts": 1234 },
    "avatar": { "profile": "https://community.sap.com/.../avatar.jpg" },
    "signature": "…",
    "view_href": "https://community.sap.com/t5/user/viewprofilepage/user-id/139",
    "user_badges": {
      "items": [
        {
          "badge": {
            "id": "12345",
            "title": "Community Contributor",
            "icon_url": "https://…/badge.png",
            "description": "Awarded for …"
          },
          "earned_date": "2025-10-01T00:00:00Z"
        }
      ]
    }
  }
}
```

Frozen facade exports (`srv/lib/community/khoros.js`): `callUserAPI`, `handleUserName`, `searchMessages`, `searchGrouphubMembers`, `searchGroups`, `getBoards`, `getBoard`, `getTopics`, `getMessagesForDiscussion`, `getEvents`, `getEvent`, `getEventsRegs`, `getMessagePosters`, `getCommunityTags`, `getDevtoberfestMembers`, `checkFileAge`, `searchAPIURL`, `groupsSearchAPIURL`.

Frozen route surface (`srv/routes/community.js`, all under `/community` at the approuter):
`GET /showcaseBadges/:scnId{/*badgeIds}`, `GET /showcaseBadgesGroups/:scnId{/*badgeIds}`, `GET /showcaseSingleBadge/:scnId{/*badgeIds}`, `GET /activity/:scnId`, `GET /user/:scnId`, `GET /tags`, `GET /khoros/{boards,board/:id,topics/:id,thread/:id,events/:id,event/:id,eventRegsRaw/:id,messagePosters/:b/:c,members/:grouphub,devtoberfestMembers}`, `GET /khoros/eventRegs/:boardId` (GATED), `POST /upload_selfie`.

---

### Task 1: Khoros facade — the single consolidated seam (native fetch + TTL cache)

**Repo:** `sap-community-gameboard`. Ported from source `D:\projects\sap-community-activity-badges\srv\util\khoros.js`, refactored to native `fetch`.

**Files:**
- Create: `srv/lib/community/khoros.js`
- Create: `test/fixtures/khoros-author.json` (recorded `messages.author.*` response for one user)
- Create: `test/fixtures/khoros-groups-boards.json` (recorded `groups` boards response)
- Test: `test/unit/community-khoros.test.js`
- Create: `srv/lib/community/cache/.gitkeep`; add `srv/lib/community/cache/*.json` to `.gitignore`

**Interfaces:**
- Consumes: Khoros HTTP endpoints (mocked via injected fetch in tests).
- Produces: the frozen facade exports listed in Interface Contracts. `callUserAPI(scnId) → { data: <author> }`.

- [ ] **Step 1: Capture the fixtures (one-time, from the live source app or a saved response)**

`test/fixtures/khoros-author.json` — the parsed body of a real `SELECT author.* FROM messages WHERE author.login = 'thomas_jung' LIMIT 1` call. Minimal but shape-complete:

```json
{
  "status": "success",
  "message": "",
  "http_code": 200,
  "data": {
    "items": [
      {
        "author": {
          "id": "139",
          "login": "thomas_jung",
          "first_name": "Thomas",
          "last_name": "Jung",
          "rank": { "name": "SAP Developer Advocate" },
          "metrics": { "posts": 1234 },
          "avatar": { "profile": "https://community.sap.com/legacyfs/online/avatar.jpg" },
          "signature": "Follow me on the SAP Community",
          "view_href": "https://community.sap.com/t5/user/viewprofilepage/user-id/139",
          "user_badges": {
            "items": [
              { "badge": { "id": "12345", "title": "Community Contributor", "icon_url": "https://community.sap.com/badge.png", "description": "Awarded for contributions" }, "earned_date": "2025-10-01T00:00:00Z" },
              { "badge": { "id": "12346", "title": "First Blog Post That Has A Really Long Title Over Twenty Chars", "icon_url": "https://community.sap.com/badge2.svg", "description": "First blog" }, "earned_date": "2025-10-02T00:00:00Z" }
            ]
          }
        }
      }
    ]
  }
}
```

`test/fixtures/khoros-groups-boards.json`:

```json
{ "status": "success", "message": "", "http_code": 200, "data": { "type": "boards", "list_item_type": "board", "size": 1, "items": [ { "id": "codejam-events", "title": "CodeJam Events" } ] } }
```

- [ ] **Step 2: Write the failing unit test**

`test/unit/community-khoros.test.js`:

```js
const { expect } = require('chai');
const path = require('path');
const fs = require('fs');

const authorFixture = JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/khoros-author.json'), 'utf8'));
const boardsFixture = JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/khoros-groups-boards.json'), 'utf8'));

// Inject a fake fetch so no live Khoros call happens in CI. The facade reads
// globalThis.fetch, so we stub it per-test and restore after.
function withFetch(bodyByUrl, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const key = Object.keys(bodyByUrl).find(k => String(url).includes(k));
    if (!key) throw new Error(`unexpected fetch url: ${url}`);
    return { ok: true, status: 200, json: async () => bodyByUrl[key] };
  };
  return Promise.resolve(fn()).finally(() => { globalThis.fetch = orig; });
}

describe('community khoros facade', () => {
  const khoros = require('../../srv/lib/community/khoros');

  it('callUserAPI returns the { data: <author> } envelope', async () => {
    await withFetch({ '/khhcw49343/api/2.0/search': authorFixture }, async () => {
      const res = await khoros.callUserAPI('thomas.jung');
      expect(res).to.have.property('data');
      expect(res.data.login).to.equal('thomas_jung');
      expect(res.data.rank.name).to.equal('SAP Developer Advocate');
      expect(res.data.metrics.posts).to.equal(1234);
      expect(res.data.user_badges.items).to.be.an('array').with.length(2);
      expect(res.data.user_badges.items[0].badge).to.include.keys(['id','title','icon_url','description']);
    });
  });

  it('handleUserName prefers first+last name', () => {
    expect(khoros.handleUserName('139', authorFixture.data.items[0].author && { data: authorFixture.data.items[0].author }))
      .to.equal('Thomas Jung');
  });

  it('getBoards returns the full groups envelope', async () => {
    await withFetch({ 'groups.community.sap.com/api/2.0/search': boardsFixture }, async () => {
      const body = await khoros.getBoards();
      expect(body.status).to.equal('success');
      expect(body.data.items[0].id).to.equal('codejam-events');
    });
  });

  it('callUserAPI throws a "No messages found" error on empty result (unknown user)', async () => {
    await withFetch({ '/khhcw49343/api/2.0/search': { status: 'success', data: { items: [] } } }, async () => {
      let err;
      try { await khoros.callUserAPI('nobody'); } catch (e) { err = e; }
      expect(err).to.be.an('error');
      expect(err.message).to.match(/No messages found for user/);
    });
  });
});
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `npx vitest run test/unit/community-khoros.test.js`
Expected: FAIL — `Cannot find module '../../srv/lib/community/khoros'`.

- [ ] **Step 4: Write `srv/lib/community/khoros.js` — user/badge host (native fetch)**

Port the top half of the source verbatim in behavior; swap `then-request` for `fetch`. Real code:

```js
const fs = require('fs');
const path = require('path');

const FETCH_TIMEOUT_MS = Number(process.env.KHOROS_TIMEOUT_MS) || 8000;

// TTL file cache — lives under the module dir (gitignored). Best-effort:
// a read-only CF FS degrades to live-fetch, never a crash.
const cacheDir = path.join(__dirname, 'cache');
const tagsCacheFile = path.join(cacheDir, 'tags.json');
module.exports.tagsCacheFile = tagsCacheFile;

// Two Khoros hosts (see source util/khoros.js:12-15, :285). The first carries
// user/badge/rank/signature data via messages.author.* expansion (the
// /users/:id endpoint was revoked for anonymous callers mid-2026); the second
// serves boards/threads/events/RSVPs/products and stays anonymously readable.
const searchAPIURL = 'https://community.sap.com/khhcw49343/api/2.0/search';
const groupsSearchAPIURL = 'https://groups.community.sap.com/api/2.0/search';
module.exports.searchAPIURL = searchAPIURL;
module.exports.groupsSearchAPIURL = groupsSearchAPIURL;

// Author fields projected from messages.author.* — reconstruct the shape the
// routes expect under scnItems.data.* (source util/khoros.js:24-39).
const AUTHOR_FIELDS = [
  'author.id', 'author.login', 'author.first_name', 'author.last_name',
  'author.rank.name', 'author.metrics.posts', 'author.avatar.profile',
  'author.signature', 'author.view_href',
  'author.user_badges.badge.id', 'author.user_badges.badge.title',
  'author.user_badges.badge.icon_url', 'author.user_badges.badge.description',
  'author.user_badges.earned_date'
].join(',');

// Native-fetch GET with AbortController timeout. Returns parsed JSON body.
// Throws on non-2xx or Khoros status != 'success'. Replaces the source's
// then-request `request('GET', url).getBody()` + JSON.parse pattern.
async function fetchKhorosJson(url) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(encodeURI(url), { signal: controller.signal });
    if (!res.ok) throw new Error(`Khoros HTTP ${res.status}`);
    const body = await res.json();
    if (body.status && body.status !== 'success') {
      throw new Error(`Khoros query failed: ${body.message || JSON.stringify(body)}`);
    }
    return body;
  } finally {
    clearTimeout(t);
  }
}

async function searchAuthor(whereClause) {
  const query = `SELECT ${AUTHOR_FIELDS} FROM messages WHERE ${whereClause} LIMIT 1`;
  const body = await fetchKhorosJson(`${searchAPIURL}?q=${encodeURIComponent(query)}`);
  if (!body?.data?.items?.length) {
    console.warn(`[khoros] searchAuthor returned 0 items for WHERE ${whereClause}.`);
  }
  return body?.data?.items?.[0]?.author || null;
}

async function searchMessages(whereClause, fields, opts = {}) {
  const limit = Number.isFinite(opts.limit) ? opts.limit : 100;
  const offset = Number.isFinite(opts.offset) && opts.offset > 0 ? opts.offset : 0;
  const tail = offset > 0 ? ` LIMIT ${limit} OFFSET ${offset}` : ` LIMIT ${limit}`;
  const query = `SELECT ${fields} FROM messages WHERE ${whereClause}${tail}`;
  const body = await fetchKhorosJson(`${searchAPIURL}?q=${encodeURIComponent(query)}`);
  const items = body?.data?.items || [];
  if (!items.length && offset === 0) {
    console.warn(`[khoros] searchMessages returned 0 items for WHERE ${whereClause}.`);
  }
  return items;
}
module.exports.searchMessages = searchMessages;

// Resolves a user by numeric id then normalized login (dots→underscores),
// last-ditch original dotted login. Returns { data: <author> } — source
// util/khoros.js:197-222 verbatim in logic.
async function callUserAPI(scnId) {
  try {
    const id = String(scnId);
    const isNumeric = /^\d+$/.test(id);
    let author = null;
    if (isNumeric) author = await searchAuthor(`author.id = '${id}'`);
    if (!author) {
      const login = id.replace(/\./g, '_');
      author = await searchAuthor(`author.login = '${login}'`);
    }
    if (!author && !isNumeric && id !== id.replace(/\./g, '_')) {
      author = await searchAuthor(`author.login = '${id}'`);
    }
    if (!author) {
      throw new Error(`No messages found for user '${scnId}' — user may have zero posts or the ID/login is unknown`);
    }
    return { data: author };
  } catch (error) {
    throw new Error(`Error fetching SCN data for ID ${scnId}: ${error.message}`, { cause: error });
  }
}
module.exports.callUserAPI = callUserAPI;

function handleUserName(scnId, scnItems) {
  let userName = scnId;
  if (scnItems.data) {
    userName = scnItems.data.login;
    if (scnItems.data.first_name && scnItems.data.first_name !== '') {
      userName = `${scnItems.data.first_name} ${scnItems.data.last_name}`;
    }
  }
  return userName;
}
module.exports.handleUserName = handleUserName;

function checkFileAge(filePath) {
  if (fs.existsSync(filePath)) {
    const stats = fs.statSync(filePath);
    const fileAgeInMs = Date.now() - stats.mtimeMs;
    return fileAgeInMs <= 24 * 60 * 60 * 1000;
  }
  return false;
}
module.exports.checkFileAge = checkFileAge;

async function getDevtoberfestMembers() {
  const url = `https://raw.githubusercontent.com/SAP-samples/sap-community-activity-badges/main/srv/util/members.json`;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(encodeURI(url), { signal: controller.signal });
    if (!res.ok) throw new Error(`members.json HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}
module.exports.getDevtoberfestMembers = getDevtoberfestMembers;
```

- [ ] **Step 5: Add `searchGrouphubMembers` (port source :120-188 verbatim, unchanged — pure logic over `searchMessages`)**

Copy the `searchGrouphubMembers(grouphub, opts)` function from source `srv/util/khoros.js:120-188` unchanged (it calls the already-ported `searchMessages`; no HTTP client reference inside it). Export it: `module.exports.searchGrouphubMembers = searchGrouphubMembers;`.

- [ ] **Step 6: Write the groups-host helpers (native fetch)**

Append. `searchGroups` replaces the source's `then-request` shim (source :295-306); the rest (`getBoards`, `getBoard`, `getTopics`, `getMessagesForDiscussion`, `getEvents`, `getEventsRegs`, `getEvent`, `getMessagePosters`, `getCommunityTags`) are ported verbatim from source :308-461 — they only call `searchGroups`, so no other change is needed. Real code for `searchGroups`:

```js
// opts.full=true → return parsed top-level body; else data.items array.
async function searchGroups(liqlQuery, app, opts = {}) {
  const url = `${groupsSearchAPIURL}?q=${liqlQuery}`;
  if (app?.logger?.info) app.logger.info(url);
  const body = await fetchKhorosJson(url);
  return opts.full ? body : (body?.data?.items || []);
}
module.exports.searchGroups = searchGroups;
```

Then paste `getBoards`, `getBoard`, `getTopics`, `getMessagesForDiscussion`, `getEvents`, `getEventsRegs`, `getEvent`, `getMessagePosters`, `getCommunityTags` from source :308-461 unchanged and export each (they already `module.exports.<name> = <name>` in the source). `getCommunityTags` gains a TTL-cache wrapper in Task 5 Step 4 — leave the live version here.

- [ ] **Step 7: Run the test**

Run: `npx vitest run test/unit/community-khoros.test.js`
Expected: PASS — envelope shape, name helper, groups envelope, and empty-user error all assert green against fixtures with zero live calls.

- [ ] **Step 8: Commit**

```bash
git add srv/lib/community/khoros.js srv/lib/community/cache/.gitkeep .gitignore \
        test/fixtures/khoros-author.json test/fixtures/khoros-groups-boards.json \
        test/unit/community-khoros.test.js
git commit -m "feat(community): Khoros facade on native fetch — single consolidated seam + fixture tests"
```

---

### Task 2: SVG render module + native sharp raster helper

**Repo:** `sap-community-gameboard`. Ported from source `srv/util/svgRender.js` (pure string builders) + one new raster helper.

**Files:**
- Create: `srv/lib/community/svg-render.js`
- Create: `srv/lib/community/images/` (copy `sap_18.png`, `blog.png`, `comment.png`, `error.png`, `devtoberfest/fonts/joystix_monospace.ttf`, `devtoberfest/selfie/*.png` from source `srv/images/`)
- Create: `test/fixtures/badge-author.json` (a one-badge author for the card test — may reuse `khoros-author.json`)
- Test: `test/unit/community-svg-render.test.js`

**Interfaces:**
- Consumes: nothing (pure string building) + `sharp` for the new raster helper + `then-request`→`fetch` swap inside `svgBadgeItem`/`svgBadgeItemGroups` (they fetch remote badge icon URLs).
- Produces: all source `svgRender.js` exports + new `rasterize(svgString, { format, animated })`.

- [ ] **Step 1: Write the failing test**

`test/unit/community-svg-render.test.js`:

```js
const { expect } = require('chai');
const svg = require('../../srv/lib/community/svg-render');

describe('community svg-render', () => {
  it('svgHeader emits a well-formed opening <svg> with dimensions', () => {
    const h = svg.svgHeader(500, 175);
    expect(h).to.include('<svg');
    expect(h).to.include('width="500"');
    expect(h).to.include('viewBox="0 0 500 175"');
  });

  it('escapeHTML escapes the five entities', () => {
    expect(svg.escapeHTML(`<a href='x' & "y">`)).to.equal('&lt;a href=&#39;x&#39; &amp; &quot;y&quot;&gt;');
  });

  it('svgActivityItem renders a stat row with title and value', () => {
    const out = svg.svgActivityItem(45, 450, 'BASE64', 'Posts', '1234', false);
    expect(out).to.include('Posts:');
    expect(out).to.include('1234');
    expect(out).to.include('data:image/png;base64,BASE64');
  });

  it('a full activity card assembles into a valid SVG string', () => {
    const body =
      svg.svgHeader(500, 150) +
      svg.svgStyles(svg.svgStyleHeader(), svg.svgStyleStat()) +
      svg.svgBackground() +
      svg.svgMainContent(svg.svgActivityItem(45, 450, 'B64', 'Rank', 'Advocate', false)) +
      svg.svgEnd();
    expect(body.trim().startsWith('<svg')).to.equal(true);
    expect(body.trim().endsWith('</svg>')).to.equal(true);
    expect(body).to.include('Rank:');
  });

  it('rasterize turns an SVG string into a PNG buffer', async () => {
    const body = svg.svgHeader(50, 50) + svg.svgBackground() + svg.svgEnd();
    const png = await svg.rasterize(body, { format: 'png' });
    expect(Buffer.isBuffer(png)).to.equal(true);
    // PNG magic bytes
    expect(png.slice(0, 4).toString('hex')).to.equal('89504e47');
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run test/unit/community-svg-render.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Port `svgRender.js` verbatim**

Copy source `D:\projects\sap-community-activity-badges\srv\util\svgRender.js` (lines 1-856) into `srv/lib/community/svg-render.js` **unchanged** for all pure builders. Two mechanical edits:
1. `svgBadgeItem` (source :654) and `svgBadgeItemGroups` (source :719) fetch a remote icon via `require('then-request')` → `request('GET', image).getBody()`. Replace those two fetch sites with native fetch:

```js
// inside svgBadgeItem / svgBadgeItemGroups, replacing the then-request lines:
const res = await fetch(image);
const imageData = Buffer.from(await res.arrayBuffer());
let imageBase64 = imageData.toString('base64');
```

(the surrounding png/svg branch logic and `sharp` conversion stay identical.)
2. `loadImageB64` (source :806) resolves `path.resolve(__dirname, image)` — since images move to `srv/lib/community/images/`, the relative paths callers pass (`'../images/sap_18.png'`) must resolve against `svg-render.js`'s dir. Keep callers passing `'../images/...'` and place `svg-render.js` in `srv/lib/community/` with images in `srv/lib/community/images/` → `../images/...` resolves correctly. No code change needed to `loadImageB64` itself.

- [ ] **Step 4: Add the native `rasterize` helper**

Append to `svg-render.js`:

```js
/**
 * Rasterize an SVG string to PNG or GIF via sharp. Centralizes the
 * sharp(Buffer.from(body))... calls the source routes inlined, so the
 * animated-vs-static distinction lives in one place.
 * @param {string} svgString
 * @param {{format?: 'png'|'gif', animated?: boolean, loop?: number}} [opts]
 * @returns {Promise<Buffer>}
 */
async function rasterize(svgString, opts = {}) {
  const sharp = require('sharp');
  const format = opts.format === 'gif' ? 'gif' : 'png';
  const animated = !!opts.animated;
  const input = Buffer.from(svgString);
  if (animated) {
    const img = sharp(input, { svg: true, animated: true, pages: -1 });
    return format === 'gif'
      ? img.gif({ loop: opts.loop ?? 1, animated: true }).toBuffer()
      : img.png({ animated: true }).toBuffer();
  }
  const img = sharp(input);
  return format === 'gif' ? img.gif({ loop: opts.loop ?? 1 }).toBuffer() : img.png().toBuffer();
}
module.exports.rasterize = rasterize;
```

- [ ] **Step 5: Run the test**

Run: `npx vitest run test/unit/community-svg-render.test.js`
Expected: PASS — header/escape/activity-row/full-card assemble correctly and `rasterize` returns a PNG buffer with the correct magic bytes.

- [ ] **Step 6: Commit**

```bash
git add srv/lib/community/svg-render.js srv/lib/community/images/ \
        test/unit/community-svg-render.test.js
git commit -m "feat(community): port svgRender builders + native sharp rasterize helper"
```

---

### Task 3: Community router scaffold + bootstrap wiring + first card route

**Repo:** `sap-community-gameboard`. Mirrors the tutorial repo's `devtoberfest-public.js` `register(app)` pattern (server.js:372).

**Files:**
- Create: `srv/routes/community.js` (exports `register(app)`)
- Create: `srv/lib/community/error-card.js` (rendered "user not found" / error SVG — replaces source `srv/util/error.js`)
- Create: `srv/lib/community/texts.js` (minimal i18n shim — `getBundle(req).getText(key, args)` + `getLocale(req)`; ports the two label keys the cards need)
- Modify: `srv/server.js` (add `community.register(app)` inside `cds.on('bootstrap')`)
- Test: `test/unit/community-showcase-route.test.js`

**Interfaces:**
- Consumes: `srv/lib/community/khoros.js`, `srv/lib/community/svg-render.js`.
- Produces: `GET /community/showcaseBadges/:scnId{/*badgeIds}` → `image/svg+xml` (or `image/png` with `?png=true`, `image/gif` with `?gif=true`).

- [ ] **Step 1: Write the failing route test (khoros mocked)**

`test/unit/community-showcase-route.test.js`:

```js
const { expect } = require('chai');
const express = require('express');
const path = require('path');
const fs = require('fs');

const authorFixture = JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/khoros-author.json'), 'utf8'));

describe('GET /community/showcaseBadges/:scnId', () => {
  let base;
  let server;

  before(async () => {
    // Stub the khoros module so no live call happens. require.cache injection:
    const khorosPath = require.resolve('../../srv/lib/community/khoros');
    require.cache[khorosPath] = {
      id: khorosPath, filename: khorosPath, loaded: true,
      exports: {
        callUserAPI: async () => ({ data: authorFixture.data.items[0].author }),
        handleUserName: (id, items) => items?.data?.first_name
          ? `${items.data.first_name} ${items.data.last_name}` : id,
      },
    };
    const community = require('../../srv/routes/community');
    const app = express();
    community.register(app);
    await new Promise((r) => { server = app.listen(0, r); });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => { server && server.close(); });

  it('returns image/svg+xml by default', async () => {
    const res = await fetch(`${base}/community/showcaseBadges/thomas.jung`);
    expect(res.status).to.equal(200);
    expect(res.headers.get('content-type')).to.include('image/svg+xml');
    const body = await res.text();
    expect(body.trim().startsWith('<svg')).to.equal(true);
  });

  it('returns image/png with ?png=true', async () => {
    const res = await fetch(`${base}/community/showcaseBadges/thomas.jung?png=true`);
    expect(res.status).to.equal(200);
    expect(res.headers.get('content-type')).to.include('image/png');
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.slice(0, 4).toString('hex')).to.equal('89504e47');
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run test/unit/community-showcase-route.test.js`
Expected: FAIL — `srv/routes/community.js` not found.

- [ ] **Step 3: Write `srv/lib/community/texts.js` (minimal i18n shim)**

```js
// Minimal replacement for the source srv/util/texts.js. The cards need two
// label templates and a locale for Intl.NumberFormat. Kept dependency-free.
const BUNDLE = {
  badgesShowcaseTitle: (args) => `${args[0]}${args[1]}s SAP Community Badges`,
  statsTitle: (args) => `${args[0]}${args[1]}s SAP Community Activity`,
  errorCommunityID: () => 'SAP Community user not found',
};
function getLocale(req) {
  const al = req?.headers?.['accept-language'];
  return (al && al.split(',')[0]) || 'en-US';
}
function getBundle() {
  return {
    getText(key, args = []) {
      const fn = BUNDLE[key];
      return fn ? fn(args) : key;
    },
  };
}
module.exports = { getBundle, getLocale };
```

- [ ] **Step 4: Write `srv/lib/community/error-card.js`**

```js
const svg = require('./svg-render');
const texts = require('./texts');

// Renders the "user not found / upstream error" SVG (or PNG) card, preserving
// the source srv/util/error.js behavior: a 200 image, not a 500, so an <img>
// embed in a README/signature degrades to a readable card.
async function handleError(error, req, res) {
  const isPng = !!(req.query.png || req.query.gif);
  const text = texts.getBundle(req);
  const body =
    svg.svgHeader(500, 120) +
    svg.svgStyles(svg.svgStyleHeader(), svg.svgStyleStat(), svg.svgStyleError(), svg.svgStyleIcon(), svg.svgStyleAnimate()) +
    svg.svgBackground() +
    (await svg.svgErrorHeader(text.getText('errorCommunityID'))) +
    svg.svgMainContent(svg.svgErrorDetails(70, 250, String(error?.message || 'error'), isPng)) +
    svg.svgEnd();
  if (req.query.png) {
    return res.type('image/png').status(200).send(await svg.rasterize(body, { format: 'png' }));
  }
  return res.type('image/svg+xml').status(200).send(body);
}
module.exports = { handleError };
```

- [ ] **Step 5: Write `srv/routes/community.js` — router scaffold + showcaseBadges**

Port the source `showcaseBadges.js:71-165` route body verbatim (badge wrapping, stagger animation, `badgeSelection`), but mount every route under a `/community`-prefixed `express.Router()` and use the ported facade + `rasterize`. Real code:

```js
const express = require('express');
const svg = require('../lib/community/svg-render');
const texts = require('../lib/community/texts');
const khoros = require('../lib/community/khoros');
const errorCard = require('../lib/community/error-card');

function nocache(req, res, next) {
  res.header('Cache-Control', 'private, no-cache, no-store, must-revalidate');
  res.header('Expires', '-1');
  res.header('Pragma', 'no-cache');
  next();
}

// Selects up to 5 badges — URL-specified (?badge1..5 via /*badgeIds) or the
// first 5 on the profile. Ported verbatim from source showcaseBadges.js:378-418.
function badgeSelection(params, scnItems) {
  let itemsTemp = [];
  const itemsTemp2 = [];
  if (params.badge1) {
    for (const scnItem of scnItems.data.user_badges.items) {
      if (scnItem.badge.id === params.badge1) itemsTemp2[0] = scnItem;
      if (scnItem.badge.id === params.badge2) itemsTemp2[1] = scnItem;
      if (scnItem.badge.id === params.badge3) itemsTemp2[2] = scnItem;
      if (scnItem.badge.id === params.badge4) itemsTemp2[3] = scnItem;
      if (scnItem.badge.id === params.badge5) itemsTemp2[4] = scnItem;
    }
    itemsTemp = itemsTemp2;
  } else {
    for (let index = 0; index < scnItems.data.user_badges.items.length && index < 5; index++) {
      itemsTemp.push(scnItems.data.user_badges.items[index]);
    }
  }
  return itemsTemp;
}

function assignBadgeIds(req) {
  for (let i = 0; i < 5; i++) {
    req.params[`badge${i + 1}`] = Array.isArray(req.params.badgeIds) ? req.params.badgeIds[i] : undefined;
  }
}

async function showcaseBadgesHandler(req, res) {
  assignBadgeIds(req);
  try {
    const isPng = !!(req.query.png || req.query.gif);
    const scnItems = await khoros.callUserAPI(req.params.scnId);
    const userName = khoros.handleUserName(req.params.scnId, scnItems);
    const text = texts.getBundle(req);
    let itemHeight = 43;
    let itemDelay = 250;
    const itemsTemp = badgeSelection(req.params, scnItems);
    const items = [];
    let width = 0;
    const textWrapper = require('text-wrapper').wrapper;

    for (const scnItem of itemsTemp) {
      if (scnItem.badge.title.length > 20) {
        const wrappedArray = textWrapper(svg.escapeHTML(scnItem.badge.title), { wrapOn: 20 }).split('\n');
        let secondHeight = itemHeight;
        for (let n = 0; n < wrappedArray.length; n++) {
          if (n === 0) {
            items.push(await svg.svgBadgeItem(secondHeight, width, (itemDelay += 200), scnItem.badge.icon_url, wrappedArray[n], isPng));
            secondHeight += 20;
          } else if (n === 1) {
            if (wrappedArray.length > 2) {
              wrappedArray[n] = wrappedArray[n].length > 17 ? wrappedArray[n].substring(0, 17) + '...' : wrappedArray[n] + '...';
            }
            items.push(await svg.svgBadgeItemSecond(secondHeight, width, itemDelay, wrappedArray[n], isPng));
          }
        }
        if (width === 0) width = 200; else { width = 0; itemHeight += 40; }
      } else {
        items.push(await svg.svgBadgeItem(itemHeight, width, (itemDelay += 200), scnItem.badge.icon_url, svg.escapeHTML(scnItem.badge.title), isPng));
        if (width === 0) width = 200; else { width = 0; itemHeight += 40; }
      }
    }

    const body =
      svg.svgHeader(500, 175) +
      svg.svgStyles(svg.svgStyleHeader(), svg.svgStyleBold(), svg.svgStyleStat(), svg.svgStyleStagger(), svg.svgStyleIcon(), svg.svgStyleAnimate()) +
      svg.svgBackground() +
      (await svg.svgContentHeader(text.getText('badgesShowcaseTitle', [userName, `'`]))) +
      svg.svgMainContent(items) +
      svg.svgEnd();

    if (req.query.png) return res.type('image/png').status(200).send(await svg.rasterize(body, { format: 'png', animated: true }));
    if (req.query.gif) return res.type('image/gif').status(200).send(await svg.rasterize(body, { format: 'gif', animated: true }));
    return res.type('image/svg+xml').status(200).send(body);
  } catch (error) {
    return errorCard.handleError(error, req, res);
  }
}

function register(app) {
  const router = express.Router();
  router.get('/showcaseBadges/:scnId{/*badgeIds}', nocache, showcaseBadgesHandler);
  // Tasks 4-6 append more routes onto this same router before it is mounted.
  app.__communityRouter = router; // exposed so later tasks can attach in one place
  app.use('/community', router);
}

module.exports = { register, showcaseBadgesHandler, badgeSelection, assignBadgeIds, nocache };
```

Note: Express 5 path syntax `:scnId{/*badgeIds}` matches the source (which runs Express 5). If the new repo pins Express 4, use `/showcaseBadges/:scnId/:badgeIds(*)?` and read `req.params.badgeIds.split('/')` — verify the pinned major in `package.json` at implementation time and pick the matching syntax.

- [ ] **Step 6: Wire into `srv/server.js` bootstrap**

In the new repo's `srv/server.js`, inside the existing `cds.on('bootstrap', (app) => { ... })` block (create the block if Plan A's server.js has none), add:

```js
import * as community from './routes/community.js';
// ...inside cds.on('bootstrap', (app) => { ... }):
community.register(app);
```

If the new repo's `srv/routes/community.js` is CommonJS (`module.exports`) while `server.js` is ESM, import via `import community from './routes/community.js'` with a `createRequire` shim OR author `community.js` as ESM `export function register`. Match Plan A's chosen module system; the tutorial repo's `devtoberfest-public.js` is ESM (`export function register`) — prefer ESM for consistency and convert the `module.exports` above to `export`.

- [ ] **Step 7: Run the test**

Run: `npx vitest run test/unit/community-showcase-route.test.js`
Expected: PASS — SVG by default, PNG with `?png=true` (magic bytes `89504e47`), khoros never hit live.

- [ ] **Step 8: Commit**

```bash
git add srv/routes/community.js srv/lib/community/error-card.js srv/lib/community/texts.js \
        srv/server.js test/unit/community-showcase-route.test.js
git commit -m "feat(community): /community router scaffold + showcaseBadges card, wired via bootstrap"
```

---

### Task 4: Remaining card routes + `/community/user/:scnId` JSON (Plan E contract)

**Repo:** `sap-community-gameboard`.

**Files:**
- Modify: `srv/routes/community.js` (append `showcaseBadgesGroups`, `showcaseSingleBadge`, `activity`, `user`)
- Test: `test/unit/community-user-route.test.js`

**Interfaces:**
- Consumes: the facade.
- Produces: `GET /community/showcaseBadgesGroups/:scnId{/*badgeIds}`, `GET /community/showcaseSingleBadge/:scnId{/*badgeIds}`, `GET /community/activity/:scnId`, `GET /community/user/:scnId` (JSON, the frozen Plan E contract).

- [ ] **Step 1: Write the failing `/user/:scnId` test**

`test/unit/community-user-route.test.js`:

```js
const { expect } = require('chai');
const express = require('express');
const path = require('path');
const fs = require('fs');
const authorFixture = JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/khoros-author.json'), 'utf8'));

describe('GET /community/user/:scnId', () => {
  let base, server;
  before(async () => {
    const khorosPath = require.resolve('../../srv/lib/community/khoros');
    require.cache[khorosPath] = { id: khorosPath, filename: khorosPath, loaded: true, exports: {
      callUserAPI: async (id) => {
        if (id === 'nobody') throw new Error(`No messages found for user '${id}'`);
        return { data: authorFixture.data.items[0].author };
      },
    }};
    const community = require('../../srv/routes/community');
    const app = express();
    community.register(app);
    await new Promise((r) => { server = app.listen(0, r); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server && server.close());

  it('returns the { data: <author> } envelope as JSON', async () => {
    const res = await fetch(`${base}/community/user/139`);
    expect(res.status).to.equal(200);
    expect(res.headers.get('content-type')).to.include('application/json');
    const body = await res.json();
    expect(body.data.login).to.equal('thomas_jung');
    expect(body.data.user_badges.items[0].badge).to.include.keys(['id','title','icon_url','description']);
    expect(body.data).to.include.keys(['avatar','signature','view_href','rank','metrics']);
  });

  it('returns 404 notFound for an unknown user', async () => {
    const res = await fetch(`${base}/community/user/nobody`);
    expect(res.status).to.equal(404);
    const body = await res.json();
    expect(body.error).to.equal('notFound');
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run test/unit/community-user-route.test.js`
Expected: FAIL — `/community/user/:scnId` not registered.

- [ ] **Step 3: Append the group/single card + activity handlers**

Port source `showcaseBadges.js:224-285` (`showcaseBadgesGroups`, uses `svgBadgeItemGroups`, header height 48, plain `.png()`/`.gif()`), `:316-376` (`showcaseSingleBadge`, `svgBackgroundLight` + `svgContentHeaderGroups(userName, true)`), and `activityCounts.js:41-86` (`activity`, `svgActivityItem` Posts + Rank rows). Add matching handlers to `community.js` using `svg.rasterize(body, { format })` (NON-animated for these — they use plain sharp in the source) and `errorCard.handleError` in the catch. Register on the router:

```js
router.get('/showcaseBadgesGroups/:scnId{/*badgeIds}', showcaseBadgesGroupsHandler);
router.get('/showcaseSingleBadge/:scnId{/*badgeIds}', showcaseSingleBadgeHandler);
router.get('/activity/:scnId', nocache, activityHandler);
```

`activityHandler` uses `new Intl.NumberFormat(texts.getLocale(req))` for `metrics.posts` and reads `scnItems.data.rank.name` — verbatim from `activityCounts.js:46-72`.

- [ ] **Step 4: Add `/user/:scnId` JSON handler**

Port `khorosUser.js:120-144` `/khoros/user/:scnId` behavior as `/community/user/:scnId` (the SPA-facing alias; keep `/khoros/user/:scnId` too in Task 5). Real code:

```js
async function userHandler(req, res) {
  try {
    const profile = await khoros.callUserAPI(req.params.scnId); // { data: <author> }
    return res.type('application/json').status(200).send(profile);
  } catch (error) {
    const msg = error?.message || '';
    const notFound = msg.includes('No messages found for user') || error?.name === 'No SCN ID' || error?.code === 303;
    return res.status(notFound ? 404 : 500).type('application/json').send({
      error: notFound ? 'notFound' : 'unexpected',
      message: 'SAP Community user not found',
      scnId: req.params.scnId,
    });
  }
}
router.get('/user/:scnId', userHandler);
```

- [ ] **Step 5: Run the test**

Run: `npx vitest run test/unit/community-user-route.test.js`
Expected: PASS — envelope keys present (Plan E contract), 404 on unknown user.

- [ ] **Step 6: Commit**

```bash
git add srv/routes/community.js test/unit/community-user-route.test.js
git commit -m "feat(community): group/single badge + activity cards + /user/:scnId JSON (Plan E contract)"
```

---

### Task 5: Khoros proxy routes + tags (TTL-cached) + gated RSVP export

**Repo:** `sap-community-gameboard`.

**Files:**
- Modify: `srv/routes/community.js` (append `/khoros/*` + `/tags` + gated `/khoros/eventRegs/:boardId`)
- Modify: `srv/lib/community/khoros.js` (TTL-cache wrapper on `getCommunityTags`)
- Test: `test/unit/community-proxy-routes.test.js`, `test/unit/community-eventregs-gate.test.js`

**Interfaces:**
- Consumes: the facade groups-host helpers.
- Produces: the read-only proxy routes (anonymous) + `GET /khoros/eventRegs/:boardId` (GATED, `Tutorial.Author`).

- [ ] **Step 1: Write the failing proxy + gate tests**

`test/unit/community-proxy-routes.test.js` — mock the facade's `getBoards`/`getCommunityTags`, assert JSON 200 and fail-soft (facade throw → `[]`/`{}`, HTTP 200, never 500):

```js
const { expect } = require('chai');
const express = require('express');

describe('/community/khoros proxy routes (fail-soft)', () => {
  let base, server;
  before(async () => {
    const khorosPath = require.resolve('../../srv/lib/community/khoros');
    require.cache[khorosPath] = { id: khorosPath, filename: khorosPath, loaded: true, exports: {
      getBoards: async () => ({ status: 'success', data: { items: [{ id: 'b1' }] } }),
      getCommunityTags: async () => { throw new Error('khoros down'); }, // force fail-soft
    }};
    const community = require('../../srv/routes/community');
    const app = express();
    community.register(app);
    await new Promise((r) => { server = app.listen(0, r); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server && server.close());

  it('GET /community/khoros/boards proxies the envelope', async () => {
    const res = await fetch(`${base}/community/khoros/boards`);
    expect(res.status).to.equal(200);
    expect((await res.json()).data.items[0].id).to.equal('b1');
  });

  it('GET /community/tags fails soft to {} on upstream error (never 500)', async () => {
    const res = await fetch(`${base}/community/tags`);
    expect(res.status).to.equal(200);
    expect(await res.json()).to.deep.equal({});
  });
});
```

`test/unit/community-eventregs-gate.test.js` — mount a fake auth middleware simulating anonymous vs author, assert 403 for anonymous:

```js
const { expect } = require('chai');
const express = require('express');

describe('GET /community/khoros/eventRegs/:boardId is scope-gated', () => {
  function appWith(user) {
    const app = express();
    app.use((req, _res, next) => { req.user = user; next(); }); // simulate CAP auth
    require('../../srv/routes/community').register(app);
    return app;
  }
  it('rejects anonymous with 403', async () => {
    const app = appWith({ id: 'anonymous', is: () => false });
    const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/community/khoros/eventRegs/codejam-events`);
      expect(res.status).to.equal(403);
    } finally { server.close(); }
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run test/unit/community-proxy-routes.test.js test/unit/community-eventregs-gate.test.js`
Expected: FAIL — routes not registered.

- [ ] **Step 3: Append the read-only proxy routes**

Port `khorosUser.js` proxy handlers verbatim (they call the facade), each with a **fail-soft** catch (`res.status(200).json([])` for array routes, `{}` for object routes) instead of the source's error-image handler. Register:

```js
router.get('/khoros/boards', mkProxy((req) => khoros.getBoards(req.app), []));
router.get('/khoros/board/:boardId', mkProxy((req) => khoros.getBoard(req.params.boardId, req.app), {}));
router.get('/khoros/topics/:boardId', mkProxy((req) => khoros.getTopics(req.params.boardId, req.app), []));
router.get('/khoros/thread/:threadId', mkProxy((req) => khoros.getMessagesForDiscussion(req.params.threadId, req.app), []));
router.get('/khoros/events/:boardId', mkProxy((req) => khoros.getEvents(req.params.boardId, req.app), {}));
router.get('/khoros/event/:eventId', mkProxy((req) => khoros.getEvent(req.params.eventId, req.app), {}));
router.get('/khoros/eventRegsRaw/:boardId', mkProxy((req) => khoros.getEventsRegs(req.params.boardId, req.app), []));
router.get('/khoros/messagePosters/:boardId/:conversationId', mkProxy((req) => khoros.getMessagePosters(req.params.boardId, req.params.conversationId, req.app), []));
router.get('/khoros/members/:grouphub', mkProxy((req) => khoros.searchGrouphubMembers(req.params.grouphub || 'Devtoberfest'), { data: { items: [] } }));
router.get('/khoros/devtoberfestMembers', mkProxy(() => khoros.getDevtoberfestMembers(), []));
router.get('/khoros/user/:scnId', userHandler); // alias of /community/user/:scnId
```

where `mkProxy` is a small fail-soft wrapper:

```js
function mkProxy(fn, emptyShape) {
  return async (req, res) => {
    try {
      const out = await fn(req);
      return res.type('application/json').status(200).send(out);
    } catch (error) {
      cds.log?.('community')?.warn?.(`khoros proxy failed: ${error.message}`);
      return res.type('application/json').status(200).send(emptyShape); // fail-soft
    }
  };
}
```

- [ ] **Step 4: Add TTL-cached `/tags` + facade cache wrapper**

In `srv/lib/community/khoros.js`, wrap `getCommunityTags` with the 1-day file cache (`checkFileAge(tagsCacheFile)` → read cached JSON; else fetch, write best-effort, return). Real code appended to the facade:

```js
const rawGetCommunityTags = getCommunityTags; // the live version defined above
async function getCommunityTagsCached(app) {
  try {
    if (checkFileAge(tagsCacheFile)) {
      return JSON.parse(fs.readFileSync(tagsCacheFile, 'utf8'));
    }
  } catch { /* cache miss/parse error → fall through to live */ }
  const fresh = await rawGetCommunityTags(app);
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(tagsCacheFile, JSON.stringify(fresh));
  } catch { /* read-only FS → live-fetch-every-time, no crash */ }
  return fresh;
}
module.exports.getCommunityTags = getCommunityTagsCached;
```

Register the route (fail-soft to `{}`):

```js
router.get('/tags', mkProxy((req) => khoros.getCommunityTags(req.app), {}));
```

- [ ] **Step 5: Add the GATED RSVP export route**

Port `khorosUser.js:396-531` (`/khoros/eventRegs/:boardId` HTML admin page with email/CSV/Excel export tooling) verbatim into `eventRegsHandler`, prefixed with a scope gate:

```js
function requireAuthorScope(req, res, next) {
  const user = req.user || cds.context?.user;
  const ok = user && user.id && user.id !== 'anonymous'
    && typeof user.is === 'function' && user.is('Tutorial.Author');
  if (!ok) return res.status(403).json({ error: 'FORBIDDEN', message: 'Tutorial.Author scope required' });
  next();
}
router.get('/khoros/eventRegs/:boardId', requireAuthorScope, eventRegsHandler);
```

`eventRegsHandler` builds the HTML exactly as source `khorosUser.js:397-525` (the `escape()` helper, per-event RSVP-count badges, the `composeEmail`/`openEmailDraft`/`openExcel` client scripts) using `await khoros.getEventsRegs(req.params.boardId, req.app)`, `res.type('text/html').status(200).send(output)`; catch → fail-soft `res.status(200).send('<!DOCTYPE html><html><body><p>No event data available.</p></body></html>')`.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run test/unit/community-proxy-routes.test.js test/unit/community-eventregs-gate.test.js`
Expected: PASS — boards proxied, tags fails soft to `{}` at HTTP 200, eventRegs 403 for anonymous.

- [ ] **Step 7: Commit**

```bash
git add srv/routes/community.js srv/lib/community/khoros.js \
        test/unit/community-proxy-routes.test.js test/unit/community-eventregs-gate.test.js
git commit -m "feat(community): khoros proxy routes (fail-soft) + TTL-cached tags + gated RSVP export"
```

---

### Task 6: `POST /community/upload_selfie` (multer + sharp compositor)

**Repo:** `sap-community-gameboard`.

**Files:**
- Modify: `srv/routes/community.js` (append selfie route)
- Test: `test/unit/community-selfie-route.test.js`

**Interfaces:**
- Consumes: `svg-render.js` (`svgDevtoberfestItem`, `svgHeader`, `svgStyles`, `svgEnd`, `loadImageB64`, `rasterize`), `sharp`, `multer`.
- Produces: `POST /community/upload_selfie` → base64 PNG string, `image/png`.

- [ ] **Step 1: Write the failing test**

`test/unit/community-selfie-route.test.js` — POST a small PNG buffer + `selectedPic` field, assert a base64 PNG string comes back. Use a real 1x1 PNG buffer and a fixture overlay asset placed at `srv/lib/community/images/devtoberfest/selfie/test-frame.png`:

```js
const { expect } = require('chai');
const express = require('express');
const community = require('../../srv/routes/community');

describe('POST /community/upload_selfie', () => {
  let base, server;
  before(async () => {
    const app = express();
    community.register(app);
    await new Promise((r) => { server = app.listen(0, r); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server && server.close());

  it('composites an uploaded image over the selected frame and returns base64 PNG', async () => {
    // 1x1 red PNG
    const png1x1 = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360f8cf00000301010018dd8db00000000049454e44ae426082', 'hex');
    const form = new FormData();
    form.append('selfie', new Blob([png1x1], { type: 'image/png' }), 'selfie.png');
    form.append('selectedPic', 'test-frame');
    const res = await fetch(`${base}/community/upload_selfie`, { method: 'POST', body: form });
    expect(res.status).to.equal(200);
    expect(res.headers.get('content-type')).to.include('image/png');
    const b64 = await res.text();
    expect(Buffer.from(b64, 'base64').slice(0, 4).toString('hex')).to.equal('89504e47');
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run test/unit/community-selfie-route.test.js`
Expected: FAIL — route not registered (and/or `test-frame.png` overlay missing — add a small PNG there).

- [ ] **Step 3: Append the selfie route**

Port source `selfie.js:4-74` verbatim into `community.js`, using the ported `svg` module and `svg.rasterize`. Real code:

```js
const multer = require('multer');
const _selfieUpload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 1, fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/pjpeg', 'image/png', 'image/gif'];
    cb(null, allowed.includes(file.mimetype));
  },
});

router.post('/upload_selfie', (req, res) => {
  _selfieUpload.any()(req, res, async (err) => {
    if (err) {
      const msg = /File too large/.test(String(err)) ? 'Uploaded file is too large. Please choose a file less than 20MB in size' : String(err);
      return res.status(500).send(msg);
    }
    try {
      const sharp = require('sharp');
      const path = require('path');
      const file = (req.files || [])[0];
      if (!file) return res.status(400).send('missing file');
      let selectedPic = String(req.body.selectedPic || '').replace('application-selfie-ui-component---App--', '');
      const uploadContent = await sharp(file.buffer).rotate().png().toBuffer();
      const advPic = `../images/devtoberfest/selfie/${selectedPic}.png`;
      const advPicMeta = await sharp(path.resolve(__dirname, '../lib/community', advPic)).metadata();
      const body =
        svg.svgHeader(advPicMeta.width, advPicMeta.height) +
        svg.svgStyles(svg.svgStyleHeader(), svg.svgStyleBold()) +
        svg.svgDevtoberfestItem(0, 0, 0, uploadContent.toString('base64'), advPicMeta.height, advPicMeta.width, true) +
        svg.svgDevtoberfestItem(0, 0, 0, await svg.loadImageB64(advPic), advPicMeta.height, advPicMeta.width, true) +
        svg.svgEnd();
      const png = await svg.rasterize(body, { format: 'png' });
      return res.type('image/png').status(200).send(png.toString('base64'));
    } catch (error) {
      cds.log?.('community')?.error?.(error);
      return res.status(500).send(String(error.message || error));
    }
  });
});
```

Note: `loadImageB64` and the second `sharp(path.resolve(__dirname, advPic))` in the source resolve relative to `svgRender.js`'s dir. Since `svg-render.js` and `images/` are both under `srv/lib/community/`, `loadImageB64('../images/...')` resolves inside `svg-render.js` correctly; the metadata read in the route resolves against `srv/lib/community` explicitly (as shown). Verify the two paths land on the same file at implementation time.

- [ ] **Step 4: Run the test**

Run: `npx vitest run test/unit/community-selfie-route.test.js`
Expected: PASS — returns a base64 string that decodes to a PNG (magic bytes `89504e47`).

- [ ] **Step 5: Commit**

```bash
git add srv/routes/community.js srv/lib/community/images/devtoberfest/selfie/test-frame.png \
        test/unit/community-selfie-route.test.js
git commit -m "feat(community): POST /upload_selfie multer+sharp compositor"
```

---

### Task 7: Approuter routes for `/community/*` in `tutorials-ims`

**Repo:** `tutorials-ims`. Makes the community surface reachable through the single front door (mirrors Plan A Task 6). Anonymous for public reads; scoped for the RSVP export admin page.

**Files:**
- Modify: `approuter/xs-app.json`
- Modify: `mta.yaml` AND `.deploy/mta.yaml` (the `gameboard-srv-api` destination added in Plan A Task 6 also serves `/community/*` — no new destination, just new route blocks)
- Test: manual curl checks (Playwright deferred to Plan C/E UI specs)

**Interfaces:**
- Consumes: `gameboard-srv-api` (the destination Plan A Task 6 declares).
- Produces: `/community/*` reachable through the tutorial approuter — public reads anonymous, `/community/khoros/eventRegs/*` gated `$XSAPPNAME.Tutorial.Author`.

- [ ] **Step 1: Add the GATED eventRegs block FIRST (longest-prefix wins; must precede the catch-all `/community/`)**

Insert into `approuter/xs-app.json` BEFORE the general `/community/` block and BEFORE the final catch-all `^(.*)$`:

```json
{
  "source": "^/community/khoros/eventRegs/(.*)$",
  "destination": "gameboard-srv-api",
  "authenticationType": "xsuaa",
  "scope": "$XSAPPNAME.Tutorial.Author",
  "csrfProtection": false
}
```

- [ ] **Step 2: Add the public anonymous `/community/*` block**

Immediately after the gated block:

```json
{
  "source": "^/community/(.*)$",
  "destination": "gameboard-srv-api",
  "authenticationType": "none",
  "csrfProtection": false
}
```

Route ordering matters: the approuter matches routes top-to-bottom, so the specific `eventRegs` xsuaa block MUST appear before the broad anonymous `/community/(.*)` block, otherwise the export page would be served anonymously. (Same longest-prefix-first discipline as the `/graph/(neighborhood…)` anonymous block preceding `/graph/(.*)` xsuaa in the existing file, xs-app.json:200-211.)

- [ ] **Step 3: Confirm the destination exists**

`gameboard-srv-api` is declared by Plan A Task 6 in BOTH `mta.yaml` and `.deploy/mta.yaml`. No change needed here if Plan A landed; if deploying Plan D independently first, add the destination per Plan A Task 6 Step 2 (mirror both files exactly — dual-mta caveat).

- [ ] **Step 4: Deploy the approuter (full deploy per runbook) + verify**

```bash
npm run deploy -- --env dev   # full — approuter static bundle must rebuild; no --skip-build, no -m scoping
# public read — anonymous, expect image/svg+xml:
curl -sI "https://<tutorial-approuter-host>/community/showcaseBadges/thomas.jung" | grep -i content-type
# gated export — anonymous, expect a 302 to the IDP login (or 403), NOT 200 HTML:
curl -sI "https://<tutorial-approuter-host>/community/khoros/eventRegs/codejam-events" | head -1
```

Expected: showcaseBadges returns `content-type: image/svg+xml` anonymously; eventRegs redirects to login / is not served anonymously.

- [ ] **Step 5: Commit (PR on `tutorials-ims`)**

```bash
git add approuter/xs-app.json mta.yaml .deploy/mta.yaml
git commit -m "feat(approuter): route /community/* to gameboard backend (public reads anon, RSVP export scoped)"
```

---

## Self-Review

**Spec coverage (§6.2 the /community facade + §6.3 approuter + §6.4 error handling):**
- `srv/lib/community/khoros.js` as the single Khoros seam, `callUserAPI` `{ data }` envelope, TTL caching, both hosts → Task 1. ✅
- `srv/lib/community/svg-render.js` ported pure builders + sharp raster helper → Task 2. ✅
- `/community/showcaseBadges/:scnId`, `/showcaseBadgesGroups`, `/showcaseSingleBadge` → Tasks 3, 4. ✅
- `/community/activity/:scnId` → Task 4. ✅
- `/community/user/:scnId` JSON (Plan E contract, frozen envelope) → Task 4. ✅
- `/community/khoros/*` proxy (boards/topics/threads/events/RSVP + export) → Task 5. ✅
- `/community/tags` (SAP Managed Tags A-Z, TTL-cached) → Task 5. ✅
- `POST /community/upload_selfie` (multer + sharp compositor) → Task 6. ✅
- Express router mounted via `cds.on('bootstrap')` mirroring `devtoberfest-public.js` `register(app)` → Task 3 Step 6. ✅
- Public reads anonymous; RSVP admin/export gated `Tutorial.Author` at approuter + defensively in handler → Tasks 5, 7. ✅
- Approuter `/community/*` route blocks (gated-before-anonymous ordering) → Task 7. ✅
- Fail-soft (Khoros timeout/error → cached/empty-valid, never 500) → AbortController timeout (Task 1), `mkProxy` empty-shape catch + error-card for image routes (Tasks 3-5). ✅
- Recorded-fixture tests, no live Khoros in CI → Tasks 1-6 all stub `fetch` or the khoros module. ✅
- Native fetch over got/then-request → Task 1 (`fetchKhorosJson` + AbortController), Task 2 (badge-icon fetch). ✅
- Does NOT re-source badge/tag from HANA (Khoros-sourced by nature) → facade is the only data path; no HANA table added. ✅
- Does NOT build the signature SPA (Plan E) but delivers `/community/user/:scnId` it consumes → Task 4. ✅

**Placeholder scan:** No TBDs. The two "port verbatim from source lines X" steps (svgRender pure builders in Task 2; the eventRegs HTML admin page in Task 5) are mechanical file copies of an existing, working source file — the exact source path + line ranges are cited, and the *changed* lines (fetch swaps, gate prefix, fail-soft catch) are given as real code. The Express-version path-syntax note (Task 3 Step 5) is a verify-at-implementation branch, not a placeholder — both syntaxes are spelled out.

**Type/contract consistency:** The `callUserAPI` envelope (`{ data: { id, login, first_name, last_name, rank.name, metrics.posts, avatar.profile, signature, view_href, user_badges.items[].badge.{id,title,icon_url,description}, earned_date } }`) is identical across the facade (Task 1), the fixture (`khoros-author.json`), the `/user/:scnId` handler + test (Task 4), and the frozen Interface Contract Plan E reads. Route paths under `/community` match between the router registrations (Tasks 3-6), the approuter blocks (Task 7), and the frozen route surface. Scope `$XSAPPNAME.Tutorial.Author` is identical in the handler gate (Task 5), the approuter block (Task 7), and the shared-xsappname note (Global Constraints).

**Fail-soft audit:** proxy routes → HTTP 200 empty-shape (Task 5 `mkProxy`); card routes → rendered error card at HTTP 200 (Task 3 `errorCard`); per-user JSON → 404 notFound vs 500 unexpected split preserved (Task 4); TTL-cache write on read-only FS → try/catch no-op (Tasks 1, 5). No path returns a bare 500 on an upstream hiccup except `/user/:scnId`'s genuine-upstream-failure branch (500 `unexpected`), which matches the source's deliberate 404-vs-500 distinction for the SPA.
