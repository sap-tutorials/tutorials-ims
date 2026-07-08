// test/unit/homepage-service-communityBlogs.test.js
//
// (#1033) Guards the rewritten communityBlogs() handler selection logic:
//   - pinned rows come first
//   - adminOverride=ALLOW beats aiVerdict=NOT_RELEVANT
//   - adminOverride=BLOCK beats aiVerdict=DEVELOPER_RELEVANT
//   - degraded padding when approved pool <3
//   - BLOCK still wins in degraded mode
//   - empty DB returns []

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import cds from '@sap/cds';
import { _resetForTests } from '../../srv/homepage-service.js';

cds.test('serve', '--project', '.', '--in-memory');

describe('HomepageService.communityBlogs() — DB-backed selection', () => {
  let homepage, db, CommunityBlogPosts, sourceId;

  beforeAll(async () => {
    homepage = await cds.connect.to('HomepageService');
    db = await cds.connect.to('db');
    CommunityBlogPosts = cds.entities('com.sap.developers.ims').CommunityBlogPosts;
    const src = await db.run(
      SELECT.one.from(cds.entities('com.sap.developers.ims').CommunityBlogSources)
        .where({ topicSlug: 'community-technology' })
    );
    sourceId = src.ID;
  });

  beforeEach(async () => {
    _resetForTests();
    await db.run(DELETE.from(CommunityBlogPosts));
  });

  async function seed(rows) {
    await db.run(INSERT.into(CommunityBlogPosts).entries(
      rows.map((r, i) => ({
        ID:          `00000000-0000-0000-0000-000000cb${(0xa000 + i).toString(16)}`,
        sourceUrl:   r.url,
        sourceId_ID: sourceId,
        title:       r.title,
        author:      r.author ?? 'Anon',
        publishedAt: r.publishedAt,
        aiVerdict:   r.aiVerdict ?? 'PENDING',
        adminOverride: r.adminOverride ?? null,
        pinned:      r.pinned ?? false,
        linkStatus:  r.linkStatus ?? 'OK',
      }))
    ));
  }

  it('returns [] when the table is empty', async () => {
    const result = await homepage.send('communityBlogs');
    expect(result).toEqual([]);
  });

  it('surfaces pinned rows first', async () => {
    await seed([
      { url: 'https://x/a', title: 'A newer', publishedAt: '2026-07-05T12:00:00Z', aiVerdict: 'DEVELOPER_RELEVANT' },
      { url: 'https://x/b', title: 'B pinned', publishedAt: '2026-07-01T12:00:00Z', aiVerdict: 'NOT_RELEVANT', pinned: true },
      { url: 'https://x/c', title: 'C DR',    publishedAt: '2026-07-03T12:00:00Z', aiVerdict: 'DEVELOPER_RELEVANT' },
    ]);
    const result = await homepage.send('communityBlogs');
    expect(result[0].title).toBe('B pinned');
  });

  it('adminOverride=ALLOW promotes a NOT_RELEVANT row', async () => {
    await seed([
      { url: 'https://x/a', title: 'A allowed',     publishedAt: '2026-07-05T12:00:00Z', aiVerdict: 'NOT_RELEVANT', adminOverride: 'ALLOW' },
      { url: 'https://x/b', title: 'B DR',          publishedAt: '2026-07-01T12:00:00Z', aiVerdict: 'DEVELOPER_RELEVANT' },
    ]);
    const result = await homepage.send('communityBlogs');
    expect(result.map(r => r.title)).toContain('A allowed');
  });

  it('adminOverride=BLOCK hides a DEVELOPER_RELEVANT row', async () => {
    await seed([
      { url: 'https://x/a', title: 'A blocked', publishedAt: '2026-07-05T12:00:00Z', aiVerdict: 'DEVELOPER_RELEVANT', adminOverride: 'BLOCK' },
      { url: 'https://x/b', title: 'B DR',      publishedAt: '2026-07-01T12:00:00Z', aiVerdict: 'DEVELOPER_RELEVANT' },
    ]);
    const result = await homepage.send('communityBlogs');
    expect(result.map(r => r.title)).not.toContain('A blocked');
  });

  it('pads from raw candidates when approved pool <3, BLOCK still wins', async () => {
    // 1 approved + 3 raw candidates (1 BLOCK, 2 available)
    await seed([
      { url: 'https://x/a', title: 'A DR',       publishedAt: '2026-07-05T12:00:00Z', aiVerdict: 'DEVELOPER_RELEVANT' },
      { url: 'https://x/b', title: 'B PENDING',  publishedAt: '2026-07-04T12:00:00Z', aiVerdict: 'PENDING' },
      { url: 'https://x/c', title: 'C NOT_REL',  publishedAt: '2026-07-03T12:00:00Z', aiVerdict: 'NOT_RELEVANT' },
      { url: 'https://x/d', title: 'D BLOCKED',  publishedAt: '2026-07-02T12:00:00Z', aiVerdict: 'PENDING', adminOverride: 'BLOCK' },
    ]);
    const result = await homepage.send('communityBlogs');
    expect(result.length).toBe(3);
    const titles = result.map(r => r.title);
    expect(titles).toContain('A DR');
    expect(titles).toContain('B PENDING');
    expect(titles).toContain('C NOT_REL');
    expect(titles).not.toContain('D BLOCKED');
  });

  it('caps output at 3 rows', async () => {
    await seed([
      { url: 'https://x/a', title: 'A', publishedAt: '2026-07-05T12:00:00Z', aiVerdict: 'DEVELOPER_RELEVANT' },
      { url: 'https://x/b', title: 'B', publishedAt: '2026-07-04T12:00:00Z', aiVerdict: 'DEVELOPER_RELEVANT' },
      { url: 'https://x/c', title: 'C', publishedAt: '2026-07-03T12:00:00Z', aiVerdict: 'DEVELOPER_RELEVANT' },
      { url: 'https://x/d', title: 'D', publishedAt: '2026-07-02T12:00:00Z', aiVerdict: 'DEVELOPER_RELEVANT' },
    ]);
    const result = await homepage.send('communityBlogs');
    expect(result.length).toBe(3);
  });

  it('excludes rows with linkStatus=BROKEN', async () => {
    await seed([
      { url: 'https://x/a', title: 'A broken', publishedAt: '2026-07-05T12:00:00Z', aiVerdict: 'DEVELOPER_RELEVANT', linkStatus: 'BROKEN' },
      { url: 'https://x/b', title: 'B OK',     publishedAt: '2026-07-04T12:00:00Z', aiVerdict: 'DEVELOPER_RELEVANT' },
    ]);
    const result = await homepage.send('communityBlogs');
    expect(result.map(r => r.title)).not.toContain('A broken');
  });

  it('returns only { title, url, publishedAt, author } fields', async () => {
    await seed([
      { url: 'https://x/a', title: 'A', publishedAt: '2026-07-05T12:00:00Z', aiVerdict: 'DEVELOPER_RELEVANT' },
    ]);
    const result = await homepage.send('communityBlogs');
    expect(Object.keys(result[0]).sort()).toEqual(['author', 'publishedAt', 'title', 'url']);
  });
});
