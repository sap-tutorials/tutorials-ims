// test/unit/youtube-corpus-fetcher-statistics.test.js
//
// (#1031) Unit tests for youtube-corpus-fetcher.fetchStatistics.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  fetchStatistics,
  _setMockFetcher,
  _resetForTests,
} from '../../srv/lib/youtube-corpus-fetcher.js';

describe('fetchStatistics (#1031)', () => {
  afterEach(() => _resetForTests());

  it('returns viewCount/likeCount/commentCount per requested id in one batch', async () => {
    _setMockFetcher(async (url) => {
      expect(url).toContain('/videos?');
      expect(url).toContain('part=statistics');
      expect(url).toContain('id=a%2Cb'); // "a,b" url-encoded
      return {
        items: [
          { id: 'a', statistics: { viewCount: '1234', likeCount: '10', commentCount: '3' } },
          { id: 'b', statistics: { viewCount: '5', likeCount: '0', commentCount: '0' } },
        ],
      };
    });

    const result = await fetchStatistics({ apiKey: 'k', videoIds: ['a', 'b'] });
    expect(result.get('a')).toEqual({ viewCount: 1234, likeCount: 10, commentCount: 3 });
    expect(result.get('b')).toEqual({ viewCount: 5, likeCount: 0, commentCount: 0 });
  });

  it('splits >50 ids into batches of 50', async () => {
    const calls = [];
    _setMockFetcher(async (url) => {
      calls.push(url);
      const idsParam = decodeURIComponent(url.split('id=')[1].split('&')[0]);
      const ids = idsParam.split(',');
      return { items: ids.map(id => ({ id, statistics: { viewCount: '1', likeCount: '0', commentCount: '0' } })) };
    });

    const ids = Array.from({ length: 120 }, (_, i) => `v${i}`);
    const result = await fetchStatistics({ apiKey: 'k', videoIds: ids });
    expect(calls).toHaveLength(3);  // 50 + 50 + 20
    expect(result.size).toBe(120);
  });

  it('omits ids YouTube does not return (deleted/private videos)', async () => {
    _setMockFetcher(async () => ({
      items: [ { id: 'a', statistics: { viewCount: '1', likeCount: '0', commentCount: '0' } } ],
    }));

    const result = await fetchStatistics({ apiKey: 'k', videoIds: ['a', 'b'] });
    expect(result.has('a')).toBe(true);
    expect(result.has('b')).toBe(false);
  });

  it('returns an empty Map when given no ids without hitting the API', async () => {
    let called = false;
    _setMockFetcher(async () => { called = true; return { items: [] }; });
    const result = await fetchStatistics({ apiKey: 'k', videoIds: [] });
    expect(result.size).toBe(0);
    expect(called).toBe(false);
  });

  it('propagates HTTP errors (403 quota exceeded)', async () => {
    _setMockFetcher(async () => {
      const err = new Error('YouTube API 403');
      err.status = 403;
      throw err;
    });
    await expect(fetchStatistics({ apiKey: 'k', videoIds: ['a'] })).rejects.toThrow('403');
  });
});
