// test/unit/srv/youtube-corpus-fetcher.test.js
//
// Phase 4.4 (#447) PR-1: unit tests for the YouTube corpus fetcher.
// 7 cases covering one-page, sinceIso cutoff, null backfill, validator
// throws, channel-ID cache, multi-page pagination, limit cap.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  fetchSapDevsVideoCorpus,
  _setMockFetcher,
  _resetForTests,
} from '../../../srv/lib/youtube-corpus-fetcher.js';

const FIXTURE = JSON.parse(
  readFileSync(join(import.meta.dirname, '__fixtures__/youtube-corpus-page.json'), 'utf8'),
);

describe('fetchSapDevsVideoCorpus', () => {
  beforeEach(() => {
    _setMockFetcher(null);
    _resetForTests();
  });

  afterEach(() => {
    _resetForTests();
  });

  it('paginates a single page and returns normalised rows', async () => {
    _setMockFetcher(async (url) => {
      if (url.includes('/channels')) {
        return { items: [{ contentDetails: { relatedPlaylists: { uploads: 'UU_xyz_uploads' } } }] };
      }
      if (url.includes('/playlistItems')) return FIXTURE;
      throw new Error(`unexpected URL: ${url}`);
    });

    const videos = await fetchSapDevsVideoCorpus({
      apiKey: 'test-key', channelHandle: '@sapdevs', sinceIso: null, pageSize: 50,
    });
    expect(videos).toHaveLength(3);
    expect(videos[0].videoId).toBe('abc12345DEF');
    expect(videos[0].title).toContain('Developer News');
    expect(videos[0].description).toContain('Tom Jung');
    expect(videos[0].publishedAt).toBe('2026-06-28T15:00:00Z');
    expect(videos[0].channelTitle).toBe('SAP Developers');
    expect(videos[0].thumbnailUrl).toBe('https://i.ytimg.com/vi/abc12345DEF/hqdefault.jpg');
  });

  it('respects sinceIso cutoff — stops paging when item publishedAt < sinceIso', async () => {
    _setMockFetcher(async (url) => {
      if (url.includes('/channels')) {
        return { items: [{ contentDetails: { relatedPlaylists: { uploads: 'UU_xyz_uploads' } } }] };
      }
      // FIXTURE has 3 items: 2026-06-28, 2026-06-26, 2026-06-20.
      // sinceIso=2026-06-22 → first two pass, third triggers stop.
      return FIXTURE;
    });
    const videos = await fetchSapDevsVideoCorpus({
      apiKey: 'test-key', sinceIso: '2026-06-22T00:00:00Z',
    });
    expect(videos).toHaveLength(2);
    expect(videos.every((v) => v.publishedAt > '2026-06-22T00:00:00Z')).toBe(true);
  });

  it('null sinceIso enables backfill mode (no since-filter)', async () => {
    let capturedUrl;
    _setMockFetcher(async (url) => {
      if (url.includes('/channels')) {
        return { items: [{ contentDetails: { relatedPlaylists: { uploads: 'UU_xyz' } } }] };
      }
      capturedUrl = url;
      return FIXTURE;
    });
    await fetchSapDevsVideoCorpus({ apiKey: 'test-key', sinceIso: null });
    // playlistItems URL should NOT include any since-filter.
    expect(capturedUrl).not.toContain('publishedAfter');
  });

  it('validator throws when a row is missing videoId', async () => {
    _setMockFetcher(async (url) => {
      if (url.includes('/channels')) return { items: [{ contentDetails: { relatedPlaylists: { uploads: 'UU_xyz' } } }] };
      return {
        items: [{ snippet: { title: 't', description: 'd', publishedAt: 'p', channelTitle: 'c', thumbnails: {}, resourceId: {} } }],
      };
    });
    await expect(fetchSapDevsVideoCorpus({ apiKey: 'test-key', sinceIso: null })).rejects.toThrow(/videoId/);
  });

  it('caches channel-ID resolution across calls', async () => {
    let channelCalls = 0;
    _setMockFetcher(async (url) => {
      if (url.includes('/channels')) {
        channelCalls++;
        return { items: [{ contentDetails: { relatedPlaylists: { uploads: 'UU_xyz' } } }] };
      }
      return FIXTURE;
    });
    await fetchSapDevsVideoCorpus({ apiKey: 'test-key', sinceIso: null });
    await fetchSapDevsVideoCorpus({ apiKey: 'test-key', sinceIso: null });
    expect(channelCalls).toBe(1);  // channel-ID cached after first call
  });

  it('paginates multi-page via nextPageToken', async () => {
    const pageA = {
      items: FIXTURE.items.slice(0, 2),
      nextPageToken: 'PAGE_B_TOKEN',
    };
    const pageB = { items: FIXTURE.items.slice(2), nextPageToken: null };
    let callIndex = 0;
    _setMockFetcher(async (url) => {
      if (url.includes('/channels')) return { items: [{ contentDetails: { relatedPlaylists: { uploads: 'UU_xyz' } } }] };
      return callIndex++ === 0 ? pageA : pageB;
    });
    const videos = await fetchSapDevsVideoCorpus({ apiKey: 'test-key', sinceIso: null });
    expect(videos).toHaveLength(3);
  });

  it('respects limit cap', async () => {
    _setMockFetcher(async (url) => {
      if (url.includes('/channels')) return { items: [{ contentDetails: { relatedPlaylists: { uploads: 'UU_xyz' } } }] };
      return FIXTURE;
    });
    const videos = await fetchSapDevsVideoCorpus({ apiKey: 'test-key', sinceIso: null, limit: 2 });
    expect(videos).toHaveLength(2);
  });
});
