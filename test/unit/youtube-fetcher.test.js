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

  it('caches failures for a SHORTER TTL than successes (#740)', async () => {
    // #740: poisoned-cache bug — a transient 403 was getting cached for 15 min
    // alongside successes, blanking the recent-videos rail for the whole TTL.
    // Fix: failures get FAILURE_TTL_MS (1 min) instead of TTL_MS (15 min).
    // This test fast-forwards time across the failure TTL boundary and asserts
    // a re-fetch happens at 65 s but not at 30 s.
    vi.useFakeTimers();

    // First call: /search 403s while playlistItems + channels succeed.
    // Result is { recent: [], error: 'YouTube API 403' } — a "failure" by
    // the cache-policy classifier (error != null).
    const stub = vi.fn(async (url) => {
      if (url.includes('search')) {
        return new Response('{"error":{"code":403}}', { status: 403 });
      }
      if (url.includes('playlistItems')) {
        return new Response(JSON.stringify({ items: [
          { snippet: { resourceId: { videoId: 'feat1' }, title: 'X',
            thumbnails: { high: { url: 'x' } }, publishedAt: '2026-06-26T15:00:00Z' } }
        ]}), { status: 200 });
      }
      if (url.includes('channels')) {
        return new Response(JSON.stringify({ items: [{ id: 'UC_x' }] }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', stub);

    const opts = { apiKey: 'test', playlistId: 'PLxxx', channelHandle: '@sapdevs' };

    // t=0: first call, populates failure-cache with { error: 'YouTube API 403' }
    const r1 = await fetchSapDevsVideos(opts);
    expect(r1.error).toMatch(/403/);
    const callsAfter1 = stub.mock.calls.length;

    // t=30s: still within FAILURE_TTL_MS (60s) → cache hit, no new fetches
    vi.advanceTimersByTime(30_000);
    const r2 = await fetchSapDevsVideos(opts);
    expect(stub.mock.calls.length).toBe(callsAfter1);  // cached
    expect(r2.error).toMatch(/403/);

    // t=65s: past FAILURE_TTL_MS → cache miss, NEW fetches triggered.
    // With the old 15-min-for-both policy this would still be a cache hit
    // and the user would stay broken for the whole 15 min.
    vi.advanceTimersByTime(35_000);  // total elapsed = 65s
    const r3 = await fetchSapDevsVideos(opts);
    expect(stub.mock.calls.length).toBeGreaterThan(callsAfter1);  // re-fetched

    vi.useRealTimers();
  });

  it('caches successes for the long TTL (15 min, sanity check)', async () => {
    // Mirror of the above but for the success path: at 30s a re-fetch is
    // still a cache hit (TTL_MS is 15 min, so 30s is well within).
    vi.useFakeTimers();

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
    await fetchSapDevsVideos(opts);
    const callsAfter1 = stub.mock.calls.length;

    // t=2 min: still within TTL_MS (15 min) → cache hit on the SUCCESS path
    // even though it's well past the FAILURE_TTL_MS (60s).
    vi.advanceTimersByTime(2 * 60 * 1000);
    await fetchSapDevsVideos(opts);
    expect(stub.mock.calls.length).toBe(callsAfter1);  // no new fetches

    vi.useRealTimers();
  });
});
