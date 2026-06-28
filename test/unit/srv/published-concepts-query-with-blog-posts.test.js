// test/unit/srv/published-concepts-query-with-blog-posts.test.js
//
// Phase 4.2 (#447): buildConceptsPayload extends per-concept payload
// with blogPosts[] — populated, empty, and per-concept-empty shapes.

import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';
import { buildConceptsPayload } from '../../../srv/lib/published-concepts-query.js';

describe('buildConceptsPayload — blogPosts field', () => {
  beforeAll(async () => {
    await cds.deploy([
      path.join(process.cwd(), 'db'),
      path.join(process.cwd(), 'srv'),
    ]).to('sqlite::memory:');

    const { Concepts } = cds.entities('com.sap.developers.ims');
    const { BlogPosts, BlogPostConceptLinks } = cds.entities('com.sap.developers.ims.external');

    const now = new Date().toISOString();
    await INSERT.into(Concepts).entries([
      { slug: 'cap-handlers', name: 'CAP handlers', description: 'd',
        status: 'ACTIVE', publishedAt: now, publishedBy: 'a@b.c' },
      { slug: 'no-blog', name: 'No Blog', description: 'd',
        status: 'ACTIVE', publishedAt: now, publishedBy: 'a@b.c' },
    ]);
    const conceptRow = await SELECT.one.from(Concepts).columns('ID').where({ slug: 'cap-handlers' });

    await INSERT.into(BlogPosts).entries({
      slug: 'bp-99999', title: 'A Post', url: 'https://example.com/p',
      khorosMessageId: '99999', postedAt: '2026-05-15T00:00:00Z',
      authorLogin: 'a.user', authorName: 'A User', authorAvatarUrl: 'https://example.com/av.png',
    });
    const postRow = await SELECT.one.from(BlogPosts).columns('ID').where({ slug: 'bp-99999' });
    await INSERT.into(BlogPostConceptLinks).entries({
      post_ID: postRow.ID, concept_ID: conceptRow.ID,
      predicate: 'discusses', confidence: 0.9,
    });
  });

  afterAll(async () => { await cds.disconnect(); });

  it('every concept has a blogPosts array (empty when none)', async () => {
    const payload = await buildConceptsPayload(cds.db);
    for (const c of payload.concepts) {
      expect(Array.isArray(c.blogPosts)).toBe(true);
    }
  });

  it('populates blogPosts with joined row shape', async () => {
    const payload = await buildConceptsPayload(cds.db);
    const ch = payload.concepts.find(c => c.slug === 'cap-handlers');
    expect(ch.blogPosts).toHaveLength(1);
    expect(ch.blogPosts[0]).toMatchObject({
      slug: 'bp-99999',
      title: 'A Post',
      url: 'https://example.com/p',
      authorName: 'A User',
    });
  });

  it('returns empty blogPosts[] for concepts with no linked posts', async () => {
    const payload = await buildConceptsPayload(cds.db);
    const nb = payload.concepts.find(c => c.slug === 'no-blog');
    expect(nb.blogPosts).toEqual([]);
  });
});
