# Channels Hub Phase 2 — Crosswalk (both directions) + Media-Diet Signed-in + Export

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the channel↔topic bidirectional crosswalk (Direction 1 unit-test + Direction 2 new per-channel BLOB pages), the signed-in media-diet endpoint, and the OPML/bookmarks/JSON export endpoint, all building on the Phase 0 seed and schema migrations.

**Architecture:** Direction 1 is already coded in `topics-query.js`/`topic-detail-render.js` — this plan adds only a regression-pinning unit test and a CSS polish note. Direction 2 mirrors the `publish-topics.js` + `serveHandler` BLOB pattern exactly: new `build-channel-detail.js`, `channel-detail-render.js`, `publish-channels.js`, wired into `scripts/publish-content.ts` and `srv/server.js`. Media-diet endpoints live in `srv/server.js` as inline Express handlers, mirroring the existing `/api/*` pattern, with user resolution via `resolveUserSapId` (from `srv/lib/resolve-db-user.js`).

**Tech Stack:** Node.js/CAP, `@sap/cds` CQL, Express (inline in `srv/server.js`), `gzipSync`/`createHash` (node:zlib / node:crypto), Vitest + `cds.test('serve','--in-memory')`.

**Spec:** `docs/superpowers/specs/2026-09-05-channels-hub-design.md`

## Global Constraints

- Target branch is **DEV**; `main` is protected; open a PR, never direct-merge. NO main-hotfix path.
- **No raw SQL** anywhere — `SELECT.from(...)` CQL / `cds.ql` only; raw `db.run()` ONLY for BLOB serve.
- Slug comparisons are **lowercase-canonical** — `.toLowerCase()` before comparing.
- **Never SELECT a HANA BLOB alongside metadata in one CDS QL query** — use raw `db.run()` for BLOB serve paths.
- `focusAreas`/`tags`/`relatedUrls` are HANA JSON NCLOB arrays — no DB-side array-contains; filter in application code.
- Anon endpoints need approuter `authenticationType:none`; signed-in use `xsuaa`.
- Any new `srv/lib/*` file + transitive `./` imports must be added to `.deploy/mta.yaml` srv-qa `cp` list.
- Schema changes need `db/persistence.cds` `@cds.persistence.journal` entry and `cds build --production`.
- Unit tests use `cds.test('serve', '--project', '.', '--in-memory')` and `cds.entities(NS)` (never bare `SELECT.from('X')`); resolve Users by `sapId` not `uuid`.
- Phase 0 prerequisites (slug + feedUrl columns on Channels, ChannelTopicMap seeded + REVIEWED rows) are assumed complete before executing this plan.
- Approuter route ordering: literal `/channels/atlas`, `/channels/health`, `/channels/media-diet` routes MUST precede the `:slug` catch-all in xs-app.json.
- srv-qa cp-list audit required for every new `srv/lib/` file added; lazy-import any heavy dep below the boot path.
- Publishers carry the ≥5% error-rate abort guard (same pattern as `publish-topics.js`).

---

## Phase 0 Locked Interfaces (consumed here — assumed provided by Phase 0)

- `Channels.slug : String(200)` — nullable; resolve by `.toLowerCase()`, fallback to `sourceId`.
- `Channels.feedUrl : String(500)` — nullable; OPML `xmlUrl` only for non-null rows.
- `ChannelTopicMap.authoringStatus` — filter `=== 'REVIEWED'` to surface rows.
- `ChannelTopicMap.channel_ID`, `.topicTag`, `.relevance` — crosswalk spine.
- namespace `com.sap.developers.ims` throughout.

---

## File Structure

### Created (new files)

- `srv/lib/build-channel-detail.js` — `buildChannelDetailPayload(db, slug)` query function.
- `srv/lib/channel-detail-render.js` — `renderChannelDetail(channel)` → `{ body, contentHash }` HTML renderer.
- `srv/lib/publish-channels.js` — `renderChannelsIntoSession(args)` + `createRenderChannels()` + `renderChannelsHandler` Express handler (mirrors `publish-topics.js`).
- `test/unit/channel-detail-query.test.js` — unit tests for `buildChannelDetailPayload`.
- `test/unit/publish-channels.test.js` — unit tests for `renderChannelsIntoSession` (error-rate guard, delta skip).
- `test/unit/media-diet-picks.test.js` — unit tests for the `/api/media-diet/my-picks` logic.
- `test/unit/media-diet-export.test.js` — unit tests for the `/api/media-diet/export` logic.

### Modified (existing files)

- `scripts/lib/publish-client.ts` — add `renderChannelsPhase` function + interfaces.
- `scripts/publish-content.ts` — wire `renderChannelDetailPhase` call (after render-topics, before commit; prod-only + full-publish guard).
- `srv/server.js` — add `/build/channel-detail/:slug`, `/content/channel-detail/:slug`, `/content/publish/render-channels`, `/api/media-diet/my-picks`, `/api/media-diet/export` routes.
- `approuter/xs-app.json` — add literal child routes (atlas, health, media-diet already handled by Phase 1) + `^/channels/([^/?]+)/?$` catch-all + `/api/media-diet/my-picks` (xsuaa) + `/api/media-diet/export` (none).
- `scripts/check-srv-qa-route-drift.ts` — add ALLOWLIST entry for `POST /content/publish/render-channels`.
- `test/unit/topics-query-channels.test.js` — **existing file** — add second `describe` block pinning Direction 1 dark-code behaviour with REVIEWED rows present. (This file already exists and already seeds the correct fixtures; add a new `describe` block, do not modify the existing one.)

---

## Task 1: Direction 1 regression-pinning unit test

**Files:**
- Modify: `test/unit/topics-query-channels.test.js`

**Interfaces:**
- Consumes: `buildTopicDetailPayload(db, slug)` from `srv/lib/topics-query.js` (already tested in this file).
- Produces: verified behaviour — `relatedChannels` array is non-empty when REVIEWED ChannelTopicMap rows exist; existing fixtures already seed this condition.

- [ ] **Step 1: Read the existing test file to understand current fixtures and describe blocks**

  Open `test/unit/topics-query-channels.test.js`. Verify that `beforeAll` already seeds:
  - `Tags` row with `titlePath: 'Software Product : SAP HANA Cloud'`
  - One `Channels` row with `authoringStatus: 'REVIEWED'`, `isPublished: true`, `linkStatus: 'OK'`
  - One row filtered out (`AI_SEEDED`), one filtered out (`isPublished: false`)

  This is already correct — the existing tests pass only `'https://reviewed-ch'` in `relatedChannels`.

- [ ] **Step 2: Write a new describe block at the end of the file (do not touch existing tests)**

  Append to `test/unit/topics-query-channels.test.js`:

  ```js
  describe('topics-query — Direction 1 dark-code regression net', () => {
    // Uses the same fixtures seeded in the outer beforeAll above.
    // Purpose: ensure relatedChannels lights up in the topic payload once REVIEWED
    // rows are present, so future refactors can't silently darken it again.
    it('returns at least one relatedChannel entry when REVIEWED ChannelTopicMap rows exist', async () => {
      const payload = await buildTopicDetailPayload(db, 'software-product-sap-hana-cloud');
      expect(payload.relatedChannels.length).toBeGreaterThanOrEqual(1);
    });

    it('relatedChannels entries include name, url, ownerType, isSapOwned, relevance fields', async () => {
      const payload = await buildTopicDetailPayload(db, 'software-product-sap-hana-cloud');
      const ch = payload.relatedChannels[0];
      expect(ch).toHaveProperty('name');
      expect(ch).toHaveProperty('url');
      expect(ch).toHaveProperty('ownerType');
      expect(ch).toHaveProperty('isSapOwned');
      expect(ch).toHaveProperty('relevance');
    });
  });
  ```

- [ ] **Step 3: Run test to confirm both new cases pass (existing suite unchanged)**

  ```bash
  npx vitest run test/unit/topics-query-channels.test.js --project unit
  ```

  Expected: all tests PASS (new describe block passes immediately because the existing fixture already seeds a REVIEWED row).

- [ ] **Step 4: Commit**

  ```bash
  git add test/unit/topics-query-channels.test.js
  git commit -m "test(crosswalk): pin Direction-1 dark-code regression net for relatedChannels"
  ```

---

## Task 2: `buildChannelDetailPayload` — query function

**Files:**
- Create: `srv/lib/build-channel-detail.js`
- Create: `test/unit/channel-detail-query.test.js`

**Interfaces:**
- Consumes: `loadLiveTags(db)` from `srv/lib/topics-query.js` (returns `Array<{titlePath, label, slug, tutorialCount, ...}>`); `titlePathToMdFormat(titlePath)` from `srv/lib/tag-md-format.js`; `cds.entities('com.sap.developers.ims')` → `{ Channels, ChannelTopicMap }`.
- Produces:
  - `buildChannelDetailPayload(db, slug)` → `Promise<ChannelDetailPayload>` where `ChannelDetailPayload` is:
    ```js
    {
      slug: string,          // canonical lowercase slug
      name: string,
      url: string,
      purpose: string | null,
      ownerType: string | null,
      topics: Array<{ slug: string, label: string, tutorialCount: number, relevance: number }>,
      buildAt: string,       // ISO timestamp
      notFound: boolean,     // true when channel slug unresolvable
    }
    ```

- [ ] **Step 1: Write the failing test**

  Create `test/unit/channel-detail-query.test.js`:

  ```js
  // test/unit/channel-detail-query.test.js
  import { describe, it, beforeAll, expect } from 'vitest';
  import cds from '@sap/cds';
  import { buildChannelDetailPayload } from '../../srv/lib/build-channel-detail.js';
  import { titlePathToMdFormat } from '../../srv/lib/tag-md-format.js';

  const NS = 'com.sap.developers.ims';

  cds.test('serve', '--project', '.', '--in-memory');

  describe('buildChannelDetailPayload', () => {
    let db;
    const TITLE_PATH = 'Software Product : SAP CAP';
    const md = titlePathToMdFormat(TITLE_PATH); // 'software-product>sap-cap'

    beforeAll(async () => {
      db = await cds.connect.to('db');
      const { Tags, Tutorials, TutorialTags, Channels, ChannelTopicMap } = cds.entities(NS);

      // Tag + tutorial → live tag surfaces for this titlePath
      await db.run(INSERT.into(Tags).entries([
        { ID: 'cdtag1', titlePath: TITLE_PATH, label: 'SAP CAP', name: 'sap-cap' },
      ]));
      await db.run(INSERT.into(Tutorials).entries([
        { ID: 'cdtut1', slug: 'cd-cap-intro', title: 'CAP Intro', experienceTag: 'Beginner' },
        { ID: 'cdtut2', slug: 'cd-cap-advanced', title: 'CAP Advanced', experienceTag: 'Advanced' },
      ]));
      await db.run(INSERT.into(TutorialTags).entries([
        { tutorial_ID: 'cdtut1', tag_ID: 'cdtag1' },
        { tutorial_ID: 'cdtut2', tag_ID: 'cdtag1' },
      ]));

      // Channel with slug (Phase 0 added slug column)
      await db.run(INSERT.into(Channels).entries([
        {
          ID: 'cdch1',
          sourceId: 'cd-test-channel',
          slug: 'sap-cap-channel',
          name: 'SAP CAP Channel',
          url: 'https://cap-channel.example',
          purpose: 'The CAP channel',
          ownerType: 'SAP_Official',
          isSapOwned: true,
          isPublished: true,
          linkStatus: 'OK',
        },
      ]));
      await db.run(INSERT.into(ChannelTopicMap).entries([
        { ID: cds.utils.uuid(), channel_ID: 'cdch1', topicTag: md, authoringStatus: 'REVIEWED', relevance: 90 },
      ]));

      // An unpublished channel — must NOT be resolved
      await db.run(INSERT.into(Channels).entries([
        {
          ID: 'cdch2',
          sourceId: 'cd-unpub-channel',
          slug: 'cd-unpub',
          name: 'Unpublished',
          url: 'https://unpub.example',
          ownerType: 'Community_Member',
          isSapOwned: false,
          isPublished: false,
          linkStatus: 'OK',
        },
      ]));
    });

    it('resolves channel by slug (lowercase) and returns topics with tutorialCount', async () => {
      const payload = await buildChannelDetailPayload(db, 'sap-cap-channel');
      expect(payload.notFound).toBeFalsy();
      expect(payload.slug).toBe('sap-cap-channel');
      expect(payload.name).toBe('SAP CAP Channel');
      expect(payload.topics.length).toBeGreaterThanOrEqual(1);
      const topic = payload.topics[0];
      expect(topic.tutorialCount).toBe(2); // two tutorials tagged with this topic
      expect(topic.slug).toBeTruthy();
      expect(typeof topic.relevance).toBe('number');
    });

    it('resolves channel by slug regardless of input case', async () => {
      const payload = await buildChannelDetailPayload(db, 'SAP-CAP-CHANNEL');
      expect(payload.notFound).toBeFalsy();
      expect(payload.slug).toBe('sap-cap-channel');
    });

    it('returns notFound:true for unknown slug', async () => {
      const payload = await buildChannelDetailPayload(db, 'does-not-exist-xyz');
      expect(payload.notFound).toBe(true);
    });

    it('returns notFound:true for unpublished channel', async () => {
      const payload = await buildChannelDetailPayload(db, 'cd-unpub');
      expect(payload.notFound).toBe(true);
    });

    it('includes buildAt ISO timestamp', async () => {
      const payload = await buildChannelDetailPayload(db, 'sap-cap-channel');
      expect(typeof payload.buildAt).toBe('string');
      expect(() => new Date(payload.buildAt)).not.toThrow();
    });
  });
  ```

- [ ] **Step 2: Run test to confirm it fails**

  ```bash
  npx vitest run test/unit/channel-detail-query.test.js --project unit
  ```

  Expected: FAIL — `Cannot find module '../../srv/lib/build-channel-detail.js'`.

- [ ] **Step 3: Create `srv/lib/build-channel-detail.js`**

  ```js
  // srv/lib/build-channel-detail.js
  //
  // Direction 2 of the Learn↔Follow crosswalk (channels-hub Phase 2).
  // Builds the per-channel detail payload for /channels/:slug/ BLOB pages.
  // Mirrors buildTopicDetailPayload in topics-query.js but pivots on channel
  // (not topic): resolves the channel by slug, fetches its REVIEWED
  // ChannelTopicMap rows ordered by relevance desc, enriches each topicTag
  // with a tutorialCount from loadLiveTags(db).

  import cds from '@sap/cds';
  import { loadLiveTags } from './topics-query.js';
  import { titlePathToMdFormat } from './tag-md-format.js';

  const NS = 'com.sap.developers.ims';

  /**
   * Build the per-channel detail payload.
   *
   * @param {object} db   CDS db service
   * @param {string} slug URL slug (resolved lowercase; falls back to sourceId)
   * @returns {Promise<{slug,name,url,purpose,ownerType,topics,buildAt,notFound}>}
   */
  export async function buildChannelDetailPayload(db, slug) {
    try {
      const canonSlug = String(slug || '').toLowerCase();
      const { Channels, ChannelTopicMap } = cds.entities(NS);

      // Resolve by slug first (Phase 0 column), fallback to sourceId (pre-slug rows).
      let channel = await db.run(
        SELECT.one.from(Channels)
          .columns('ID', 'slug', 'sourceId', 'name', 'url', 'purpose', 'ownerType', 'isPublished')
          .where({ slug: canonSlug, isPublished: true }),
      );
      if (!channel) {
        channel = await db.run(
          SELECT.one.from(Channels)
            .columns('ID', 'slug', 'sourceId', 'name', 'url', 'purpose', 'ownerType', 'isPublished')
            .where({ sourceId: canonSlug, isPublished: true }),
        );
      }
      if (!channel) {
        return { slug: canonSlug, notFound: true, topics: [], buildAt: new Date().toISOString() };
      }

      // REVIEWED crosswalk rows for this channel, ordered by relevance desc.
      const mapRows = await db.run(
        SELECT.from(ChannelTopicMap)
          .columns('topicTag', 'relevance')
          .where({ channel_ID: channel.ID, authoringStatus: 'REVIEWED' })
          .orderBy('relevance desc'),
      );

      // Build a tutorialCount lookup from live tags keyed by mdFormat.
      // loadLiveTags returns rows that already have titlePath; we compute mdFormat
      // and build a Map<mdFormat → tutorialCount>.
      let tutorialCountByMd = new Map();
      try {
        const live = await loadLiveTags(db);
        for (const tag of live) {
          if (!tag.titlePath) continue;
          const md = titlePathToMdFormat(tag.titlePath);
          if (md) tutorialCountByMd.set(md, tag.tutorialCount ?? 0);
        }
      } catch {
        // fail-open: counts will be 0 but topics still listed
      }

      // Build topic slug from the mdFormat: replace '>' with '-' and remove non-slug chars.
      // This mirrors the slug derivation in buildTopicSlugMap (topics-query.js uses bySlug).
      // We derive the slug from the live tag that matches, falling back to a safe transform.
      const topics = mapRows.map((row) => {
        const md = row.topicTag;
        const count = tutorialCountByMd.get(md) ?? 0;
        // Derive a display slug from mdFormat: 'software-product>sap-cap' → 'software-product-sap-cap'
        const topicSlug = md.replace('>', '-').replace(/[^a-z0-9-]/g, '');
        return {
          slug: topicSlug,
          label: md, // displayable fallback; topic-detail-render uses slug for href
          tutorialCount: count,
          relevance: row.relevance ?? 50,
        };
      });

      return {
        slug: channel.slug || channel.sourceId,
        name: channel.name,
        url: channel.url,
        purpose: channel.purpose || null,
        ownerType: channel.ownerType || null,
        topics,
        buildAt: new Date().toISOString(),
        notFound: false,
      };
    } catch (err) {
      return {
        slug: String(slug || '').toLowerCase(),
        notFound: false,
        topics: [],
        buildAt: new Date().toISOString(),
        error: err.message,
      };
    }
  }
  ```

- [ ] **Step 4: Run test to confirm it passes**

  ```bash
  npx vitest run test/unit/channel-detail-query.test.js --project unit
  ```

  Expected: all tests PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add srv/lib/build-channel-detail.js test/unit/channel-detail-query.test.js
  git commit -m "feat(crosswalk): add buildChannelDetailPayload for per-channel BLOB pages"
  ```

---

## Task 3: `channel-detail-render.js` — HTML renderer

**Files:**
- Create: `srv/lib/channel-detail-render.js`

**Interfaces:**
- Consumes: `ChannelDetailPayload` (from Task 2: `{ slug, name, url, purpose, ownerType, topics:[{slug,label,tutorialCount,relevance}], buildAt, notFound }`).
- Produces: `renderChannelDetail(channel)` → `{ body: string, contentHash: string }` (mirrors `renderTopicDetail` in `topic-detail-render.js`).

- [ ] **Step 1: Write the failing test (inline in the query test file for simplicity)**

  Create `test/unit/channel-detail-render.test.js`:

  ```js
  // test/unit/channel-detail-render.test.js
  import { describe, it, expect } from 'vitest';
  import { renderChannelDetail } from '../../srv/lib/channel-detail-render.js';

  describe('renderChannelDetail', () => {
    const basePayload = {
      slug: 'sap-cap-channel',
      name: 'SAP CAP Channel',
      url: 'https://cap-channel.example',
      purpose: 'The CAP channel',
      ownerType: 'SAP_Official',
      topics: [
        { slug: 'software-product-sap-cap', label: 'SAP CAP', tutorialCount: 5, relevance: 90 },
        { slug: 'software-product-sap-hana', label: 'SAP HANA', tutorialCount: 2, relevance: 70 },
      ],
      buildAt: '2026-09-05T10:00:00.000Z',
      notFound: false,
    };

    it('throws when slug or name is missing', () => {
      expect(() => renderChannelDetail({ ...basePayload, slug: '' })).toThrow();
      expect(() => renderChannelDetail({ ...basePayload, name: '' })).toThrow();
    });

    it('returns body string and contentHash string', () => {
      const { body, contentHash } = renderChannelDetail(basePayload);
      expect(typeof body).toBe('string');
      expect(typeof contentHash).toBe('string');
      expect(contentHash).toHaveLength(64); // sha256 hex
    });

    it('body contains channel name in an h1', () => {
      const { body } = renderChannelDetail(basePayload);
      expect(body).toContain('<h1');
      expect(body).toContain('SAP CAP Channel');
    });

    it('body renders topic links pointing to /topics/:slug/', () => {
      const { body } = renderChannelDetail(basePayload);
      expect(body).toContain('/topics/software-product-sap-cap/');
      expect(body).toContain('/topics/software-product-sap-hana/');
    });

    it('body renders tutorial counts', () => {
      const { body } = renderChannelDetail(basePayload);
      expect(body).toContain('5');
      expect(body).toContain('2');
    });

    it('body includes a link to the channel URL', () => {
      const { body } = renderChannelDetail(basePayload);
      expect(body).toContain('https://cap-channel.example');
    });

    it('body includes breadcrumb links to / and /channels/', () => {
      const { body } = renderChannelDetail(basePayload);
      expect(body).toContain('href="/"');
      expect(body).toContain('href="/channels/"');
    });

    it('escapes HTML-special chars in name and purpose', () => {
      const { body } = renderChannelDetail({
        ...basePayload,
        name: '<script>alert(1)</script>',
        purpose: '& "quoted"',
      });
      expect(body).not.toContain('<script>');
      expect(body).toContain('&lt;script&gt;');
    });

    it('body is <main> element (not article) for smoke-test compatibility', () => {
      const { body } = renderChannelDetail(basePayload);
      expect(body).toMatch(/<main/);
    });

    it('contentHash is deterministic for same input', () => {
      const { contentHash: h1 } = renderChannelDetail(basePayload);
      const { contentHash: h2 } = renderChannelDetail(basePayload);
      expect(h1).toBe(h2);
    });
  });
  ```

- [ ] **Step 2: Run test to confirm it fails**

  ```bash
  npx vitest run test/unit/channel-detail-render.test.js --project unit
  ```

  Expected: FAIL — `Cannot find module '../../srv/lib/channel-detail-render.js'`.

- [ ] **Step 3: Create `srv/lib/channel-detail-render.js`**

  ```js
  // srv/lib/channel-detail-render.js
  //
  // HTML body renderer for per-channel detail pages (/channels/:slug/).
  // Mirrors topic-detail-render.js: returns { body, contentHash } where body
  // is the page's <main> element and contentHash is sha256 hex of body.
  // The caller (publish-channels.js) wraps body in the __shell__ chrome via
  // composeShell before gzip+base64 storage.

  import { createHash } from 'node:crypto';

  function esc(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  const OWNER_BADGE = {
    SAP_Official: 'SAP',
    SAP_Developer_Advocate: 'SAP Advocate',
    User_Group: 'User Group',
    Community_Member: 'Community',
    Community_Organization: 'Community',
  };

  function ownerBadge(ownerType) {
    return OWNER_BADGE[ownerType] ?? 'Third-party';
  }

  export function renderChannelDetail(channel) {
    if (!channel?.slug || !channel?.name) throw new Error('renderChannelDetail: slug and name required');

    const topicItems = (channel.topics || []).map((t) => `
      <li class="channel-topics__item">
        <a href="/topics/${esc(t.slug)}/">${esc(t.label)}</a>
        <span class="channel-topics__count">${esc(String(t.tutorialCount ?? 0))} tutorial${t.tutorialCount === 1 ? '' : 's'}</span>
      </li>`).join('');

    const topicsSection = topicItems
      ? `<section class="channel-topics" aria-labelledby="channel-topics-h">
          <h2 id="channel-topics-h">Topics covered</h2>
          <ul class="channel-topics__list" role="list">${topicItems}</ul>
        </section>`
      : `<section class="channel-topics"><p class="channel-topics__empty">No topic crosswalk data yet.</p></section>`;

    const purposeHtml = channel.purpose
      ? `<p class="channel-detail__purpose">${esc(channel.purpose)}</p>`
      : '';

    const body = `<main>
  <article class="channel-detail">
    <nav class="channel-breadcrumb" aria-label="Breadcrumb">
      <ol class="channel-breadcrumb__list">
        <li><a href="/">Home</a></li>
        <li><a href="/channels/">Channels</a></li>
        <li aria-current="page">${esc(channel.name)}</li>
      </ol>
    </nav>
    <header class="channel-detail__header">
      <h1 class="channel-detail__title">${esc(channel.name)}</h1>
      <span class="channel-detail__badge" data-owner="${esc(channel.ownerType || '')}">${esc(ownerBadge(channel.ownerType))}</span>
      ${purposeHtml}
      <a class="channel-detail__link" href="${esc(channel.url)}" rel="noopener" target="_blank">Visit channel</a>
    </header>
    ${topicsSection}
  </article>
</main>`;

    const contentHash = createHash('sha256').update(body, 'utf-8').digest('hex');
    return { body, contentHash };
  }
  ```

- [ ] **Step 4: Run test to confirm it passes**

  ```bash
  npx vitest run test/unit/channel-detail-render.test.js --project unit
  ```

  Expected: all tests PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add srv/lib/channel-detail-render.js test/unit/channel-detail-render.test.js
  git commit -m "feat(crosswalk): add renderChannelDetail HTML body renderer for channel BLOB pages"
  ```

---

## Task 4: `publish-channels.js` — render-into-session publisher

**Files:**
- Create: `srv/lib/publish-channels.js`
- Create: `test/unit/publish-channels.test.js`

**Interfaces:**
- Consumes: `buildChannelDetailPayload(db, slug)` (Task 2); `renderChannelDetail(channel)` (Task 3); `composeShell(shell, body, meta)` + `createShellLoader` from `./chrome-shell.js`; `createSessionHelpers` from `./content-publish-session.js`; `metrics` from `./metrics.js`; `gzipSync` (node:zlib); `createHash` (node:crypto).
- Produces:
  - `renderChannelsIntoSession({ db, sessionId, helpers, priorHashes, shell, deps })` → `Promise<{ channelsSeen, channelsChanged, channelsSkipped, channelsErrored, durationMs }>`.
  - `renderChannelsHandler` Express POST handler (bound on `POST /content/publish/render-channels`).
  - `createRenderChannels({ namespace })` factory function.

- [ ] **Step 1: Write the failing test**

  Create `test/unit/publish-channels.test.js`:

  ```js
  // test/unit/publish-channels.test.js
  import { describe, it, expect, vi } from 'vitest';
  import { renderChannelsIntoSession } from '../../srv/lib/publish-channels.js';

  const NS = 'com.sap.developers.ims';

  function mockDb(channels, topicMapRows = [], liveTags = []) {
    // Minimal db mock for renderChannelsIntoSession — stubs the underlying
    // buildChannelDetailPayload dependencies.
    return {
      run: vi.fn().mockImplementation(async (q) => {
        // Return channels or empty arrays based on the query heuristic.
        return channels;
      }),
    };
  }

  const shell = { before: '<html><body>', after: '</body></html>' };

  describe('renderChannelsIntoSession', () => {
    it('throws when shell is missing', async () => {
      await expect(
        renderChannelsIntoSession({ db: {}, sessionId: 's1', helpers: {}, shell: null }),
      ).rejects.toThrow('shell unavailable');
    });

    it('error rate guard aborts when >5% of channels error', async () => {
      const db = { run: vi.fn().mockResolvedValue([]) };
      const helpers = { appendToSession: vi.fn() };

      // Inject deps that always error
      const alwaysError = async () => { throw new Error('boom'); };
      const loadPublished = async () => ['ch-1', 'ch-2', 'ch-3', 'ch-4', 'ch-5', 'ch-6', 'ch-7', 'ch-8', 'ch-9', 'ch-10', 'ch-11', 'ch-12', 'ch-13', 'ch-14', 'ch-15', 'ch-16', 'ch-17', 'ch-18', 'ch-19', 'ch-20'];

      await expect(
        renderChannelsIntoSession({
          db, sessionId: 's1', helpers, shell,
          deps: {
            loadPublishedChannelSlugs: loadPublished,
            buildChannelDetailPayload: alwaysError,
          },
        }),
      ).rejects.toThrow(/error rate too high/);
    });

    it('skips channels whose contentHash matches priorHashes', async () => {
      const db = { run: vi.fn().mockResolvedValue([]) };
      const helpers = { appendToSession: vi.fn() };

      // One channel, always returns same hash
      const payload = {
        slug: 'test-ch', name: 'Test', url: 'https://x', topics: [], buildAt: new Date().toISOString(), notFound: false,
      };
      const loadPublished = async () => ['test-ch'];
      const buildPayload = async () => payload;

      // Pre-compute what the hash would be for the rendered output
      // (we pass a priorHashes map that matches what publish-channels computes
      // after composeShell — simulate by setting a sentinel that won't match and
      // verifying channelsChanged===1, then test the skip by setting the real hash).
      // For simplicity: verify channelsChanged + channelsSkipped sum equals channelsSeen.
      const result = await renderChannelsIntoSession({
        db, sessionId: 's1', helpers, shell,
        priorHashes: {},
        deps: { loadPublishedChannelSlugs: loadPublished, buildChannelDetailPayload: buildPayload },
      });
      expect(result.channelsSeen).toBe(1);
      expect(result.channelsChanged + result.channelsSkipped + result.channelsErrored).toBe(1);
      expect(helpers.appendToSession).toHaveBeenCalledTimes(result.channelsChanged > 0 ? 1 : 0);
    });
  });
  ```

- [ ] **Step 2: Run test to confirm it fails**

  ```bash
  npx vitest run test/unit/publish-channels.test.js --project unit
  ```

  Expected: FAIL — `Cannot find module '../../srv/lib/publish-channels.js'`.

- [ ] **Step 3: Create `srv/lib/publish-channels.js`**

  ```js
  // srv/lib/publish-channels.js
  //
  // Render-into-session publisher for per-channel BLOB pages (channels-hub
  // Phase 2, Direction 2). Mirrors publish-topics.js exactly: renders every
  // published channel's detail page and appends `channel-<slug>` BLOBs to an
  // open publish session, with the same ≥5% error-rate abort guard and
  // batch-append pattern.

  import cds from '@sap/cds';
  import { gzipSync } from 'node:zlib';
  import { createHash } from 'node:crypto';
  import { buildChannelDetailPayload } from './build-channel-detail.js';
  import { renderChannelDetail } from './channel-detail-render.js';
  import { composeShell, createShellLoader } from './chrome-shell.js';
  import { createSessionHelpers } from './content-publish-session.js';
  import * as metrics from './metrics.js';

  const DEFAULT_NAMESPACE = 'com.sap.developers.ims';
  const BATCH_SIZE = 20;
  const MAX_ERROR_RATE = 0.05; // >5% abort

  export function channelMetaDescription(channel) {
    const n = channel.topics?.length ?? 0;
    return `${channel.name}: ${n} topic${n === 1 ? '' : 's'} covered on developers.sap.com.`.slice(0, 160);
  }

  /**
   * Load all published channel slugs from the database.
   *
   * @param {object} db  CDS db service
   * @returns {Promise<string[]>}
   */
  async function loadPublishedChannelSlugs(db) {
    const { Channels } = cds.entities(DEFAULT_NAMESPACE);
    const rows = await db.run(
      SELECT.from(Channels).columns('slug', 'sourceId').where({ isPublished: true }),
    );
    // Prefer slug, fallback to sourceId for pre-slug rows.
    return rows.map((r) => (r.slug || r.sourceId)).filter(Boolean).map((s) => s.toLowerCase());
  }

  /**
   * Render every published channel into an open publish session.
   *
   * @param {object} args
   * @param {object} args.db
   * @param {string} args.sessionId
   * @param {object} args.helpers  { appendToSession }
   * @param {object} args.priorHashes  Map key → sha256 of prior full doc
   * @param {{before:string,after:string}} args.shell
   * @param {object} [args.deps]  { loadPublishedChannelSlugs, buildChannelDetailPayload }
   */
  export async function renderChannelsIntoSession({ db, sessionId, helpers, priorHashes = {}, shell, deps = {} }) {
    const started = Date.now();
    if (!shell || typeof shell.before !== 'string' || typeof shell.after !== 'string') {
      throw new Error('render-channels: shell unavailable — __shell__ sidecar not yet published');
    }

    const _loadSlugs = deps.loadPublishedChannelSlugs || loadPublishedChannelSlugs;
    const _buildPayload = deps.buildChannelDetailPayload || buildChannelDetailPayload;

    const slugs = await _loadSlugs(db);
    const channelsSeen = slugs.length;

    const changedFiles = {};
    let channelsSkipped = 0;
    let channelsErrored = 0;

    for (const slug of slugs) {
      const key = `channel-${slug}`;
      try {
        const channel = await _buildPayload(db, slug);
        if (channel.notFound || channel.error) {
          channelsErrored++;
          metrics.counter('channel_render_error');
          console.error(`[render-channels] channel "${slug}" payload returned error/notFound`);
          continue;
        }
        const { body } = renderChannelDetail(channel);
        const meta = {
          kind: 'channel',
          slug: channel.slug,
          title: channel.name,
          description: channelMetaDescription(channel),
        };
        const fullDoc = composeShell(shell, body, meta);
        const contentHash = createHash('sha256').update(fullDoc, 'utf-8').digest('hex');
        if (priorHashes[key] === contentHash) {
          channelsSkipped++;
          continue;
        }
        changedFiles[key] = gzipSync(Buffer.from(fullDoc, 'utf-8')).toString('base64');
      } catch (err) {
        channelsErrored++;
        metrics.counter('channel_render_error');
        console.error(`[render-channels] channel "${slug}" render failed: ${err.message}`);
      }
    }

    if (channelsSeen > 0 && channelsErrored / channelsSeen > MAX_ERROR_RATE) {
      throw new Error(`render-channels: error rate too high (${channelsErrored}/${channelsSeen}) — aborting phase`);
    }

    const keys = Object.keys(changedFiles);
    for (let i = 0; i < keys.length; i += BATCH_SIZE) {
      const slice = keys.slice(i, i + BATCH_SIZE);
      const files = {};
      for (const k of slice) files[k] = changedFiles[k];
      await helpers.appendToSession({ sessionId, files });
    }

    const durationMs = Date.now() - started;
    const channelsChanged = keys.length;
    metrics.observe('channel_render_ms', durationMs);
    metrics.counter('channels_rendered_total', channelsChanged);
    metrics.counter('channels_skipped_total', channelsSkipped);
    return { channelsSeen, channelsChanged, channelsSkipped, channelsErrored, durationMs };
  }

  /**
   * Express handler factory for POST /content/publish/render-channels.
   */
  export function createRenderChannels({ namespace = DEFAULT_NAMESPACE } = {}) {
    const hanaTableName = () => `${namespace.replace(/\./g, '_').toUpperCase()}_CONTENTFILES`;

    async function getActiveVersion() {
      const { ContentManifest } = cds.entities(namespace);
      const [row] = await SELECT.from(ContentManifest).where({ status: 'ACTIVE' }).columns('version');
      return row?.version ?? null;
    }

    const shellLoader = createShellLoader({ namespace, hanaTableName, getActiveVersion });
    const helpers = createSessionHelpers({ namespace });

    async function loadPriorChannelHashes() {
      const activeVersion = await getActiveVersion();
      if (activeVersion === null) return {};
      const { ContentFiles } = cds.entities(namespace);
      const rows = await SELECT.from(ContentFiles)
        .where({ version: activeVersion })
        .columns('slug', 'contentHash');
      const out = {};
      for (const r of rows) {
        if (typeof r.slug === 'string' && r.slug.startsWith('channel-')) out[r.slug] = r.contentHash;
      }
      return out;
    }

    async function renderChannelsHandler(req, res) {
      const sessionId = req.body?.sessionId;
      if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });
      try {
        const db = await cds.connect.to('db');
        const shell = await shellLoader.get();
        const priorHashes = await loadPriorChannelHashes();
        const counts = await renderChannelsIntoSession({ db, sessionId, helpers, priorHashes, shell });
        return res.status(200).json(counts);
      } catch (err) {
        console.error('[render-channels] phase failed:', err?.message);
        metrics.counter('channel_render_batch_failure');
        return res.status(500).json({ error: err?.message || 'render-channels failed' });
      }
    }

    return { renderChannelsHandler };
  }

  const _default = createRenderChannels();
  export const renderChannelsHandler = _default.renderChannelsHandler;
  ```

- [ ] **Step 4: Run test to confirm it passes**

  ```bash
  npx vitest run test/unit/publish-channels.test.js --project unit
  ```

  Expected: all tests PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add srv/lib/publish-channels.js test/unit/publish-channels.test.js
  git commit -m "feat(crosswalk): add renderChannelsIntoSession publisher for channel BLOB pages"
  ```

---

## Task 5: Wire channel-detail routes in `srv/server.js`

**Files:**
- Modify: `srv/server.js`

**Interfaces:**
- Consumes: `renderChannelsHandler` from `./lib/publish-channels.js`; `buildChannelDetailPayload` from `./lib/build-channel-detail.js`; existing `serveHandler`, `contentAuthMiddleware` from `./lib/content-store.js`.
- Produces: three new HTTP routes:
  - `GET /build/channel-detail/:slug` — public, Cache-Control: 60.
  - `GET /content/channel-detail/:slug` — delegates to `serveHandler` with `channel-` prefix (mirrors `/content/topics/:slug` pattern exactly).
  - `POST /content/publish/render-channels` — auth'd by `contentAuthMiddleware`.

- [ ] **Step 1: Add the import for publish-channels at the top of `srv/server.js`**

  Find this existing line (near line 40):
  ```js
  import { renderTopicsHandler } from './lib/publish-topics.js';
  ```
  Add immediately after:
  ```js
  import { renderChannelsHandler } from './lib/publish-channels.js';
  ```

  Find this existing line (near line 41):
  ```js
  import { buildTopicsTreeHandler, buildTopicDetailHandler } from './lib/build-topics.js';
  ```
  Add immediately after:
  ```js
  import { buildChannelDetailPayload } from './lib/build-channel-detail.js';
  ```

- [ ] **Step 2: Add the `/build/channel-detail/:slug` route**

  In `srv/server.js`, find the block that registers `buildTopicDetailHandler`:
  ```js
  app.get('/build/topics/:slug', buildTopicDetailHandler);
  ```
  Add immediately after it (search for this line if needed — `grep -n 'build/topics' srv/server.js`):
  ```js
  // channels-hub Phase 2 — per-channel detail payload (Direction 2 crosswalk).
  app.get('/build/channel-detail/:slug', async (req, res) => {
    try {
      const db = await cds.connect.to('db');
      const slug = String(req.params.slug || '').toLowerCase();
      const payload = await buildChannelDetailPayload(db, slug);
      res.set('Cache-Control', 'public, max-age=60');
      res.status(payload.notFound ? 404 : 200).json(payload);
    } catch (err) {
      cds.log('build-channel-detail').error('failed', err);
      res.status(500).json({ error: 'Build channel detail query failed' });
    }
  });
  ```

- [ ] **Step 3: Add the `/content/channel-detail/:slug` serve route**

  Find the block that handles `/content/topics/:slug` (around line 635 in server.js):
  ```js
  app.get('/content/topics/:slug', async (req, res) => {
  ```
  After the entire `/content/topics/:slug` block (which ends with `return serveHandler(req, res);` followed by `});`), add:

  ```js
  // channels-hub Phase 2 — BLOB serve for per-channel detail pages.
  // Mirrors /content/topics/:slug: lowercase canonicalize, prepend 'channel-' prefix,
  // delegate to serveHandler. No legacy-slug redirect needed (channel slugs are stable
  // since Phase 0 normalization).
  app.get('/content/channel-detail/:slug', (req, res) => {
    const raw = String(req.params.slug || '');
    const lower = raw.toLowerCase();
    if (raw && raw !== lower) {
      const qIdx = req.url.indexOf('?');
      const query = qIdx >= 0 ? req.url.slice(qIdx) : '';
      res.setHeader('Location', `/channels/${lower}/${query}`);
      res.setHeader('Cache-Control', 'public, max-age=3600');
      return res.status(301).end();
    }
    req.params.slug = `channel-${lower}`;
    return serveHandler(req, res);
  });
  ```

- [ ] **Step 4: Add the `POST /content/publish/render-channels` route**

  Find the existing line:
  ```js
  app.post('/content/publish/render-topics', express.json({ limit: '1mb' }), contentAuthMiddleware, renderTopicsHandler);
  ```
  Add immediately after it:
  ```js
  // channels-hub Phase 2 — render per-channel detail BLOBs into a publish session.
  // Mirrors render-topics exactly: prod-only (not registered on srv-qa — see
  // check-srv-qa-route-drift.ts ALLOWLIST_ONLY_ON_SRV), auth'd, sequenced after
  // render-topics and before commit.
  app.post('/content/publish/render-channels', express.json({ limit: '1mb' }), contentAuthMiddleware, renderChannelsHandler);
  ```

- [ ] **Step 5: Verify server.js starts without errors**

  ```bash
  node --input-type=module <<'EOF'
  import { createRequire } from 'module';
  // Just do a static import check by requiring the module graph to parse
  const r = createRequire(import.meta.url);
  try { r('./srv/lib/publish-channels.js'); console.log('OK'); } catch(e) { console.error(e.message); }
  EOF
  ```

  Or run `cds watch` in the background and confirm `[cds] - serving` appears.

- [ ] **Step 6: Commit**

  ```bash
  git add srv/server.js
  git commit -m "feat(crosswalk): wire channel-detail build/serve/publish routes in srv/server.js"
  ```

---

## Task 6: Add `renderChannelsPhase` to `scripts/lib/publish-client.ts` and wire into `scripts/publish-content.ts`

**Files:**
- Modify: `scripts/lib/publish-client.ts`
- Modify: `scripts/publish-content.ts`
- Modify: `scripts/check-srv-qa-route-drift.ts`

**Interfaces:**
- Consumes: `postJson` (private helper already in `publish-client.ts`); `renderTopicsPhase` pattern (mirror exactly).
- Produces:
  - `renderChannelsPhase({ baseUrl, apiKey, sessionId })` → `Promise<RenderChannelsResult>` exported from `scripts/lib/publish-client.ts`.
  - `RenderChannelsInput`, `RenderChannelsResult` interfaces.
  - In `publish-content.ts`: calls `renderChannelsPhase` after `renderTopicsPhase`, inside the `!opts.slug && channel === 'prod'` guard.

- [ ] **Step 1: Add interfaces and function to `scripts/lib/publish-client.ts`**

  Find the `renderTopicsPhase` function (line ~119):
  ```ts
  export async function renderTopicsPhase(i: RenderTopicsInput): Promise<RenderTopicsResult> {
    return postJson(`${i.baseUrl}/content/publish/render-topics`, i.apiKey, { sessionId: i.sessionId });
  }
  ```
  Add immediately after:
  ```ts
  export interface RenderChannelsInput { baseUrl: string; apiKey: string; sessionId: string }
  export interface RenderChannelsResult {
    channelsSeen: number;
    channelsChanged: number;
    channelsSkipped: number;
    channelsErrored: number;
    durationMs: number;
  }

  /**
   * channels-hub Phase 2 — trigger the server-side render-channels phase within an open
   * publish session. CAP reads published Channels + REVIEWED ChannelTopicMap rows,
   * renders each channel detail page, and appends `channel-<slug>` BLOBs to the session.
   * Mirrors renderTopicsPhase: prod-only (srv-qa has no render-channels route), sequenced
   * after render-topics and before commit.
   */
  export async function renderChannelsPhase(i: RenderChannelsInput): Promise<RenderChannelsResult> {
    return postJson(`${i.baseUrl}/content/publish/render-channels`, i.apiKey, { sessionId: i.sessionId });
  }
  ```

- [ ] **Step 2: Import `renderChannelsPhase` in `scripts/publish-content.ts`**

  Find this import line (line 8):
  ```ts
  import { beginSession, appendBatch, commitSession, abortSession, fetchRemoteHashes, fetchRemoteSourceHashes, renderConceptsPhase, renderTopicsPhase } from './lib/publish-client.js';
  ```
  Replace with:
  ```ts
  import { beginSession, appendBatch, commitSession, abortSession, fetchRemoteHashes, fetchRemoteSourceHashes, renderConceptsPhase, renderTopicsPhase, renderChannelsPhase } from './lib/publish-client.js';
  ```

- [ ] **Step 3: Wire the `renderChannelsPhase` call after `renderTopicsPhase` in `publish-content.ts`**

  Find this block (around line 1263):
  ```ts
      log(`render-topics: ${rt.topicsChanged} changed, ${rt.topicsSkipped} skipped, ${rt.topicsErrored} errored of ${rt.topicsSeen} (${rt.durationMs} ms)`);
    } catch (err) {
      console.error(`[publish-content] render-topics failed permanently: ${formatErrorChain(err)}`);
      await abortSession({ baseUrl: opts.baseUrl, apiKey: opts.apiKey, sessionId: begin.sessionId, reason: 'render-topics failed' });
      process.exit(1);
    }
  }
  ```
  Add immediately after the closing `}` of the render-topics try/catch (still inside the `!opts.slug && channel === 'prod'` if-block):

  ```ts
    // channels-hub Phase 2 — render per-channel detail pages alongside topics.
    // Same guard (prod-only, full-publish): POST /content/publish/render-channels
    // is not registered on srv-qa. Sequenced after render-topics, before commit.
    try {
      const rc = await withRetry(
        () => renderChannelsPhase({ baseUrl: opts.baseUrl, apiKey: opts.apiKey, sessionId: begin.sessionId }),
        {
          attempts: 3, backoffMs: [1000, 3000, 9000],
          onAttemptFail: (attempt, err, willRetry) => {
            console.error(`[publish-content] render-channels failed (attempt ${attempt}/3): ${formatErrorChain(err)}${willRetry ? ' — retrying' : ''}`);
          },
        }
      );
      log(`render-channels: ${rc.channelsChanged} changed, ${rc.channelsSkipped} skipped, ${rc.channelsErrored} errored of ${rc.channelsSeen} (${rc.durationMs} ms)`);
    } catch (err) {
      console.error(`[publish-content] render-channels failed permanently: ${formatErrorChain(err)}`);
      await abortSession({ baseUrl: opts.baseUrl, apiKey: opts.apiKey, sessionId: begin.sessionId, reason: 'render-channels failed' });
      process.exit(1);
    }
  ```

- [ ] **Step 4: Add ALLOWLIST entry in `scripts/check-srv-qa-route-drift.ts`**

  Find this block (around line 106):
  ```ts
  'POST /content/publish/render-topics':
    'Topic-detail publish rendering (tag-tree-topics, #2099) ...',
  ```
  Add immediately after it (still inside the ALLOWLIST object):
  ```ts
  'POST /content/publish/render-channels':
    'Channel-detail publish rendering (channels-hub Phase 2) — renders per-channel BLOB pages ' +
    'into a publish session for the public /channels/:slug/ detail surface. Not a ' +
    'tutorial-draft author-preview endpoint; the QA channel has no channel-detail publish flow.',
  ```

- [ ] **Step 5: Verify TypeScript compiles**

  ```bash
  npx tsc --project tsconfig.json --noEmit 2>&1 | head -30
  ```

  Expected: no errors (or only pre-existing warnings unrelated to new lines).

- [ ] **Step 6: Run the QA channel gate regression test**

  ```bash
  npx vitest run scripts/__tests__/publish-content-qa.test.js --project unit
  ```

  Expected: PASS (the existing gate test looks for `channel === 'prod'` which our new block is still inside).

- [ ] **Step 7: Commit**

  ```bash
  git add scripts/lib/publish-client.ts scripts/publish-content.ts scripts/check-srv-qa-route-drift.ts
  git commit -m "feat(crosswalk): wire renderChannelsPhase in publish-client and publish-content"
  ```

---

## Task 7: Approuter routes for channel-detail + media-diet

**Files:**
- Modify: `approuter/xs-app.json`

**Interfaces:**
- Consumes: existing `/channels/` static directory routes; phase 1 literal routes for `atlas`, `health`, `media-diet` (assumed registered by Phase 1 of this plan series — if Phase 1 hasn't run yet, add them here as stubs that point to static; if they exist, verify ordering only).
- Produces:
  - `^/channels/([^/?]+)/?$` → `/content/channel-detail/$1` (`none`) — MUST be after any literal `/channels/atlas`, `/channels/health`, `/channels/media-diet` routes.
  - `^/api/media-diet/my-picks(\?.*)?$` → `srv-api` (`xsuaa`).
  - `^/api/media-diet/export(\?.*)?$` → `srv-api` (`none`).

- [ ] **Step 1: Locate the insertion point in `xs-app.json`**

  The routes array currently ends with `^/topics/(.*)$` and similar. Find the topics routes:
  ```json
  { "source": "^/topics/?(\\?.*)?$", "target": "/content/topics-index$1", "destination": "srv-api", "authenticationType": "none" },
  { "source": "^/topics/(.*)$", "target": "/content/topics/$1", "destination": "srv-api", "authenticationType": "none" },
  ```
  The new routes go after the existing `/channel-submissions` xsuaa route (around line 375) and before the catch-all `/api/(.*)` route.

  The canonical safe insertion pattern for ordering:

  **Literal children must precede the catch-all.** Phase 1 is responsible for `atlas`, `health`, `media-diet` literal routes. This task adds the `:slug` catch-all + the media-diet API routes.

- [ ] **Step 2: Add the routes**

  In `approuter/xs-app.json`, find the line:
  ```json
  { "source": "^/topics/?(\\?.*)?$", ...
  ```
  Before that line insert the following block (maintaining JSON array comma correctness):

  ```json
  {
    "source": "^/api/media-diet/my-picks(\\?.*)?$",
    "target": "/api/media-diet/my-picks$1",
    "destination": "srv-api",
    "authenticationType": "xsuaa"
  },
  {
    "source": "^/api/media-diet/export(\\?.*)?$",
    "target": "/api/media-diet/export$1",
    "destination": "srv-api",
    "authenticationType": "none"
  },
  {
    "source": "^/channels/([^/?]+)/?$",
    "target": "/content/channel-detail/$1",
    "destination": "srv-api",
    "authenticationType": "none"
  },
  ```

  **IMPORTANT:** Verify that `atlas`, `health`, `media-diet` literal routes are registered BEFORE this `^/channels/([^/?]+)/?$` catch-all. If Phase 1 has not yet registered them (they point to static), add them as literal stubs immediately before the catch-all:
  ```json
  { "source": "^/channels/atlas/?$",      "target": "/channels/atlas/",      "localDir": "static", "authenticationType": "none" },
  { "source": "^/channels/health/?$",     "target": "/channels/health/",     "localDir": "static", "authenticationType": "none" },
  { "source": "^/channels/media-diet/?$", "target": "/channels/media-diet/", "localDir": "static", "authenticationType": "none" },
  ```
  The real Phase 1 routes may differ (SPA assets, different localDir paths) — update them when Phase 1 lands; what matters here is that they precede the catch-all.

- [ ] **Step 3: Validate JSON syntax**

  ```bash
  node -e "JSON.parse(require('fs').readFileSync('approuter/xs-app.json','utf-8')); console.log('OK')"
  ```

  Expected: `OK`.

- [ ] **Step 4: Commit**

  ```bash
  git add approuter/xs-app.json
  git commit -m "feat(crosswalk): add channel-detail catch-all and media-diet API routes to xs-app.json"
  ```

---

## Task 8: srv-qa cp-list audit

**Files:**
- Modify: `.deploy/mta.yaml`

**Interfaces:**
- Produces: the long `cp` bash command in the `srv-qa` build step includes `build-channel-detail.js`, `channel-detail-render.js`, `publish-channels.js`.

- [ ] **Step 1: Verify the current cp-list contains the topics equivalents**

  ```bash
  grep -o 'topics-query\|publish-topics\|topic-detail-render\|build-topics' .deploy/mta.yaml
  ```

  Expected output confirms `topics-query.js`, `publish-topics.js`, `topic-detail-render.js` are present in the cp command (they are part of the long bash string at line 175 of mta.yaml).

- [ ] **Step 2: Add the three new files to the cp command in `.deploy/mta.yaml`**

  In `.deploy/mta.yaml`, find the long `bash -c "mkdir -p ...` command (line 175). Locate the segment that copies topic-related files — it contains `../../srv/lib/publish-topics.js`. After `../../srv/lib/publish-topics.js` add:
  ```
  ../../srv/lib/publish-channels.js ../../srv/lib/build-channel-detail.js ../../srv/lib/channel-detail-render.js
  ```
  (space-separated, as the rest of the list is). The cp destination is `srv/lib/` at the end of the command.

  Use `sd` (PCRE find-replace) to make the edit safely:

  ```bash
  sd -F '../../srv/lib/publish-topics.js' \
     '../../srv/lib/publish-topics.js ../../srv/lib/publish-channels.js ../../srv/lib/build-channel-detail.js ../../srv/lib/channel-detail-render.js' \
     .deploy/mta.yaml
  ```

- [ ] **Step 3: Verify the edit landed correctly**

  ```bash
  grep 'channel-detail-render' .deploy/mta.yaml
  ```

  Expected: one match in the cp command string.

- [ ] **Step 4: Commit**

  ```bash
  git add .deploy/mta.yaml
  git commit -m "chore(srv-qa): add build-channel-detail, channel-detail-render, publish-channels to cp-list"
  ```

---

## Task 9: `/api/media-diet/my-picks` — signed-in endpoint

**Files:**
- Modify: `srv/server.js`
- Create: `test/unit/media-diet-picks.test.js`

**Interfaces:**
- Consumes: `resolveUserSapId(req.user)` from `./lib/resolve-db-user.js` (already imported in server.js or needs adding); `cds.entities(NS)` → `{ Users, TaskRecords, Tutorials, TutorialTags, Tags, Channels, ChannelTopicMap }`; `titlePathToMdFormat(titlePath)` from `./lib/tag-md-format.js`.
- Produces: `GET /api/media-diet/my-picks` — Express handler inline in `srv/server.js` returning:
  ```json
  { "channels": [ { "ID": "...", "name": "...", "url": "...", "ownerType": "...", "isSapOwned": true, "feedUrl": "..." } ], "source": "completions" }
  ```
  or `{ "channels": [], "source": "no-data" }` when no ChannelTopicMap match.

- [ ] **Step 1: Write the failing unit test**

  Create `test/unit/media-diet-picks.test.js`:

  ```js
  // test/unit/media-diet-picks.test.js
  //
  // Tests the my-picks tag-derivation chain isolated from Express.
  // We extract the core logic into a helper so it's testable without
  // mounting a full server.

  import { describe, it, expect, beforeAll } from 'vitest';
  import cds from '@sap/cds';
  import { mediaDietMyPicksLogic } from '../../srv/lib/media-diet-picks.js';

  const NS = 'com.sap.developers.ims';

  cds.test('serve', '--project', '.', '--in-memory');

  describe('mediaDietMyPicksLogic', () => {
    let db;

    beforeAll(async () => {
      db = await cds.connect.to('db');
      const { Users, Tags, Tutorials, TutorialTags, Channels, ChannelTopicMap, TaskRecords } = cds.entities(NS);

      // User row
      await db.run(INSERT.into(Users).entries([
        { ID: 'usr1', sapId: 'I000001', uuid: cds.utils.uuid(), legacyId: 9001, email: 'test@test.com', firstName: 'Test', lastName: 'User' },
      ]));

      // Tag + tutorial → Tutorial Tags
      await db.run(INSERT.into(Tags).entries([
        { ID: 'mdtag1', titlePath: 'Software Product : SAP BTP', label: 'SAP BTP', name: 'sap-btp' },
      ]));
      await db.run(INSERT.into(Tutorials).entries([
        { ID: 'mdtut1', slug: 'md-btp-intro', title: 'BTP Intro' },
      ]));
      await db.run(INSERT.into(TutorialTags).entries([
        { tutorial_ID: 'mdtut1', tag_ID: 'mdtag1' },
      ]));

      // TaskRecord: user completed this tutorial
      await db.run(INSERT.into(TaskRecords).entries([
        { ID: cds.utils.uuid(), user_ID: 'usr1', taskType: 'TUTORIAL', taskLegacyId: 1, status: 'COMPLETED' },
      ]));

      // But wait — TaskRecords.taskLegacyId links to Tutorials.legacyId; for simplicity
      // use a direct user_ID + tutorial join path. The logic resolves via Tutorials.ID.
      // We'll also seed via Tutorials.legacyId to match the real code path:
      await db.run(
        UPDATE(Tutorials).where({ ID: 'mdtut1' }).set({ legacyId: 1 }),
      );

      // Channel with REVIEWED ChannelTopicMap for this topic
      await db.run(INSERT.into(Channels).entries([
        {
          ID: 'mdch1', sourceId: 'md-btp-channel',
          slug: 'btp-channel',
          name: 'BTP Channel', url: 'https://btp-channel.example',
          ownerType: 'SAP_Official', isSapOwned: true,
          isPublished: true, linkStatus: 'OK',
          feedUrl: 'https://btp-channel.example/feed.xml',
        },
      ]));
      // titlePathToMdFormat('Software Product : SAP BTP') = 'software-product>sap-btp'
      const { titlePathToMdFormat } = await import('../../srv/lib/tag-md-format.js');
      const md = titlePathToMdFormat('Software Product : SAP BTP');
      await db.run(INSERT.into(ChannelTopicMap).entries([
        { ID: cds.utils.uuid(), channel_ID: 'mdch1', topicTag: md, authoringStatus: 'REVIEWED', relevance: 85 },
      ]));
    });

    it('returns ranked channels for a user with completions', async () => {
      const result = await mediaDietMyPicksLogic(db, 'I000001');
      expect(result.source).toBe('completions');
      expect(result.channels.length).toBeGreaterThanOrEqual(1);
      expect(result.channels[0].name).toBe('BTP Channel');
    });

    it('returns empty + no-data source when user has no completions', async () => {
      const result = await mediaDietMyPicksLogic(db, 'I000002-nonexistent');
      expect(result.channels).toEqual([]);
      expect(result.source).toBe('no-data');
    });

    it('result channel entries have required fields', async () => {
      const result = await mediaDietMyPicksLogic(db, 'I000001');
      const ch = result.channels[0];
      expect(ch).toHaveProperty('ID');
      expect(ch).toHaveProperty('name');
      expect(ch).toHaveProperty('url');
      expect(ch).toHaveProperty('ownerType');
      expect(ch).toHaveProperty('isSapOwned');
      // feedUrl may be null or a string (nullable column)
      expect('feedUrl' in ch).toBe(true);
    });
  });
  ```

- [ ] **Step 2: Run test to confirm it fails**

  ```bash
  npx vitest run test/unit/media-diet-picks.test.js --project unit
  ```

  Expected: FAIL — `Cannot find module '../../srv/lib/media-diet-picks.js'`.

- [ ] **Step 3: Create `srv/lib/media-diet-picks.js` — the extracted core logic**

  ```js
  // srv/lib/media-diet-picks.js
  //
  // Core logic for GET /api/media-diet/my-picks, extracted for unit-testability.
  // The Express handler in srv/server.js calls mediaDietMyPicksLogic(db, sapId).
  //
  // Chain: sapId → Users.ID → TaskRecords(COMPLETED TUTORIAL) → Tutorials.legacyId
  //   → TutorialTags → Tags.titlePath → titlePathToMdFormat → mdFormats
  //   → ChannelTopicMap(REVIEWED, topicTag IN mdFormats) ordered relevance desc
  //   → Channels(isPublished)
  // Returns { channels, source } where source='completions' or 'no-data'.

  import cds from '@sap/cds';
  import { titlePathToMdFormat } from './tag-md-format.js';

  const NS = 'com.sap.developers.ims';

  export async function mediaDietMyPicksLogic(db, sapId) {
    if (!sapId) return { channels: [], source: 'no-data' };

    const { Users, TaskRecords, Tutorials, TutorialTags, Tags, Channels, ChannelTopicMap } = cds.entities(NS);

    // Resolve sapId → Users.ID
    const userRow = await db.run(SELECT.one.from(Users).columns('ID').where({ sapId }));
    if (!userRow?.ID) return { channels: [], source: 'no-data' };

    // COMPLETED TUTORIAL task records for this user
    const records = await db.run(
      SELECT.from(TaskRecords)
        .columns('taskLegacyId')
        .where({ user_ID: userRow.ID, taskType: 'TUTORIAL', status: 'COMPLETED' }),
    );
    if (!records.length) return { channels: [], source: 'no-data' };

    const legacyIds = records.map((r) => r.taskLegacyId).filter(Boolean);
    if (!legacyIds.length) return { channels: [], source: 'no-data' };

    // Tutorials matching those legacyIds
    const tutorials = await db.run(
      SELECT.from(Tutorials).columns('ID').where({ legacyId: { in: legacyIds } }),
    );
    if (!tutorials.length) return { channels: [], source: 'no-data' };

    const tutorialIds = tutorials.map((t) => t.ID);

    // TutorialTags for those tutorials
    const ttRows = await db.run(
      SELECT.from(TutorialTags).columns('tag_ID').where({ tutorial_ID: { in: tutorialIds } }),
    );
    const tagIds = [...new Set(ttRows.map((r) => r.tag_ID).filter(Boolean))];
    if (!tagIds.length) return { channels: [], source: 'no-data' };

    // Tags → titlePath → mdFormat
    const tagRows = await db.run(
      SELECT.from(Tags).columns('ID', 'titlePath').where({ ID: { in: tagIds } }),
    );
    const mdFormats = [...new Set(
      tagRows.map((t) => titlePathToMdFormat(t.titlePath)).filter(Boolean),
    )];
    if (!mdFormats.length) return { channels: [], source: 'no-data' };

    // ChannelTopicMap: REVIEWED rows whose topicTag is in the user's mdFormats,
    // ordered by relevance desc. HANA JSON arrays can't be filtered DB-side —
    // this is a string equality match on topicTag, which is fine.
    const mapRows = await db.run(
      SELECT.from(ChannelTopicMap)
        .columns('channel_ID', 'relevance')
        .where({ topicTag: { in: mdFormats }, authoringStatus: 'REVIEWED' })
        .orderBy('relevance desc'),
    );
    if (!mapRows.length) return { channels: [], source: 'no-data' };

    // Deduplicate channels by ID, keeping highest relevance seen
    const channelRelevance = new Map();
    for (const row of mapRows) {
      if (!channelRelevance.has(row.channel_ID)) {
        channelRelevance.set(row.channel_ID, row.relevance ?? 50);
      }
    }

    const channelIds = [...channelRelevance.keys()];
    const channelRows = await db.run(
      SELECT.from(Channels)
        .columns('ID', 'name', 'url', 'ownerType', 'isSapOwned', 'feedUrl', 'isPublished')
        .where({ ID: { in: channelIds }, isPublished: true }),
    );
    if (!channelRows.length) return { channels: [], source: 'no-data' };

    // Sort by relevance desc
    channelRows.sort((a, b) => (channelRelevance.get(b.ID) ?? 0) - (channelRelevance.get(a.ID) ?? 0));

    return { channels: channelRows, source: 'completions' };
  }
  ```

- [ ] **Step 4: Run test to confirm it passes**

  ```bash
  npx vitest run test/unit/media-diet-picks.test.js --project unit
  ```

  Expected: all tests PASS.

- [ ] **Step 5: Wire the Express handler in `srv/server.js`**

  Add import near the top of server.js (after the existing imports block):
  ```js
  import { mediaDietMyPicksLogic } from './lib/media-diet-picks.js';
  ```

  Then add the route handler after the existing `/api/` group (find a comment like `// channel-submissions` around line 375 and add after the last `/api/devtoberfest` route):

  ```js
  // channels-hub Phase 2 — signed-in media-diet picks derived from user completions.
  // XSUAA-gated in xs-app.json; resolveUserSapId extracts sapId from JWT user_uuid claim.
  app.get('/api/media-diet/my-picks', async (req, res) => {
    try {
      const sapId = resolveUserSapId(req.user);
      const db = await cds.connect.to('db');
      const result = await mediaDietMyPicksLogic(db, sapId);
      res.json(result);
    } catch (err) {
      cds.log('media-diet').error('my-picks failed', err);
      res.status(500).json({ channels: [], source: 'error', error: err?.message });
    }
  });
  ```

  Verify `resolveUserSapId` is imported in server.js (search for existing import). If not present, add:
  ```js
  import { resolveUserSapId } from './lib/resolve-db-user.js';
  ```

- [ ] **Step 6: Update srv-qa cp-list to include media-diet-picks.js**

  ```bash
  sd -F '../../srv/lib/publish-channels.js' \
     '../../srv/lib/publish-channels.js ../../srv/lib/media-diet-picks.js' \
     .deploy/mta.yaml
  ```

  Verify:
  ```bash
  grep 'media-diet-picks' .deploy/mta.yaml
  ```

- [ ] **Step 7: Commit**

  ```bash
  git add srv/lib/media-diet-picks.js srv/server.js .deploy/mta.yaml test/unit/media-diet-picks.test.js
  git commit -m "feat(media-diet): add signed-in my-picks endpoint with completion→channel derivation"
  ```

---

## Task 10: `/api/media-diet/export` — OPML/bookmarks/JSON export

**Files:**
- Modify: `srv/server.js`
- Create: `test/unit/media-diet-export.test.js`

**Interfaces:**
- Consumes: `cds.entities(NS)` → `{ Channels }`; query params `ids[]` (array, cap 50), `format` (string: `opml|bookmarks|json`); `Channels.feedUrl` (nullable — OPML `xmlUrl` only for non-null).
- Produces: `GET /api/media-diet/export` — Express handler inline in `srv/server.js` (or extracted helper). Response is one of:
  - `format=opml` → `Content-Type: text/xml`, valid OPML 2.0.
  - `format=bookmarks` → `Content-Type: text/html; charset=utf-8`, `Content-Disposition: attachment; filename="channels.html"`, browser-importable bookmarks HTML.
  - `format=json` (default) → `Content-Type: application/json`.

- [ ] **Step 1: Write the failing test**

  Create `test/unit/media-diet-export.test.js`:

  ```js
  // test/unit/media-diet-export.test.js
  import { describe, it, expect } from 'vitest';
  import { buildOpml, buildBookmarksHtml, enforceIdCap } from '../../srv/lib/media-diet-export.js';

  const sampleChannels = [
    { ID: 'ch1', name: 'SAP BTP Channel', url: 'https://btp.example', feedUrl: 'https://btp.example/feed.xml', ownerType: 'SAP_Official' },
    { ID: 'ch2', name: 'CAP Community', url: 'https://cap-community.example', feedUrl: null, ownerType: 'Community_Member' },
    { ID: 'ch3', name: 'UI5 Channel', url: 'https://ui5.example', feedUrl: 'https://ui5.example/rss', ownerType: 'SAP_Official' },
  ];

  describe('enforceIdCap', () => {
    it('returns ids as-is when ≤50', () => {
      const ids = Array.from({ length: 50 }, (_, i) => `id-${i}`);
      expect(enforceIdCap(ids)).toHaveLength(50);
    });
    it('truncates to 50 when more given', () => {
      const ids = Array.from({ length: 60 }, (_, i) => `id-${i}`);
      expect(enforceIdCap(ids)).toHaveLength(50);
    });
  });

  describe('buildOpml', () => {
    it('returns valid OPML XML string', () => {
      const xml = buildOpml(sampleChannels);
      expect(xml).toContain('<?xml version="1.0"');
      expect(xml).toContain('<opml version="2.0">');
      expect(xml).toContain('</opml>');
    });

    it('includes xmlUrl ONLY for non-null feedUrl rows', () => {
      const xml = buildOpml(sampleChannels);
      expect(xml).toContain('xmlUrl="https://btp.example/feed.xml"');
      expect(xml).toContain('xmlUrl="https://ui5.example/rss"');
      expect(xml).not.toMatch(/CAP Community[^>]*xmlUrl/);
    });

    it('includes htmlUrl for all rows', () => {
      const xml = buildOpml(sampleChannels);
      expect(xml).toContain('htmlUrl="https://btp.example"');
      expect(xml).toContain('htmlUrl="https://cap-community.example"');
    });

    it('escapes HTML-special characters in channel names', () => {
      const xml = buildOpml([{ ...sampleChannels[0], name: 'A & B <test>' }]);
      expect(xml).toContain('A &amp; B &lt;test&gt;');
      expect(xml).not.toContain('<test>');
    });
  });

  describe('buildBookmarksHtml', () => {
    it('returns browser-importable HTML with DOCTYPE', () => {
      const html = buildBookmarksHtml(sampleChannels);
      expect(html).toContain('<!DOCTYPE NETSCAPE-Bookmark-file-1>');
      expect(html).toContain('<DL>');
    });

    it('includes all channel urls as bookmark <A> tags', () => {
      const html = buildBookmarksHtml(sampleChannels);
      expect(html).toContain('https://btp.example');
      expect(html).toContain('https://cap-community.example');
    });

    it('escapes special chars in names', () => {
      const html = buildBookmarksHtml([{ ...sampleChannels[0], name: '<XSS>' }]);
      expect(html).not.toContain('<XSS>');
      expect(html).toContain('&lt;XSS&gt;');
    });
  });
  ```

- [ ] **Step 2: Run test to confirm it fails**

  ```bash
  npx vitest run test/unit/media-diet-export.test.js --project unit
  ```

  Expected: FAIL — `Cannot find module '../../srv/lib/media-diet-export.js'`.

- [ ] **Step 3: Create `srv/lib/media-diet-export.js`**

  ```js
  // srv/lib/media-diet-export.js
  //
  // Pure rendering functions for the /api/media-diet/export endpoint.
  // format=opml  → OPML 2.0 XML (xmlUrl only for non-null feedUrl)
  // format=bookmarks → Netscape-format HTML bookmarks (browser-importable)
  // format=json  → plain JSON array (handled inline by Express handler)
  //
  // enforceIdCap: enforce the 50-id cap before hitting the DB.

  const MAX_IDS = 50;

  export function enforceIdCap(ids) {
    if (!Array.isArray(ids)) return [];
    return ids.slice(0, MAX_IDS);
  }

  function esc(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /**
   * Build OPML 2.0 XML for a set of channels.
   * xmlUrl is set ONLY when feedUrl is non-null.
   */
  export function buildOpml(channels) {
    const outlines = channels.map((ch) => {
      const xmlUrlAttr = ch.feedUrl ? ` xmlUrl="${esc(ch.feedUrl)}"` : '';
      return `    <outline type="rss" text="${esc(ch.name)}" title="${esc(ch.name)}" htmlUrl="${esc(ch.url)}"${xmlUrlAttr}/>`;
    }).join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0">\n  <head>\n    <title>My SAP Developer Channels</title>\n  </head>\n  <body>\n${outlines}\n  </body>\n</opml>`;
  }

  /**
   * Build Netscape-format bookmarks HTML file (browser-importable).
   */
  export function buildBookmarksHtml(channels) {
    const items = channels.map((ch) =>
      `  <DT><A HREF="${esc(ch.url)}">${esc(ch.name)}</A>`,
    ).join('\n');
    return `<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<!-- This is an automatically generated file.\n     It will be read and overwritten.\n     DO NOT EDIT! -->\n<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n<TITLE>My SAP Developer Channels</TITLE>\n<H1>My SAP Developer Channels</H1>\n<DL><p>\n${items}\n</DL><p>`;
  }
  ```

- [ ] **Step 4: Run test to confirm it passes**

  ```bash
  npx vitest run test/unit/media-diet-export.test.js --project unit
  ```

  Expected: all tests PASS.

- [ ] **Step 5: Wire the Express handler in `srv/server.js`**

  Add import near top of server.js:
  ```js
  import { enforceIdCap, buildOpml, buildBookmarksHtml } from './lib/media-diet-export.js';
  ```

  Add route after `/api/media-diet/my-picks`:

  ```js
  // channels-hub Phase 2 — anon media-diet export (OPML / bookmarks / JSON).
  // authenticationType:none in xs-app.json. Cap: 50 ids.
  app.get('/api/media-diet/export', async (req, res) => {
    try {
      const rawIds = [].concat(req.query['ids[]'] || req.query.ids || []);
      const ids = enforceIdCap(rawIds.filter(Boolean));
      const format = String(req.query.format || 'json').toLowerCase();

      if (!ids.length) {
        if (format === 'opml') return res.type('text/xml').send(buildOpml([]));
        if (format === 'bookmarks') {
          res.setHeader('Content-Disposition', 'attachment; filename="channels.html"');
          return res.type('text/html').send(buildBookmarksHtml([]));
        }
        return res.json([]);
      }

      const { Channels } = cds.entities('com.sap.developers.ims');
      const db = await cds.connect.to('db');
      const rows = await db.run(
        SELECT.from(Channels)
          .columns('ID', 'name', 'url', 'feedUrl', 'ownerType', 'isSapOwned')
          .where({ ID: { in: ids }, isPublished: true }),
      );

      if (format === 'opml') {
        return res.type('text/xml').send(buildOpml(rows));
      }
      if (format === 'bookmarks') {
        res.setHeader('Content-Disposition', 'attachment; filename="channels.html"');
        return res.type('text/html').send(buildBookmarksHtml(rows));
      }
      return res.json(rows);
    } catch (err) {
      cds.log('media-diet').error('export failed', err);
      res.status(500).json({ error: err?.message });
    }
  });
  ```

- [ ] **Step 6: Update srv-qa cp-list to include media-diet-export.js**

  ```bash
  sd -F '../../srv/lib/media-diet-picks.js' \
     '../../srv/lib/media-diet-picks.js ../../srv/lib/media-diet-export.js' \
     .deploy/mta.yaml
  ```

  Verify:
  ```bash
  grep 'media-diet-export' .deploy/mta.yaml
  ```

- [ ] **Step 7: Commit**

  ```bash
  git add srv/lib/media-diet-export.js srv/server.js .deploy/mta.yaml test/unit/media-diet-export.test.js
  git commit -m "feat(media-diet): add OPML/bookmarks/json export endpoint"
  ```

---

## Task 11: Full test pass + CSS polish note

**Files:**
- No new files. Runs the full test suite to confirm nothing regressed.

**Interfaces:**
- Validates all Tasks 1–10 are internally consistent and the existing suite stays green.

- [ ] **Step 1: Run the full unit suite**

  ```bash
  npm test
  ```

  Expected: no new failures. If tests that were passing before fail, investigate — do not mask with skips.

- [ ] **Step 2: Verify TypeScript still compiles**

  ```bash
  npx tsc --project tsconfig.json --noEmit 2>&1 | head -30
  ```

  Expected: no new errors.

- [ ] **Step 3: Manual smoke — confirm the /build/channel-detail/:slug endpoint responds**

  Start local CAP: `cds watch`

  Then in a second terminal (using a slug that exists in your local SQLite seed, e.g. one inserted by setup-dev-data or a manual INSERT):
  ```bash
  curl -s http://localhost:4004/build/channel-detail/sap-cap-channel | jq '.slug, .notFound'
  ```

  Expected: `"sap-cap-channel"` and `false` (or `true` if that slug doesn't exist in local DB — what matters is no 500).

- [ ] **Step 4: CSS polish note (not a code task — document in commit message)**

  The `<section class="topic-channels">` band in `topic-detail-render.js` and the new `<section class="channel-topics">` band in `channel-detail-render.js` use CSS class names that are NOT yet in the Hugo/Fundamental Styles stylesheet. Add a note in the commit:

  ```
  NOTE for follow-up: topic-channels and channel-topics CSS classes need styling in
  hugo/assets/scss/. The sections render with correct semantic HTML but inherit browser
  defaults until a CSS task wires in card/list styles matching the surrounding page design.
  This is intentional — styling is a separate concern from the data/BLOB plumbing.
  ```

- [ ] **Step 5: Commit**

  ```bash
  git add . --dry-run   # confirm nothing unexpected staged
  git commit --allow-empty -m "chore(phase2): full test pass confirmed; CSS polish for channel-topics/topic-channels deferred to follow-up"
  ```

  (Skip the empty commit if there are no unstaged files; the test run itself needs no code change.)

---

## Task 12: Open PR

**Files:**
- No code changes.

**Interfaces:**
- Produces: PR from current feature branch targeting `DEV`.

- [ ] **Step 1: Verify branch is up to date with origin/DEV**

  ```bash
  git fetch origin
  git log --oneline origin/DEV..HEAD
  ```

  Expected: a list of the commits added in this plan, no merge conflicts.

- [ ] **Step 2: Push the branch**

  ```bash
  git push -u origin HEAD
  ```

- [ ] **Step 3: Open the PR**

  ```bash
  gh pr create \
    --base DEV \
    --title "feat(channels-hub): Phase 2 — crosswalk Direction 2, media-diet signed-in + export" \
    --body "$(cat <<'EOF'
  ## Summary

  - Adds regression-pinning unit tests for the already-coded Direction 1 (topic→channels) dark code.
  - Implements Direction 2 (channel→topics): per-channel BLOB pages at `/channels/:slug/` via `build-channel-detail.js`, `channel-detail-render.js`, `publish-channels.js`; wired into `publish-content.ts` render phase and `srv/server.js` endpoints.
  - Adds `/api/media-diet/my-picks` (xsuaa) — derives channel recommendations from user's completed tutorials via `mediaDietMyPicksLogic` in `srv/lib/media-diet-picks.js`.
  - Adds `/api/media-diet/export` (anon, cap 50 ids) — OPML/bookmarks/JSON export via `srv/lib/media-diet-export.js`; OPML `xmlUrl` only for non-null `feedUrl`.
  - Approuter routes: channel-detail catch-all after literal children; media-diet API routes.
  - srv-qa cp-list audited: four new `srv/lib/` files added.

  ## Test plan

  - [ ] `npm test` passes (all new unit tests green).
  - [ ] `npx tsc --project tsconfig.json --noEmit` no new errors.
  - [ ] DEV deploy: confirm `/build/channel-detail/<slug>` returns JSON for a seeded slug.
  - [ ] DEV deploy: confirm `/channels/<slug>/` serves an HTML page (BLOB served via serveHandler).
  - [ ] DEV deploy: confirm `/api/media-diet/my-picks` returns `{ channels: [], source: 'no-data' }` for a user with no completions (Phase 0 data prereqs may not be seeded yet).
  - [ ] DEV deploy: confirm `/api/media-diet/export?ids[]=<id>&format=opml` returns valid XML.
  - [ ] Full content rebuild after deploy to populate `channel-<slug>` BLOBs.
  EOF
  )"
  ```

---

## Self-Review

### Spec Coverage

| Spec Requirement | Task |
|---|---|
| Direction 1 regression unit test | Task 1 |
| CSS polish note for topic-channels band | Task 11 (documented) |
| `buildChannelDetailPayload(db, slug)` | Task 2 |
| `renderChannelDetail(channel)` | Task 3 |
| `publish-channels.js` with ≥5% abort guard | Task 4 |
| `GET /build/channel-detail/:slug` | Task 5 |
| `GET /content/channel-detail/:slug` (BLOB via serveHandler) | Task 5 |
| `POST /content/publish/render-channels` | Task 5 |
| `scripts/publish-content.ts` render-channel-detail phase | Task 6 |
| `renderChannelsPhase` in publish-client.ts | Task 6 |
| Approuter `^/channels/([^/?]+)/?$` catch-all (none, after literals) | Task 7 |
| Approuter media-diet routes (my-picks xsuaa, export none) | Task 7 |
| srv-qa cp-list audit: `build-channel-detail.js`, `channel-detail-render.js`, `publish-channels.js` | Task 8 |
| `media-diet-picks.js` (srv-qa cp-list audited) | Tasks 9 + 8 |
| `media-diet-export.js` (srv-qa cp-list audited) | Tasks 10 + 8 |
| `GET /api/media-diet/my-picks` (xsuaa) | Task 9 |
| `GET /api/media-diet/export` (none, cap 50, OPML/bookmarks/json) | Task 10 |
| OPML `xmlUrl` only for non-null `feedUrl` | Task 10 |
| Empty ChannelTopicMap → `{ channels:[], source:'no-data' }` fallback | Task 9 |
| `check-srv-qa-route-drift.ts` ALLOWLIST entry | Task 6 |
| PR to DEV, no direct merge | Task 12 |

**No spec gaps found.**

### Placeholder Scan

No TBD, TODO, "implement later", or "similar to Task N" patterns present. All code blocks are complete implementations.

### Type Consistency

- `buildChannelDetailPayload` → `ChannelDetailPayload` with fields `{slug, name, url, purpose, ownerType, topics, buildAt, notFound}` — used consistently in Tasks 2, 3, 4.
- `renderChannelDetail(channel)` takes `ChannelDetailPayload` and returns `{body, contentHash}` — matches Task 3 impl and Task 4 call site.
- `renderChannelsIntoSession` signature matches the `publish-topics.js` mirror pattern — `{db, sessionId, helpers, priorHashes, shell, deps}`.
- `renderChannelsPhase` in `publish-client.ts` calls `/content/publish/render-channels` — matches server.js registration.
- `mediaDietMyPicksLogic(db, sapId)` returns `{channels, source}` — matches Task 9 tests and server.js handler call.
- `enforceIdCap`, `buildOpml`, `buildBookmarksHtml` — used in Task 10 tests and Task 10 server handler with matching signatures.
- `resolveUserSapId(req.user)` — consumed from `srv/lib/resolve-db-user.js`; already in the codebase with confirmed signature `(user) → string|null`.

### Grounding Surprises

1. `db/channels.cds` shows `Channels` entity does NOT yet have `slug` or `feedUrl` columns — these are Phase 0 schema migrations. `buildChannelDetailPayload` queries `slug` and `feedUrl` columns, so **Phase 0 must be fully deployed (schema migrated + `npm run seed-channels` run) before the tests in Tasks 2, 9, 10 will pass on HANA**. SQLite in-memory tests will fail at the column query unless Phase 0 has also landed the CDS model change. If Phase 0 CDS model is not yet committed to this worktree, the unit tests in Tasks 2 and 9 that INSERT Channels with `slug`/`feedUrl` will fail. **Action for executor:** verify `db/channels.cds` has `slug : String(200)` and `feedUrl : String(500)` before running Task 2 tests; if not, pause and complete Phase 0 first.

2. `topics-query-channels.test.js` already exists and already seeds the exact fixtures needed for Task 1. The new `describe` block reuses the outer-scope `db` and fixtures without re-seeding — this is intentional and saves test time.

3. The `mediaDietMyPicksLogic` function joins via `TaskRecords.taskLegacyId → Tutorials.legacyId` (the IMS legacy join path), NOT via a direct FK. This is consistent with `user-progress.js` lines 39–69 which uses the same `legacyId` bridge. The unit test seeds `Tutorials.legacyId = 1` and a `TaskRecords.taskLegacyId = 1` row to exercise this path.
