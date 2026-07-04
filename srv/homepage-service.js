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

    // (#639) videos() — reads HomepageConfig flag, fetches YouTube data.
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
      return fetchSapDevsVideos({
        apiKey: apiKey || '',
        playlistId: cfg?.developerNewsPlaylistId || '',
        channelHandle: '@sapdevs',
      });
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
              UserLearningPreferences, Users } = cds.entities('com.sap.developers.ims');

      const cfg = await SELECT.one.from(HomepageConfig).columns('personalizationEnabled');
      if (!cfg?.personalizationEnabled) {
        req.res.status(204).end();
        return req.reject(-1);
      }

      // Resolve the Users.ID (UUID FK) from the XSUAA sapId claim — mirrors
      // the pattern in developer-service.js:744-754 (LearningPreferences READ).
      // req.user.id is the XSUAA subject string, NOT the Users.ID UUID column.
      const sapId = resolveUserSapId(req.user);
      const dbUser = sapId ? await SELECT.one.from(Users).columns('ID').where({ sapId }) : null;
      // No Users row → envelope is still built with all-null profile (valid).

      const [prefsRow, shelves, forYou] = await Promise.all([
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
      ]);

      const profile = {
        role:       prefsRow?.role       ?? null,
        deployment: prefsRow?.deployment ?? null,
        cloud:      prefsRow?.cloud      ?? null,
      };

      const envelope = buildEnvelope({
        profile, shelves, forYouCandidates: forYou, teaserSlugs: [], // Task 12
      });
      envelope.hash = hashEnvelope(envelope);

      const inm = req.req?.headers?.['if-none-match'];
      if (inm && inm.replace(/"/g, '') === envelope.hash) {
        req.res.setHeader('ETag', `"${envelope.hash}"`);
        req.res.status(304).end();
        return req.reject(-1);
      }

      req.res.setHeader('Cache-Control', 'private, no-store');
      req.res.setHeader('X-Personalization', '1');
      req.res.setHeader('ETag', `"${envelope.hash}"`);
      return envelope;
    });
  }
}
