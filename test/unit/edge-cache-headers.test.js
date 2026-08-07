import { describe, it, expect } from 'vitest';
import {
  CONTENT_CACHE_CONTROL,
  cacheTagsFor,
  setContentCacheHeaders,
} from '../../srv/lib/edge-cache-headers.js';

// A minimal res double capturing setHeader calls into a plain map.
function fakeRes() {
  const headers = {};
  return {
    headers,
    setHeader(name, value) {
      headers[name] = value;
    },
  };
}

describe('edge-cache-headers (CDN origin support)', () => {
  describe('CONTENT_CACHE_CONTROL', () => {
    it('splits browser vs edge TTL and enables stale-while-revalidate', () => {
      expect(CONTENT_CACHE_CONTROL).toMatch(/public/);
      // Short browser TTL so a hard refresh picks up a publish quickly.
      expect(CONTENT_CACHE_CONTROL).toMatch(/(?:^|[ ,])max-age=60\b/);
      // Long shared-edge TTL — publish issues a targeted purge-by-tag.
      expect(CONTENT_CACHE_CONTROL).toMatch(/s-maxage=86400\b/);
      // Serve stale instantly while the edge revalidates.
      expect(CONTENT_CACHE_CONTROL).toMatch(/stale-while-revalidate=600\b/);
    });
  });

  describe('cacheTagsFor', () => {
    it('always emits the coarse content tag', () => {
      expect(cacheTagsFor(undefined)).toEqual(['content']);
      expect(cacheTagsFor('')).toEqual(['content']);
    });

    it('tags a tutorial slug with a per-item tag', () => {
      expect(cacheTagsFor('abap-basics')).toEqual([
        'content',
        'item-abap-basics',
      ]);
    });

    it('tags a group page with group + item tags', () => {
      expect(cacheTagsFor('group-getting-started')).toEqual([
        'content',
        'group',
        'item-group-getting-started',
      ]);
    });

    it('tags a mission page with mission + item tags', () => {
      expect(cacheTagsFor('mission-cap-intro')).toEqual([
        'content',
        'mission',
        'item-mission-cap-intro',
      ]);
    });

    it('tags the concepts index distinctly', () => {
      expect(cacheTagsFor('concepts')).toEqual(['content', 'concepts-index']);
    });

    it('tags a concept detail page with concepts + concept-<slug>', () => {
      expect(cacheTagsFor('concept-oauth')).toEqual([
        'content',
        'concepts',
        'concept-oauth',
      ]);
    });

    it('sanitizes exotic characters into valid tag tokens', () => {
      const tags = cacheTagsFor('weird/slug?with spaces&stuff');
      expect(tags[0]).toBe('content');
      // No character outside [A-Za-z0-9_-] survives in the item tag.
      expect(tags[1]).toMatch(/^item-[A-Za-z0-9_-]+$/);
    });

    it('caps token length to keep the header value bounded', () => {
      const long = 'x'.repeat(500);
      const tags = cacheTagsFor(long);
      // item- prefix (5) + at most 128 token chars.
      expect(tags[1].length).toBeLessThanOrEqual('item-'.length + 128);
    });
  });

  describe('setContentCacheHeaders', () => {
    it('sets Cache-Control, Vary, and Edge-Cache-Tag on a 200 content response', () => {
      const res = fakeRes();
      setContentCacheHeaders(res, { slug: 'abap-basics' });
      expect(res.headers['Cache-Control']).toBe(CONTENT_CACHE_CONTROL);
      expect(res.headers['Vary']).toBe('Accept-Encoding');
      expect(res.headers['Edge-Cache-Tag']).toBe('content, item-abap-basics');
    });

    it('emits only the coarse tag when no slug is given', () => {
      const res = fakeRes();
      setContentCacheHeaders(res, {});
      expect(res.headers['Edge-Cache-Tag']).toBe('content');
    });

    it('fails open — a broken res never throws out of the header path', () => {
      const brokenRes = {
        setHeader() {
          throw new Error('header write failed');
        },
      };
      expect(() => setContentCacheHeaders(brokenRes, { slug: 'x' })).not.toThrow();
    });
  });
});
