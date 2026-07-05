// srv/homepage-service.js
//
// HomepageService — public data bands for the developer portal homepage. (#639)
// Five function handlers:
//   events()          → array of EventCard (DB Events merged with optional remote)
//   videos()          → VideoPayload (YouTube via fetchSapDevsVideos, guarded by config flag)
//   communityBlogs()  → array of RssItem (SAP Community RSS, max 3)
//   news()            → array of RssItem (SAP News RSS, max 2)
//   shelves(verb)     → array of ShelfItem (HomepageShelves, filtered by verb if set)
//
// All endpoints are anonymous (no @requires on the service).
// Cache: 60 s for events, 5 min for shelves, 15 min for videos (in fetcher),
//        30 min for RSS (in fetcher). In-memory objects keyed by a simple
//        { at, value } shape — per-process, no cross-instance sharing needed.
//
// Spec: docs/superpowers/specs/2026-06-27-639-developer-homepage-design.md

import cds from '@sap/cds';
import { mergeEvents } from './lib/homepage-events-merger.js';
import { fetchSapDevsVideos } from './lib/youtube-fetcher.js';
import { fetchRssItems } from './lib/homepage-rss-fetcher.js';
import { resolveSecret } from './lib/secret-resolver.js';
import { buildEnvelope, hashEnvelope } from './lib/homepage/personalized-envelope.js';
import { resolveUserSapId } from './lib/resolve-db-user.js';
import * as metrics from './lib/metrics.js';

const log = cds.log('homepage-service');

// (#639) Module-level caches — simple {at, value} shape, per-process.
const EVENTS_TTL_MS = 60 * 1000;          // 60 s
const SHELVES_TTL_MS = 5 * 60 * 1000;     // 5 min

const STATE_KEY = Symbol.for('com.sap.developers.ims:homepage-service');
const _state = (globalThis[STATE_KEY] ??= {
  events: { at: 0, value: null },
  // Map<verb|'', {at, value}> for shelves
  shelves: new Map(),
});

/** Test-only: clear all cached values. (#639) */
export function _resetForTests() {
  _state.events = { at: 0, value: null };
  _state.shelves.clear();
}

// (#639, #703) SAP Community RSS — blog posts feed. The Khoros endpoint
// migrated from the legacy `/t5/s/<id>/rss/...` path to the new
// `/khhcw49343/rss/Community?interaction.style=<style>` path (verified
// 2026-06-28). The previous URL returned 404 from both workstation and
// CF egress, which was indistinguishable from a working-but-empty feed
// because the RSS fetcher swallows errors and returns []. Other styles
// available from this endpoint: qanda, forum, occasion, tkb.
const COMMUNITY_BLOGS_RSS_URL = 'https://community.sap.com/khhcw49343/rss/Community?interaction.style=blog';
// (#639) SAP News RSS
const SAP_NEWS_RSS_URL = 'https://news.sap.com/feed/';

// (#639) Singleton HomepageConfig UUID (must match admin-service.js seed ID)
const HOMEPAGE_CONFIG_SINGLETON_ID = '00000000-0000-0000-0000-00000000c8ae';

export default class HomepageService extends cds.ApplicationService {

  async init() {
    await super.init();

    // (#639) events() — DB Events + optional sap-devs remote source, 60 s cache.
    // DB field mapping: Events.name → title, Events.startDate → startsAt.
    // Only future events (startDate >= now) are included.
    this.on('events', async () => {
      const now = Date.now();
      if (_state.events.value !== null && (now - _state.events.at) < EVENTS_TTL_MS) {
        return _state.events.value;
      }

      let localRows = [];
      try {
        const db = await cds.connect.to('db');
        const { Events } = cds.entities('com.sap.developers.ims');
        // CDS QL tagged-template form — the raw '?' placeholder syntax used previously
        // is a CDS-QL anti-pattern that throws at parse time, the catch path swallowed it,
        // and the function silently returned []. See feedback_skip_hybrid_test_costs_two_pr_cycles.
        const nowIso = new Date().toISOString();
        const raw = await db.run(
          SELECT.from(Events)
            .columns('name', 'startDate', 'timeZone', 'eventType')
            .where`startDate >= ${nowIso}`
            .orderBy('startDate asc')
            .limit(20)
        );
        // Map DB shape → EventCard shape (startsAt / title)
        localRows = (raw || []).map(e => ({
          title:    e.name       || '',
          startsAt: e.startDate  || null,
          location: e.timeZone   || '',
          format:   e.eventType  || '',
          register: null,
        }));
      } catch (err) {
        log.warn('[events] DB query failed (returning empty local array):', err.message);
      }

      // Optional remote source injected via globalThis for tests / future sap-devs MCP.
      const remote = globalThis.__sapDevsEvents__ || [];

      const merged = mergeEvents(localRows, remote, { now });

      _state.events = { at: now, value: merged };
      return merged;
    });

    // (#639) videos() — reads HomepageConfig flag, fetches YouTube data. (#1007) with
    // read-through fallback to the persistent `ext.Videos` table when the live YouTube
    // call fails or comes back with an empty `recent`. The in-memory 15-min cache in
    // youtube-fetcher.js does NOT survive a srv restart (per-process globalThis), so
    // an MTA deploy plus a temporarily-broken YouTube playlistId was enough to empty
    // the band on DEV. `ext.Videos` is refreshed twice weekly by
    // srv/jobs/fetch-videos-job.js (Sun+Wed @ 03:11 UTC) — a stale-by-a-few-days list
    // beats an empty band.
    this.on('videos', async () => {
      let cfg;
      try {
        const db = await cds.connect.to('db');
        cfg = await db.run(
          SELECT.one.from('com.sap.developers.ims.HomepageConfig')
            .where({ ID: HOMEPAGE_CONFIG_SINGLETON_ID })
        );
      } catch (err) {
        log.warn('[videos] HomepageConfig read failed:', err.message);
      }

      // If videoBandEnabled is explicitly false, return disabled payload.
      // A missing config row (fresh subaccount, no AdminService auto-init yet) is treated as
      // "use defaults" (enabled=true) — the admin can explicitly disable later.
      if (cfg?.videoBandEnabled === false) {
        return { featured: null, recent: [], error: 'disabled' };
      }

      const apiKey = await resolveSecret('YOUTUBE_API_KEY', { logTag: '[homepage-service/videos]' });
      const live = await fetchSapDevsVideos({
        apiKey: apiKey || '',
        playlistId: cfg?.developerNewsPlaylistId || '',
        channelHandle: '@sapdevs',
      });

      // Live path succeeded with data — return as-is.
      if (!live.error && (live.recent?.length ?? 0) > 0) return live;

      // (#1007) Fallback: read the persistent Videos corpus written by
      // srv/jobs/fetch-videos-job.js. Best-effort; on any failure fall back to
      // whatever `live` produced (matches previous behavior — never a 500).
      try {
        const db = await cds.connect.to('db');
        const { Videos } = cds.entities('com.sap.developers.ims.external');
        const rows = await db.run(
          SELECT.from(Videos)
            .columns('youtubeVideoId', 'title', 'thumbnailUrl', 'publishedAt')
            .orderBy({ publishedAt: 'desc' })
            .limit(3)
        );
        if (rows?.length) {
          metrics.counter('homepage.videos.fallback[result=hit]');
          const recent = rows.map(r => ({
            videoId:     r.youtubeVideoId,
            title:       r.title,
            thumbnail:   r.thumbnailUrl,
            publishedAt: r.publishedAt,
          }));
          // Reuse live.featured if the playlist call happened to return one; otherwise
          // promote the newest row so the featured slot never depends on a
          // playlistId misconfig (see issue #1007 root cause 2).
          const featured = live.featured ?? recent[0];
          return { featured, recent, error: live.error ?? null };
        }
        metrics.counter('homepage.videos.fallback[result=empty]');
      } catch (err) {
        metrics.counter('homepage.videos.fallback[result=error]');
        log.warn('[videos] fallback SELECT from ext.Videos failed:', err.message);
      }

      // No live data, no fallback data — return whatever live gave us (typically
      // {featured:null, recent:[], error:'…'}) so the client can render its
      // error state.
      return live;
    });

    // (#639) communityBlogs() — SAP Community RSS, max 3 items.
    // NOTE for spec-review: COMMUNITY_BLOGS_RSS_URL was not smoke-checked during
    // implementation (no external network in this session). fetchRssItems returns
    // [] on any failure so a wrong URL results in an empty Community lane, not a crash.
    this.on('communityBlogs', async () => {
      return fetchRssItems(COMMUNITY_BLOGS_RSS_URL, { limit: 3 });
    });

    // (#639) news() — SAP News RSS, max 2 items.
    this.on('news', async () => {
      return fetchRssItems(SAP_NEWS_RSS_URL, { limit: 2 });
    });

    // (#639) shelves(verb) — HomepageShelves filtered by verb (optional), 5-min cache.
    this.on('shelves', async (req) => {
      const verb = req.data?.verb || '';
      const cacheKey = verb;
      const now = Date.now();

      const cached = _state.shelves.get(cacheKey);
      if (cached && (now - cached.at) < SHELVES_TTL_MS) {
        return cached.value;
      }

      let rows = [];
      try {
        const db = await cds.connect.to('db');
        // Build the filter once. Chaining .where() twice would emit
        // `isActive=true AND isActive=true AND verb=...` — functionally correct, wasteful.
        const filter = verb ? { isActive: true, verb } : { isActive: true };
        const query = SELECT
          .from('com.sap.developers.ims.HomepageShelves')
          .columns('ID', 'verb', 'shelf', 'sortOrder', 'title', 'url', 'description', 'badge', 'isExternal')
          .where(filter)
          .orderBy('verb', 'shelf', 'sortOrder');

        rows = (await db.run(query)) || [];
      } catch (err) {
        log.warn('[shelves] DB query failed:', err.message);
      }

      _state.shelves.set(cacheKey, { at: now, value: rows });
      return rows;
    });

    // (#639) redirectsActive() — approuter polls hourly to refresh its in-memory redirect map.
    // Returns only isActive=true rows from LegacyRedirects; no cache (polling cadence is low).
    this.on('redirectsActive', async () => {
      const db = await cds.connect.to('db');
      return db.run(SELECT.from('com.sap.developers.ims.LegacyRedirects')
        .where({ isActive: true })
        .columns('ID', 'fromPath', 'toPath', 'statusCode', 'isPattern'));
    });

    // (#639) recordRedirectHits(hits) — approuter batches hit counters and flushes every 60s.
    // Increments hitCount for each valid { id, count } entry. Returns the number of rows updated.
    // Per CLAUDE.md "Never write raw SQL — use cds.ql or CQL"; read-then-update pattern used.
    this.on('recordRedirectHits', async (req) => {
      const hits = Array.isArray(req.data?.hits) ? req.data.hits : [];
      if (hits.length === 0) return 0;
      const db = await cds.connect.to('db');
      let updated = 0;
      for (const { id, count } of hits) {
        if (!id || !Number.isFinite(count) || count <= 0) continue;
        const row = await db.run(SELECT.one`hitCount`.from('com.sap.developers.ims.LegacyRedirects').where({ ID: id }));
        if (!row) continue;
        await db.run(UPDATE('com.sap.developers.ims.LegacyRedirects')
          .set({ hitCount: (row.hitCount || 0) + count })
          .where({ ID: id }));
        updated++;
      }
      return updated;
    });

    // (#763) personalized() — authenticated envelope. @(requires:'authenticated-user')
    // declared in CDS overrides the service-level @requires:'any'.
    // Returns 204 when kill switch off, 200+envelope when on, 304 on ETag match.
    this.on('personalized', async (req) => {
      const { HomepageShelves, HomepageForYouCandidates, HomepageConfig,
              UserLearningPreferences, Users, Tutorials } = cds.entities('com.sap.developers.ims');

      const cfg = await SELECT.one.from(HomepageConfig).columns('personalizationEnabled');
      if (!cfg?.personalizationEnabled) {
        metrics.counter('homepage.personalized.requests[result=204-disabled]');
        req.res.status(204).end();
        return req.reject(-1);
      }

      // Resolve the Users.ID (UUID FK) from the XSUAA sapId claim — mirrors
      // the pattern in developer-service.js:744-754 (LearningPreferences READ).
      // req.user.id is the XSUAA subject string, NOT the Users.ID UUID column.
      const sapId = resolveUserSapId(req.user);
      const dbUser = sapId ? await SELECT.one.from(Users).columns('ID').where({ sapId }) : null;
      // No Users row → envelope is still built with all-null profile (valid).

      const [prefsRow, shelves, forYou, featuredRows] = await Promise.all([
        dbUser?.ID
          ? SELECT.one.from(UserLearningPreferences).where({ user_ID: dbUser.ID })
              .columns('deployment', 'role', 'cloud')
          : Promise.resolve(null),
        SELECT.from(HomepageShelves).where({ isActive: true })
          .columns('ID', 'verb', 'shelf', 'sortOrder', 'title',
                   'personaTags', 'personaWeight', 'personaHidden'),
        SELECT.from(HomepageForYouCandidates).where({ active: true })
          .columns('ID', 'kind', 'targetSlug', 'title', 'description', 'imageUrl',
                   'personaTags', 'personaWeight', 'personaHidden', 'sortOrder'),
        // (#763 Task 12) Static top-8 featured tutorials ordered by featuredOrder.
        // Tutorials.featuredOrder is the admin-curated rank (NULL = not featured).
        // status filter mirrors srv/handlers/recommendations.js — hides soft-deleted
        // (INACTIVE / DELETED) tutorials that must not leak onto public surfaces.
        SELECT.from(Tutorials)
          .where`featuredOrder is not null and (status = 'ACTIVE' or status is null)`
          .columns('slug', 'featuredOrder')
          .orderBy('featuredOrder')
          .limit(8),
      ]);

      const profile = {
        role:       prefsRow?.role       ?? null,
        deployment: prefsRow?.deployment ?? null,
        cloud:      prefsRow?.cloud      ?? null,
      };

      // (#763 Task 12) Compose teaserSlugs: static featured top-8 + for-you tutorials,
      // deduped and capped at 12.
      const staticSlugs = featuredRows.map((r) => r.slug);
      const featuredForYouSlugs = forYou
        .filter((f) => f.kind === 'tutorial')
        .map((f) => f.targetSlug);
      const teaserSlugs = [...new Set([...staticSlugs, ...featuredForYouSlugs])].slice(0, 12);

      const envelope = buildEnvelope({
        profile, shelves, forYouCandidates: forYou, teaserSlugs,
      });
      envelope.hash = hashEnvelope(envelope);

      const inm = req.req?.headers?.['if-none-match'];
      if (inm && inm.replace(/"/g, '') === envelope.hash) {
        req.res.setHeader('Cache-Control', 'private, no-store');
        req.res.setHeader('X-Personalization', '1');
        req.res.setHeader('ETag', `"${envelope.hash}"`);
        metrics.counter('homepage.personalized.requests[result=304]');
        req.res.status(304).end();
        return req.reject(-1);
      }

      req.res.setHeader('Cache-Control', 'private, no-store');
      req.res.setHeader('X-Personalization', '1');
      req.res.setHeader('ETag', `"${envelope.hash}"`);
      metrics.counter('homepage.personalized.requests[result=200]');
      return envelope;
    });

    // (#763 Task 12) tutorialCards() — fetch card HTML for slugs not in the Row-5 DOM.
    // Public endpoint (inherits service @requires:'any'). Capped at 20 slugs.
    // Returns nav-card HTML matching browse/_partials/card-tutorial.html shape.
    this.on('tutorialCards', async (req) => {
      const raw = req.data?.slugs || [];
      const slugs = raw.filter(Boolean).map(String).slice(0, 20);
      if (slugs.length === 0) return [];

      const { Tutorials } = cds.entities('com.sap.developers.ims');
      // status filter matches srv/handlers/recommendations.js — hides
      // INACTIVE/DELETED tutorials from the public /homepage/tutorialCards path.
      const rows = await SELECT.from(Tutorials)
        .where({ slug: { in: slugs } })
        .and(`status = 'ACTIVE' or status is null`)
        .columns('slug', 'title', 'description', 'primaryTag', 'experienceTag', 'averageTimeToComplete');

      // HTML-escape helper — guards against XSS if a title/tag ever contains markup.
      const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
      const safe = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ESC[c]);

      return rows.map((r) => {
        const level = r.experienceTag ?? '';
        const levelLabel = level ? level[0].toUpperCase() + level.slice(1) : '';
        const mins = r.averageTimeToComplete ?? 0;
        const timeLabel = mins < 60
          ? `${mins} min.`
          : `${Math.floor(mins / 60)} hr.${mins % 60 > 0 ? ` ${mins % 60} min.` : ''}`;
        return {
          slug: r.slug,
          html:
            `<div data-slug="${safe(r.slug)}">` +
            `<a href="/tutorials/${safe(r.slug)}/" class="nav-card" data-vt-card="navigator">` +
            `<div class="nav-card__type nav-card__type--tutorial">TUTORIAL</div>` +
            `<h3 class="nav-card__title">${safe(r.title)}</h3>` +
            `<p class="nav-card__desc">${safe(r.description)}</p>` +
            `<div class="nav-card__meta">` +
            `<span class="nav-card__meta-item">${safe(levelLabel)}</span>` +
            `<span class="nav-card__meta-sep">&middot;</span>` +
            `<span class="nav-card__meta-item">${safe(timeLabel)}</span>` +
            `</div>` +
            `<div class="nav-card__tag">${safe(r.primaryTag)}</div>` +
            `</a>` +
            `</div>`,
        };
      });
    });

    // (#763 Task 19) beaconApplied — client fires once per surface per session
    // after personalization has been applied to the page.  Aggregate signal
    // only — no PII stored.  surface is validated against a fixed allowlist.
    const BEACON_SURFACES = new Set([
      'verb-order', 'for-you', 'teaser', 'shelf', 'video-filter', 'rss-filter',
    ]);
    this.on('beaconApplied', (req) => {
      const { surface } = req.data ?? {};
      if (!surface || !BEACON_SURFACES.has(surface)) {
        // Unknown surface — ignore silently (don't leak the allowlist).
        return {};
      }
      metrics.counter(`homepage.personalized.applied[surface=${surface}]`);
      return {};
    });

    // (#912) get_recent_news — MCP curated tool.
    // Calls fetchRssItems directly with the caller-supplied limit so MCP
    // callers can request more than the 2-item homepage cap. The existing
    // news() handler is hardcoded to limit:2; proxying through it would
    // silently truncate any request for more items.
    this.on('get_recent_news', async (req) => {
      const limit = Math.min(Math.max(req.data?.limit ?? 10, 1), 50);
      return fetchRssItems(SAP_NEWS_RSS_URL, { limit });
    });

    // (#912) get_recent_videos — MCP curated tool.
    // Reads ext.Videos directly (skip live YouTube fetch — it caps at 3 and
    // needs an API key that is not required here). The corpus is refreshed
    // twice-weekly by srv/jobs/fetch-videos-job.js.  Returns [] on any DB
    // failure so callers never see a 500.
    this.on('get_recent_videos', async (req) => {
      const limit = Math.min(Math.max(req.data?.limit ?? 10, 1), 50);
      try {
        const db = await cds.connect.to('db');
        const { Videos } = cds.entities('com.sap.developers.ims.external');
        const rows = await db.run(
          SELECT.from(Videos)
            .columns('youtubeVideoId', 'title', 'thumbnailUrl', 'publishedAt')
            .orderBy({ publishedAt: 'desc' })
            .limit(limit)
        );
        return (rows || []).map((r) => ({
          videoId:     r.youtubeVideoId ?? '',
          title:       r.title ?? '',
          thumbnail:   r.thumbnailUrl ?? '',
          publishedAt: r.publishedAt ?? null,
        }));
      } catch (err) {
        log.warn('[get_recent_videos] DB query failed:', err.message);
        return [];
      }
    });
  }
}
