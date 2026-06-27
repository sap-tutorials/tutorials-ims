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

// (#639) SAP community blogs RSS — plan's URL (unverified at build time; see Task 9 spec-review note)
const COMMUNITY_BLOGS_RSS_URL = 'https://community.sap.com/t5/s/Y09vMI/rss/Community?interaction.style=blog';
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
  }
}
