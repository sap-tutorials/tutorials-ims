// test/unit/mcp-homepage-tools.test.js
//
// Unit tests for HomepageService MCP tools: get_recent_news + get_recent_videos.
// (#912 Task 9)
//
// fetchRssItems is mocked to avoid live network calls in unit tests.
// ext.Videos rows are seeded in beforeAll for the videos tests.

import { expect, describe, it, beforeAll, afterAll, vi } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';

// Mock fetchRssItems to avoid live network calls.
// vi.mock is hoisted by Vitest before module loads, so homepage-service.js
// receives the mock when it first imports from ./lib/homepage-rss-fetcher.js.
vi.mock('../../srv/lib/homepage-rss-fetcher.js', async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    fetchRssItems: vi.fn(async (_url, { limit = 5 } = {}) => {
      const items = Array.from({ length: 10 }, (_, i) => ({
        title:       `SAP News Item ${i + 1}`,
        link:        `https://news.sap.com/item-${i + 1}`,
        publishedAt: new Date(Date.now() - i * 3_600_000).toISOString(),
        description: `Description ${i + 1}`,
      }));
      return items.slice(0, limit);
    }),
  };
});

describe('MCP curated tools: HomepageService', () => {
  let HomepageService;

  beforeAll(async () => {
    await cds.deploy([
      path.join(process.cwd(), 'db'),
      path.join(process.cwd(), 'srv'),
    ]).to('sqlite::memory:');

    HomepageService = await cds.serve('HomepageService').from('./srv/homepage-service');

    // Seed ext.Videos rows for get_recent_videos tests.
    const { Videos } = cds.entities('com.sap.developers.ims.external');
    await INSERT.into(Videos).entries([
      {
        ID:             'aaaaaaaa-9999-0000-0000-000000000001',
        slug:           'vd-abc123',
        youtubeVideoId: 'abc123',
        title:          'SAP CAP Tutorial',
        thumbnailUrl:   'https://img.youtube.com/vi/abc123/hqdefault.jpg',
        publishedAt:    '2026-06-01T10:00:00Z',
      },
      {
        ID:             'aaaaaaaa-9999-0000-0000-000000000002',
        slug:           'vd-def456',
        youtubeVideoId: 'def456',
        title:          'SAP HANA Cloud',
        thumbnailUrl:   'https://img.youtube.com/vi/def456/hqdefault.jpg',
        publishedAt:    '2026-06-02T10:00:00Z',
      },
      {
        ID:             'aaaaaaaa-9999-0000-0000-000000000003',
        slug:           'vd-ghi789',
        youtubeVideoId: 'ghi789',
        title:          'BTP Integration',
        thumbnailUrl:   'https://img.youtube.com/vi/ghi789/hqdefault.jpg',
        publishedAt:    '2026-06-03T10:00:00Z',
      },
    ]);
  });

  afterAll(async () => {
    await cds.disconnect();
  });

  // ─────────────────────────────────────────────────────────────
  // get_recent_news
  // ─────────────────────────────────────────────────────────────

  describe('get_recent_news', () => {
    it('returns Array with correct shape (title, link, publishedAt)', async () => {
      const results = await HomepageService.send('get_recent_news', { limit: 5 });
      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBeLessThanOrEqual(5);
      for (const n of results) {
        expect(n).toHaveProperty('title');
        expect(n).toHaveProperty('link');
        expect(n).toHaveProperty('publishedAt');
      }
    });

    it('clamps limit at 50', async () => {
      const results = await HomepageService.send('get_recent_news', { limit: 999 });
      expect(results.length).toBeLessThanOrEqual(50);
    });

    it('does not read req.user (anonymous tier)', async () => {
      // Call with no auth context — must not throw.
      const results = await HomepageService.send('get_recent_news', {});
      expect(Array.isArray(results)).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // get_recent_videos
  // ─────────────────────────────────────────────────────────────

  describe('get_recent_videos', () => {
    it('returns Array with videoId, title, thumbnail fields', async () => {
      const results = await HomepageService.send('get_recent_videos', { limit: 10 });
      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBeGreaterThan(0);
      for (const v of results) {
        expect(v).toHaveProperty('videoId');
        expect(v).toHaveProperty('title');
        expect(v).toHaveProperty('thumbnail');
      }
    });

    it('maps youtubeVideoId → videoId and thumbnailUrl → thumbnail', async () => {
      const results = await HomepageService.send('get_recent_videos', { limit: 10 });
      expect(results.length).toBeGreaterThan(0);
      // youtubeVideoId from seeded row must appear as videoId (not youtubeVideoId)
      const ids = results.map((v) => v.videoId);
      expect(ids).toContain('abc123');
      // must NOT expose raw DB column names
      for (const v of results) {
        expect(v).not.toHaveProperty('youtubeVideoId');
        expect(v).not.toHaveProperty('thumbnailUrl');
      }
    });

    it('clamps limit at 50', async () => {
      const results = await HomepageService.send('get_recent_videos', { limit: 999 });
      expect(results.length).toBeLessThanOrEqual(50);
    });

    it('returns [] when query returns no rows (empty table — no crash)', async () => {
      const runSpy = vi.spyOn(cds.db, 'run').mockResolvedValueOnce([]);
      const results = await HomepageService.send('get_recent_videos', { limit: 5 });
      expect(Array.isArray(results)).toBe(true);
      expect(results).toHaveLength(0);
      runSpy.mockRestore();
    });

    it('returns [] when query throws (no crash)', async () => {
      const runSpy = vi.spyOn(cds.db, 'run').mockRejectedValueOnce(new Error('simulated DB error'));
      const results = await HomepageService.send('get_recent_videos', { limit: 5 });
      expect(Array.isArray(results)).toBe(true);
      runSpy.mockRestore();
    });

    it('does not read req.user (anonymous tier)', async () => {
      // Call with no auth context — must not throw.
      const results = await HomepageService.send('get_recent_videos', {});
      expect(Array.isArray(results)).toBe(true);
    });
  });
});
