// test/unit/srv/fetch-blog-posts-job.test.js
//
// #447 Phase 4.2 PR-2: end-to-end cron orchestration test.
// In-memory SQLite + mocked Khoros + mocked LLM + mocked embed.

import { describe, it, beforeAll, afterAll, beforeEach, expect, vi } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';

let runFetchBlogPosts;
let _setMockTransport;
let _resetCache;

function vec(...nums) { return new Float32Array(nums); }
function buf(...nums) {
  const f = vec(...nums);
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength);
}

describe('fetch-blog-posts-job — merge-on-write (#707) + crash-safety (#708)', () => {
  beforeAll(async () => {
    await cds.deploy([
      path.join(process.cwd(), 'db'),
      path.join(process.cwd(), 'srv'),
    ]).to('sqlite::memory:');

    ({ runFetchBlogPosts } = await import('../../../srv/jobs/fetch-blog-posts-job.js'));
    ({ _setMockTransport, _resetCache } = await import('../../../srv/lib/khoros-blogs-client.js'));
  });

  afterAll(async () => {
    await cds.disconnect();
  });

  beforeEach(async () => {
    const { Concepts } = cds.entities('com.sap.developers.ims');
    const { BlogPosts, BlogPostConceptLinks } = cds.entities('com.sap.developers.ims.external');
    await DELETE.from(BlogPostConceptLinks);
    await DELETE.from(BlogPosts);
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

    _setMockTransport(null);  // reset transport between tests; otherwise prior mock leaks
    _resetCache();
  });

  it('aborts cleanly when MAX(postedAt) is null and no rows exist', async () => {
    _setMockTransport({
      async call() { throw new Error('should not be reached'); },
    });
    const embed = vi.fn();
    const extractFn = vi.fn();

    const summary = await runFetchBlogPosts({ embed, extractFn });
    expect(summary.errors).toBeGreaterThan(0);
    expect(summary.fetched).toBe(0);
    expect(extractFn).not.toHaveBeenCalled();
  });

  it('processes a single new post end-to-end (exact-match concept)', async () => {
    // Seed an existing blog post so sinceIso = its postedAt (avoids abort).
    const { BlogPosts } = cds.entities('com.sap.developers.ims.external');
    await INSERT.into(BlogPosts).entries({
      slug: 'bp-99999',
      title: 'Previously Indexed',
      url: 'https://community.sap.com/t5/blog/old/ba-p/99999',
      khorosMessageId: '99999',
      postedAt: '2026-05-01T00:00:00.000Z',
      sourceId: '99999',
      contentHash: 'OLD',
      lastExtractedHash: 'OLD',
    });

    _setMockTransport({
      async call(query) {
        return {
          status: 'success',
          data: {
            items: [{
              message_id: '13412493',
              subject: 'New Post About CAP Handlers',
              body: 'A post discussing CAP handlers in depth.',
              post_time: '2026-05-15T09:32:11.000Z',
              view_href: 'https://community.sap.com/t5/blog/new/ba-p/13412493',
              board: { id: 'blog' },
              author: {
                login: 'test.author',
                first_name: 'Test',
                last_name: 'Author',
                avatar: { profile: 'https://community.sap.com/avatar.png' },
              },
            }],
            next_cursor: null,
          },
        };
      },
    });

    const extractFn = vi.fn().mockResolvedValue({
      discusses: [{ slug: 'cap-handlers', name: 'CAP handlers', confidence: 0.9 }],
      tokenUsage: { prompt: 100, completion: 50 },
    });

    const embed = vi.fn();

    const summary = await runFetchBlogPosts({ embed, extractFn });

    expect(summary.fetched).toBe(1);
    expect(summary.upserted).toBe(1);
    expect(summary.extracted).toBe(1);
    expect(summary.discussesWritten).toBe(1);
    expect(summary.errors).toBe(0);
    expect(embed).not.toHaveBeenCalled();  // exact-match doesn't embed
  });

  it('merges + mints novel concepts via #707 helper, dedups by conceptId', async () => {
    const { BlogPosts } = cds.entities('com.sap.developers.ims.external');
    await INSERT.into(BlogPosts).entries({
      slug: 'bp-99999',
      title: 'Seed',
      url: 'u', khorosMessageId: '99999',
      postedAt: '2026-05-01T00:00:00.000Z',
      sourceId: '99999', contentHash: 'OLD', lastExtractedHash: 'OLD',
    });

    _setMockTransport({
      async call() {
        return {
          status: 'success',
          data: {
            items: [{
              message_id: '13412493',
              subject: 'New Post', body: 'Body', post_time: '2026-05-15T09:32:11.000Z',
              view_href: 'u', board: { id: 'b' },
              author: { login: 'a', first_name: 'A', last_name: 'B', avatar: { profile: '' } },
            }],
            next_cursor: null,
          },
        };
      },
    });

    const extractFn = vi.fn().mockResolvedValue({
      discusses: [
        { slug: 'cap-handlers', name: 'CAP handlers', confidence: 0.9 },           // exact
        { slug: 'cap-event-handlers', name: 'CAP event handlers', confidence: 0.85 }, // near-dup
        { slug: 'odata-v4', name: 'OData v4', confidence: 0.8 },                     // novel mint
      ],
      tokenUsage: { prompt: 100, completion: 50 },
    });

    const embed = vi.fn(async ([name]) => {
      if (name === 'CAP event handlers') return [vec(0.99, 0.01, 0, 0)];
      if (name === 'OData v4') return [vec(0, 0, 1, 0)];
      throw new Error(`unexpected embed: ${name}`);
    });

    const summary = await runFetchBlogPosts({ embed, extractFn });

    expect(summary.mergedAtExtract).toBe(1);
    expect(summary.mintedAtExtract).toBe(1);
    expect(summary.discussesWritten).toBe(2);  // dedup: cap-handlers (exact + merged) collapses
  });

  it('skips re-extraction when lastExtractedHash matches new contentHash', async () => {
    const { BlogPosts } = cds.entities('com.sap.developers.ims.external');
    // The mock returns the same body that will produce the same contentHash.
    // We pre-seed an UPSERT-equivalent row.
    const subject = 'Cached Post';
    const body = 'Cached body content.';
    const postTime = '2026-05-15T09:32:11.000Z';
    // contentHash = sha256(subject + body + post_time) — implementation should match.
    // We can't predict the exact hash here; instead we run twice and assert
    // the second run has skippedNoChange > 0.

    _setMockTransport({
      async call() {
        return {
          status: 'success',
          data: {
            items: [{
              message_id: '99988', subject, body, post_time: postTime,
              view_href: 'u', board: { id: 'b' },
              author: { login: 'a', first_name: 'A', last_name: 'B', avatar: { profile: '' } },
            }],
            next_cursor: null,
          },
        };
      },
    });

    // Seed a sentinel so sinceIso is set.
    await INSERT.into(BlogPosts).entries({
      slug: 'bp-99999', title: 'Seed', url: 'u', khorosMessageId: '99999',
      postedAt: '2026-04-01T00:00:00.000Z', sourceId: '99999',
      contentHash: 'X', lastExtractedHash: 'X',
    });

    const extractFn = vi.fn().mockResolvedValue({
      discusses: [{ slug: 'cap-handlers', name: 'CAP handlers', confidence: 0.9 }],
      tokenUsage: { prompt: 100, completion: 50 },
    });
    const embed = vi.fn();

    await runFetchBlogPosts({ embed, extractFn });  // first run extracts
    _resetCache();
    const summary2 = await runFetchBlogPosts({ embed, extractFn });

    expect(summary2.skippedNoChange).toBeGreaterThanOrEqual(1);
  });

  it('respects budget gate: stops after N extractions; budgetExhausted=true', async () => {
    const { BlogPosts } = cds.entities('com.sap.developers.ims.external');
    await INSERT.into(BlogPosts).entries({
      slug: 'bp-99999', title: 'Seed', url: 'u', khorosMessageId: '99999',
      postedAt: '2026-04-01T00:00:00.000Z', sourceId: '99999',
      contentHash: 'X', lastExtractedHash: 'X',
    });

    // Khoros returns 3 new posts; budget = 2 (injected via deps.budgetOverride).
    _setMockTransport({
      async call() {
        return {
          status: 'success',
          data: {
            items: [1, 2, 3].map(i => ({
              message_id: `1340000${i}`,
              subject: `Post ${i}`, body: `Body ${i}`, post_time: `2026-05-${10 + i}T00:00:00.000Z`,
              view_href: 'u', board: { id: 'b' },
              author: { login: 'a', first_name: 'A', last_name: 'B', avatar: { profile: '' } },
            })),
            next_cursor: null,
          },
        };
      },
    });

    const extractFn = vi.fn().mockResolvedValue({
      discusses: [{ slug: 'cap-handlers', name: 'CAP handlers', confidence: 0.9 }],
      tokenUsage: { prompt: 100, completion: 50 },
    });
    const embed = vi.fn();

    // Inject the budget directly. We don't seed ChatSettings here because
    // (a) ChatSettings.blogPostExtractBudgetPerDay doesn't exist as a column
    //     — the cron's try/catch falls back to DEFAULT_BUDGET (50);
    // (b) Phase 4.1's cron uses the same idiom (no column added to schema).
    // The test seam is a `budgetOverride` parameter on runFetchBlogPosts (see
    // §2.2 Step 9 implementation).
    const summary = await runFetchBlogPosts({ embed, extractFn, budgetOverride: 2 });

    expect(summary.extracted).toBe(2);
    expect(summary.budgetExhausted).toBe(true);
  });
});
