// test/unit/community-blogs-apiquery.test.js
//
// (#1144) Guards seed/backfill of apiQuery on CommunityBlogSources managed rows
// and validates that the before(CREATE/UPDATE) handler rejects injection attempts.
//
// Approach for rejection test: service-layer admin.tx() create() call — this
// exercises the before('CREATE','CommunityBlogSources') handler directly without
// the OData draft round-trip, which is fragile in unit tests. CommunityBlogSources
// IS @odata.draft.enabled, so a bare OData PATCH to the active-entity URL would
// not reliably trigger the handler either. The service-layer path is the
// canonical approach used by community-blogs-cds-assert.test.js for the same entity.

import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

cds.test('serve', '--project', '.', '--in-memory');

const ADMIN_USER = { id: 'admin@test', roles: ['Admin'] };

describe('CommunityBlogSources apiQuery', () => {
  let admin;
  beforeAll(async () => {
    admin = await cds.connect.to('AdminService');
  });

  it('managed rows are backfilled with a valid apiQuery after READ', async () => {
    const rows = await admin.tx({ user: ADMIN_USER }, (tx) =>
      tx.read('CommunityBlogSources').where({ managed: true })
    );
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const row of rows) {
      expect(row.apiQuery, `${row.label} apiQuery`).toBeTruthy();
    }
    const sap = rows.find((r) => r.topicSlug === 'technology-sap');
    expect(sap?.apiQuery).toBe("board.id='technology-blog-sap'");
  });

  it('rejects an apiQuery with injection on write', async () => {
    await expect(
      admin.tx({ user: ADMIN_USER }, (tx) =>
        tx.create('CommunityBlogSources').entries({
          ID: '00000000-0000-0000-0000-000000c8fffd',
          label: 'Injection test source',
          feedUrl: 'https://example.com/injection-test',
          apiQuery: 'x=1; DROP',
        })
      )
    ).rejects.toMatchObject({ code: 400 });
  });
});
