import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchSapDevsVideos, _resetForTests } from '../../srv/lib/youtube-fetcher.js';

beforeEach(() => { _resetForTests(); vi.restoreAllMocks(); });

describe('youtube-fetcher', () => {
  it('returns featured + recent on success', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (url.includes('playlistItems')) {
        return new Response(JSON.stringify({ items: [
          { snippet: { resourceId: { videoId: 'feat1' }, title: 'Developer News Ep 99',
            thumbnails: { high: { url: 'https://yt/feat1.jpg' } },
            publishedAt: '2026-06-26T15:00:00Z' } }
        ]}), { status: 200 });
      }
      if (url.includes('search')) {
        return new Response(JSON.stringify({ items: [
          { id: { videoId: 'r1' }, snippet: { title: 'Tech Bytes 1', thumbnails: { high: { url: 'x' } }, publishedAt: '2026-06-25T00:00:00Z' } },
          { id: { videoId: 'r2' }, snippet: { title: 'Live 2',        thumbnails: { high: { url: 'x' } }, publishedAt: '2026-06-20T00:00:00Z' } },
          { id: { videoId: 'r3' }, snippet: { title: 'Tutorial 3',    thumbnails: { high: { url: 'x' } }, publishedAt: '2026-06-15T00:00:00Z' } }
        ]}), { status: 200 });
      }
      if (url.includes('channels')) {
        return new Response(JSON.stringify({ items: [{ id: 'UC_sapdevs' }] }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    }));
    const out = await fetchSapDevsVideos({ apiKey: 'test', playlistId: 'PLxxx', channelHandle: '@sapdevs' });
    expect(out.featured.videoId).toBe('feat1');
    expect(out.recent).toHaveLength(3);
    expect(out.error).toBeNull();
  });

  it('returns error metadata on 403 (quota)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":{"code":403}}', { status: 403 })));
    const out = await fetchSapDevsVideos({ apiKey: 'test', playlistId: 'PLxxx', channelHandle: '@sapdevs' });
    expect(out.error).toMatch(/403|quota/i);
    expect(out.featured).toBeNull();
  });

  it('returns no-api-key when apiKey is empty', async () => {
    const out = await fetchSapDevsVideos({ apiKey: '', playlistId: null, channelHandle: '@sapdevs' });
    expect(out.error).toBe('no-api-key');
  });

  it('caches within TTL (fetch called once across two calls)', async () => {
    const stub = vi.fn(async (url) => {
      if (url.includes('playlistItems')) {
        return new Response(JSON.stringify({ items: [
          { snippet: { resourceId: { videoId: 'feat1' }, title: 'X',
            thumbnails: { high: { url: 'x' } }, publishedAt: '2026-06-26T15:00:00Z' } }
        ]}), { status: 200 });
      }
      if (url.includes('search')) {
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
      }
      if (url.includes('channels')) {
        return new Response(JSON.stringify({ items: [{ id: 'UC_x' }] }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', stub);

    const opts = { apiKey: 'test', playlistId: 'PLxxx', channelHandle: '@sapdevs' };
    const callsBefore = stub.mock.calls.length;
    const first = await fetchSapDevsVideos(opts);
    const callsAfterFirst = stub.mock.calls.length;
    const second = await fetchSapDevsVideos(opts);
    const callsAfterSecond = stub.mock.calls.length;

    // First call: 3 HTTP requests (channels + playlistItems + search).
    // Second call (within TTL): 0 new HTTP requests — cache hit.
    expect(callsAfterFirst - callsBefore).toBeGreaterThan(0);
    expect(callsAfterSecond).toBe(callsAfterFirst);  // no new fetches
    expect(second).toEqual(first);  // identical cached payload
  });
});
