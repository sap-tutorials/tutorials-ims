// test/unit/srv/fetch-videos-job.test.js
//
// #447 Phase 4.4 PR-2: end-to-end cron orchestration test for videos.
// In-memory SQLite + mocked YouTube fetcher + mocked LLM + mocked embed.
//
// Mirrors test/unit/srv/fetch-discovery-missions-job.test.js with these
// substitutions: discovery-missions → videos; usesServices → featuresService;
// MAX-or-abort first-run gate is exercised (4.3 doesn't have one).

import { describe, it, beforeAll, afterAll, beforeEach, expect, vi } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';

let runFetchVideos;
let _setMockFetcher;
let _resetForTests;

function vec(...nums) { return new Float32Array(nums); }
function buf(...nums) {
  const f = vec(...nums);
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength);
}

describe('fetch-videos-job — merge-on-write (#707) + crash-safety (#708)', () => {
  beforeAll(async () => {
    await cds.deploy([
      path.join(process.cwd(), 'db'),
      path.join(process.cwd(), 'srv'),
    ]).to('sqlite::memory:');

    ({ runFetchVideos } = await import('../../../srv/jobs/fetch-videos-job.js'));
    ({ _setMockFetcher, _resetForTests } = await import('../../../srv/lib/youtube-corpus-fetcher.js'));
  });

  afterAll(async () => {
    await cds.disconnect();
  });

  beforeEach(async () => {
    const { Concepts } = cds.entities('com.sap.developers.ims');
    const { Videos, VideoConceptLinks, VideoServices } =
      cds.entities('com.sap.developers.ims.external');
    await DELETE.from(VideoConceptLinks);
    await DELETE.from(VideoServices);
    await DELETE.from(Videos);
    await DELETE.from(Concepts);

    const now = new Date().toISOString();
    await INSERT.into(Concepts).entries({
      slug: 'cap-handlers',
      name: 'CAP handlers',
      description: 'desc',
      embedding: buf(1, 0, 0, 0),
      status: 'ACTIVE',
      publishedAt: now,
      publishedBy: 'admin@sap.com',
    });

    _setMockFetcher(null);
    _resetForTests();
  });

  it('aborts cleanly when Videos is empty and no sinceIsoOverride (MAX-or-abort gate)', async () => {
    _setMockFetcher(async () => { throw new Error('should not be reached'); });
    const embed = vi.fn();
    const extractFn = vi.fn();

    const summary = await runFetchVideos({
      embed, extractFn, apiKeyOverride: 'test-key',
    });
    expect(summary.errors).toBeGreaterThan(0);
    expect(summary.fetched).toBe(0);
    expect(extractFn).not.toHaveBeenCalled();
  });

  it('processes a single new video end-to-end (exact-match concept)', async () => {
    // Seed an existing video so MAX(publishedAt) is set (avoid abort).
    const { Videos } = cds.entities('com.sap.developers.ims.external');
    await INSERT.into(Videos).entries({
      slug: 'vd-old99999',
      title: 'Previously Indexed',
      url: 'https://www.youtube.com/watch?v=old99999',
      youtubeVideoId: 'old99999',
      publishedAt: '2026-05-01T00:00:00.000Z',
      channelTitle: 'SAP Developers',
      thumbnailUrl: '',
      sourceId: 'old99999',
      contentHash: 'OLD',
      lastExtractedHash: 'OLD',
    });

    _setMockFetcher(async (url) => {
      if (url.includes('/channels')) {
        return { items: [{ contentDetails: { relatedPlaylists: { uploads: 'UU_x' } } }] };
      }
      // playlistItems response
      return {
        items: [{
          snippet: {
            title: 'New Video About CAP Handlers',
            description: 'A video discussing CAP handlers in depth.',
            publishedAt: '2026-06-01T09:32:11.000Z',
            channelTitle: 'SAP Developers',
            thumbnails: { high: { url: 'https://i.ytimg.com/vi/newvid01234/hqdefault.jpg' } },
            resourceId: { videoId: 'newvid01234' },
          },
        }],
        nextPageToken: null,
      };
    });

    const extractFn = vi.fn().mockResolvedValue({
      teaches: [{ slug: 'cap-handlers', name: 'CAP handlers', confidence: 0.9 }],
      featuresService: [{ name: 'SAP Integration Suite', confidence: 0.85 }],
      tokenUsage: { prompt: 100, completion: 50 },
    });
    const embed = vi.fn();

    const summary = await runFetchVideos({
      embed, extractFn, apiKeyOverride: 'test-key',
    });

    expect(summary.fetched).toBe(1);
    expect(summary.upserted).toBe(1);
    expect(summary.extracted).toBe(1);
    expect(summary.teachesWritten).toBe(1);
    expect(summary.servicesWritten).toBe(1);
    expect(summary.errors).toBe(0);
    expect(embed).not.toHaveBeenCalled();  // exact-match doesn't embed
  });

  it('merges + mints novel concepts via #707, dedups by conceptId for teaches', async () => {
    const { Videos } = cds.entities('com.sap.developers.ims.external');
    await INSERT.into(Videos).entries({
      slug: 'vd-old99999', title: 'Seed', url: 'u', youtubeVideoId: 'old99999',
      publishedAt: '2026-05-01T00:00:00.000Z',
      channelTitle: 'SAP Developers', thumbnailUrl: '',
      sourceId: 'old99999', contentHash: 'OLD', lastExtractedHash: 'OLD',
    });

    _setMockFetcher(async (url) => {
      if (url.includes('/channels')) {
        return { items: [{ contentDetails: { relatedPlaylists: { uploads: 'UU_x' } } }] };
      }
      return {
        items: [{
          snippet: {
            title: 'Test Video',
            description: 'Test description.',
            publishedAt: '2026-06-01T09:32:11.000Z',
            channelTitle: 'SAP Developers',
            thumbnails: { high: { url: 'https://i.ytimg.com/vi/newvid01234/hqdefault.jpg' } },
            resourceId: { videoId: 'newvid01234' },
          },
        }],
        nextPageToken: null,
      };
    });

    const extractFn = vi.fn().mockResolvedValue({
      teaches: [
        { slug: 'cap-handlers', name: 'CAP handlers', confidence: 0.9 },             // exact
        { slug: 'cap-event-handlers', name: 'CAP event handlers', confidence: 0.85 }, // near-dup → merged
        { slug: 'odata-v4', name: 'OData v4', confidence: 0.8 },                      // novel mint
      ],
      featuresService: [],
      tokenUsage: { prompt: 100, completion: 50 },
    });

    const embed = vi.fn(async ([name]) => {
      if (name === 'CAP event handlers') return [vec(0.99, 0.01, 0, 0)];
      if (name === 'OData v4') return [vec(0, 0, 1, 0)];
      throw new Error(`unexpected embed: ${name}`);
    });

    const summary = await runFetchVideos({
      embed, extractFn, apiKeyOverride: 'test-key',
    });

    expect(summary.mergedAtExtract).toBe(1);
    expect(summary.mintedAtExtract).toBe(1);
    // dedup: cap-handlers (exact) + cap-event-handlers (merged → cap-handlers) collapse
    expect(summary.teachesWritten).toBe(2);
  });

  it('dedups featuresService by serviceName.toLowerCase() case-insensitive', async () => {
    const { Videos } = cds.entities('com.sap.developers.ims.external');
    await INSERT.into(Videos).entries({
      slug: 'vd-old99999', title: 'Seed', url: 'u', youtubeVideoId: 'old99999',
      publishedAt: '2026-05-01T00:00:00.000Z',
      channelTitle: 'SAP Developers', thumbnailUrl: '',
      sourceId: 'old99999', contentHash: 'OLD', lastExtractedHash: 'OLD',
    });

    _setMockFetcher(async (url) => {
      if (url.includes('/channels')) {
        return { items: [{ contentDetails: { relatedPlaylists: { uploads: 'UU_x' } } }] };
      }
      return {
        items: [{
          snippet: {
            title: 'Test',
            description: 'd',
            publishedAt: '2026-06-01T00:00:00.000Z',
            channelTitle: 'SAP Developers',
            thumbnails: { high: { url: '' } },
            resourceId: { videoId: 'newvid01234' },
          },
        }],
        nextPageToken: null,
      };
    });

    const extractFn = vi.fn().mockResolvedValue({
      teaches: [],
      featuresService: [
        { name: 'SAP Build Apps', confidence: 0.9 },
        { name: 'sap build apps', confidence: 0.85 },  // case-different dup
        { name: 'SAP Integration Suite', confidence: 0.8 },
      ],
      tokenUsage: { prompt: 100, completion: 50 },
    });
    const embed = vi.fn();

    const summary = await runFetchVideos({
      embed, extractFn, apiKeyOverride: 'test-key',
    });
    expect(summary.servicesWritten).toBe(2);  // dedup collapsed 3 → 2
  });

  it('skips re-extraction when lastExtractedHash matches contentHash', async () => {
    const { Videos } = cds.entities('com.sap.developers.ims.external');
    await INSERT.into(Videos).entries({
      slug: 'vd-old99999', title: 'Seed', url: 'u', youtubeVideoId: 'old99999',
      publishedAt: '2026-04-01T00:00:00.000Z',
      channelTitle: 'SAP Developers', thumbnailUrl: '',
      sourceId: 'old99999', contentHash: 'X', lastExtractedHash: 'X',
    });

    _setMockFetcher(async (url) => {
      if (url.includes('/channels')) {
        return { items: [{ contentDetails: { relatedPlaylists: { uploads: 'UU_x' } } }] };
      }
      return {
        items: [{
          snippet: {
            title: 'Stable Video',
            description: 'Unchanged description.',
            publishedAt: '2026-06-01T09:32:11.000Z',
            channelTitle: 'SAP Developers',
            thumbnails: { high: { url: '' } },
            resourceId: { videoId: 'newvid01234' },
          },
        }],
        nextPageToken: null,
      };
    });

    const extractFn = vi.fn().mockResolvedValue({
      teaches: [{ slug: 'cap-handlers', name: 'CAP handlers', confidence: 0.9 }],
      featuresService: [],
      tokenUsage: { prompt: 100, completion: 50 },
    });
    const embed = vi.fn();

    await runFetchVideos({ embed, extractFn, apiKeyOverride: 'test-key' });
    _resetForTests();
    // After first run, MAX(publishedAt) advances to 2026-06-01 — second call
    // re-mocks; sinceIso = MAX which will filter out same-publishedAt rows in
    // the youtube-corpus-fetcher (publishedAt < sinceIso stop-early). Seed a
    // sentinel so the gate doesn't abort.
    const { Videos: V2 } = cds.entities('com.sap.developers.ims.external');
    // We still have the newly upserted vd-newvid01234 row; MAX advances now.
    _setMockFetcher(async (url) => {
      if (url.includes('/channels')) {
        return { items: [{ contentDetails: { relatedPlaylists: { uploads: 'UU_x' } } }] };
      }
      // Return the SAME row from the first run; sinceIso filter will let
      // publishedAt >= sinceIso through (the fetcher uses strict less-than).
      return {
        items: [{
          snippet: {
            title: 'Stable Video',
            description: 'Unchanged description.',
            publishedAt: '2026-06-01T09:32:11.000Z',
            channelTitle: 'SAP Developers',
            thumbnails: { high: { url: '' } },
            resourceId: { videoId: 'newvid01234' },
          },
        }],
        nextPageToken: null,
      };
    });
    const summary2 = await runFetchVideos({
      embed, extractFn, apiKeyOverride: 'test-key',
    });
    expect(summary2.skippedNoChange).toBeGreaterThanOrEqual(1);
  });

  it('respects budget gate: stops after N extractions; budgetExhausted=true', async () => {
    const { Videos } = cds.entities('com.sap.developers.ims.external');
    await INSERT.into(Videos).entries({
      slug: 'vd-old99999', title: 'Seed', url: 'u', youtubeVideoId: 'old99999',
      publishedAt: '2026-04-01T00:00:00.000Z',
      channelTitle: 'SAP Developers', thumbnailUrl: '',
      sourceId: 'old99999', contentHash: 'X', lastExtractedHash: 'X',
    });

    // 3 new videos returned; budget=2 → only 2 extracted, ALL 3 upserted.
    _setMockFetcher(async (url) => {
      if (url.includes('/channels')) {
        return { items: [{ contentDetails: { relatedPlaylists: { uploads: 'UU_x' } } }] };
      }
      return {
        items: [1, 2, 3].map(i => ({
          snippet: {
            title: `Video ${i}`,
            description: `desc ${i}`,
            publishedAt: `2026-05-${10 + i}T00:00:00.000Z`,
            channelTitle: 'SAP Developers',
            thumbnails: { high: { url: '' } },
            resourceId: { videoId: `vid000000${i}` },
          },
        })),
        nextPageToken: null,
      };
    });

    const extractFn = vi.fn().mockResolvedValue({
      teaches: [{ slug: 'cap-handlers', name: 'CAP handlers', confidence: 0.9 }],
      featuresService: [],
      tokenUsage: { prompt: 100, completion: 50 },
    });
    const embed = vi.fn();

    const summary = await runFetchVideos({
      embed, extractFn, apiKeyOverride: 'test-key', budgetOverride: 2,
    });

    expect(summary.fetched).toBe(3);
    expect(summary.upserted).toBe(3);     // ALL 3 upserted regardless of budget
    expect(summary.extracted).toBe(2);    // only 2 extracted (budget=2)
    expect(summary.budgetExhausted).toBe(true);
  });
});
