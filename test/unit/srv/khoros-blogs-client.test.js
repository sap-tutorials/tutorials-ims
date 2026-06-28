import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  searchBlogPosts,
  _setMockTransport,
  _resetCache,
} from '../../../srv/lib/khoros-blogs-client.js';

const FIXTURE_OK = JSON.parse(
  readFileSync(join(import.meta.dirname, '__fixtures__/khoros-blog-search.json'), 'utf8'),
);

describe('khoros-blogs-client.searchBlogPosts', () => {
  beforeEach(() => {
    _setMockTransport(null);
    _resetCache();
  });

  afterEach(() => {
    _resetCache();
  });

  it('returns posts + nextPageToken from a one-page Khoros response', async () => {
    _setMockTransport({
      async call(query) {
        expect(query).toContain('FROM messages');
        expect(query).toContain("interaction_style = 'blog'");
        return FIXTURE_OK;
      },
    });

    const result = await searchBlogPosts({ sinceIso: '2026-05-01T00:00:00.000Z', pageSize: 50 });
    expect(result.posts).toHaveLength(3);
    expect(result.posts[0].message_id).toBe('13412493');
    expect(result.nextPageToken).toBeNull();
    expect(result.totalReturned).toBe(3);
  });

  it('interpolates sinceIso into the WHERE clause when provided', async () => {
    let capturedQuery;
    _setMockTransport({
      async call(query) {
        capturedQuery = query;
        return { status: 'success', data: { items: [], next_cursor: null } };
      },
    });

    await searchBlogPosts({ sinceIso: '2026-01-01T00:00:00.000Z' });
    expect(capturedQuery).toContain("post_time > '2026-01-01T00:00:00.000Z'");
  });

  it('drops the post_time WHERE clause when sinceIso is null (backfill mode)', async () => {
    let capturedQuery;
    _setMockTransport({
      async call(query) {
        capturedQuery = query;
        return { status: 'success', data: { items: [], next_cursor: null } };
      },
    });

    await searchBlogPosts({ sinceIso: null });
    expect(capturedQuery).not.toContain('post_time >');
    expect(capturedQuery).toContain("interaction_style = 'blog'");
  });

  it('validator throws when a row is missing message_id', async () => {
    _setMockTransport({
      async call() {
        return {
          status: 'success',
          data: {
            items: [{ subject: 'No ID', body: 'x', post_time: 't', view_href: 'u',
                      board: { id: 'b' }, author: { login: 'a' } }],
            next_cursor: null,
          },
        };
      },
    });

    await expect(searchBlogPosts({ sinceIso: null })).rejects.toThrow(/message_id/);
  });

  it('caches successive calls with the same params (in-process Map)', async () => {
    let callCount = 0;
    _setMockTransport({
      async call() {
        callCount++;
        return FIXTURE_OK;
      },
    });

    await searchBlogPosts({ sinceIso: '2026-05-01T00:00:00.000Z', pageSize: 50 });
    await searchBlogPosts({ sinceIso: '2026-05-01T00:00:00.000Z', pageSize: 50 });
    expect(callCount).toBe(1);  // 2nd call served from cache
  });

  it('cache: false bypasses cache (backfill mode)', async () => {
    let callCount = 0;
    _setMockTransport({
      async call() {
        callCount++;
        return FIXTURE_OK;
      },
    });

    await searchBlogPosts({ sinceIso: '2026-05-01T00:00:00.000Z', cache: false });
    await searchBlogPosts({ sinceIso: '2026-05-01T00:00:00.000Z', cache: false });
    expect(callCount).toBe(2);  // both calls hit transport
  });

  it('respects limit: truncates response.data.items to the requested count', async () => {
    _setMockTransport({
      async call() {
        return {
          status: 'success',
          data: {
            items: FIXTURE_OK.data.items,  // 3 rows
            next_cursor: null,
          },
        };
      },
    });
    const result = await searchBlogPosts({ sinceIso: null, limit: 2 });
    expect(result.posts).toHaveLength(2);
    expect(result.totalReturned).toBe(2);
  });
});
