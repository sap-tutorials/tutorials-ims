// test/unit/community-blogs-cds-assert.test.js
//
// (#1033) Guards the @assert.unique constraints on CommunityBlogSources
// and CommunityBlogPosts. Per the memory rule, @assert.unique is enforced
// at the CAP service layer — a raw db.run() on the underlying entity
// bypasses the check and would give a false green. This test drives the
// AdminService projection via admin.tx() with an Admin user, matching
// the pattern in admin-homepage-crud.test.js.

import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

cds.test('serve', '--project', '.', '--in-memory');

const ADMIN_USER = { id: 'admin@test', roles: ['Admin'] };

describe('CommunityBlogSources / CommunityBlogPosts @assert.unique', () => {
  let admin, db;
  beforeAll(async () => {
    admin = await cds.connect.to('AdminService');
    db    = await cds.connect.to('db');
  });

  it('seeds 3 CommunityBlogSources from CSV', async () => {
    const rows = await admin.tx({ user: ADMIN_USER }, tx =>
      tx.read('CommunityBlogSources')
    );
    expect(rows.length).toBeGreaterThanOrEqual(3);
    const slugs = new Set(rows.map(r => r.topicSlug));
    expect(slugs.has('community-technology')).toBe(true);
  });

  it('rejects a duplicate CommunityBlogSources.label via the service layer', async () => {
    await expect(
      admin.tx({ user: ADMIN_USER }, tx =>
        tx.create('CommunityBlogSources').entries({
          ID: '00000000-0000-0000-0000-000000c8ffff',
          label: 'Community — Technology (all blogs)',
          feedUrl: 'https://example.com/other',
        })
      )
    ).rejects.toThrow();
  });

  it('rejects a duplicate CommunityBlogSources.feedUrl via the service layer', async () => {
    await expect(
      admin.tx({ user: ADMIN_USER }, tx =>
        tx.create('CommunityBlogSources').entries({
          ID: '00000000-0000-0000-0000-000000c8fffe',
          label: 'Something new for feedUrl test',
          feedUrl: 'https://community.sap.com/khhcw49343/rss/Community?interaction.style=blog',
        })
      )
    ).rejects.toThrow();
  });

  it('rejects a duplicate CommunityBlogPosts.sourceUrl via the service layer', async () => {
    // First insert succeeds
    await admin.tx({ user: ADMIN_USER }, tx =>
      tx.create('CommunityBlogPosts').entries({
        ID: '00000000-0000-0000-0000-000000cbaaaa',
        sourceUrl: 'https://community.sap.com/t5/technology-blogs-by-sap/example/ba-p/1',
        title: 'Example post',
      })
    );
    // Second insert with the same sourceUrl must fail
    await expect(
      admin.tx({ user: ADMIN_USER }, tx =>
        tx.create('CommunityBlogPosts').entries({
          ID: '00000000-0000-0000-0000-000000cbaabb',
          sourceUrl: 'https://community.sap.com/t5/technology-blogs-by-sap/example/ba-p/1',
          title: 'Duplicate URL post',
        })
      )
    ).rejects.toThrow();
  });

  it('defaults CommunityBlogPosts.aiVerdict to PENDING and attemptCount to 0', async () => {
    const { CommunityBlogPosts } = cds.entities('com.sap.developers.ims');
    const ID = '00000000-0000-0000-0000-000000cbcccc';
    await db.run(INSERT.into(CommunityBlogPosts).entries({
      ID,
      sourceUrl: 'https://community.sap.com/example/other-1',
      title: 'Defaults test',
    }));
    const row = await db.run(SELECT.one.from(CommunityBlogPosts).where({ ID }));
    expect(row.aiVerdict).toBe('PENDING');
    expect(row.attemptCount).toBe(0);
    // SQLite stores booleans as 0/1 — coerce for a stable assertion
    expect(!!row.pinned).toBe(false);
  });
});
