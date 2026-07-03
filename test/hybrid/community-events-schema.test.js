// test/hybrid/community-events-schema.test.js
// Phase 4.8 (#765): schema sanity — verify CommunityEvents + CommunityEventConceptLinks
// entities exist in HANA after MTA deploy.
import { describe, it, expect } from 'vitest';
import cds from '@sap/cds';

describe('CommunityEvents schema (hybrid)', () => {
  it('CommunityEvents entity is resolvable', async () => {
    const db = cds.db ?? await cds.connect.to('db');
    const { CommunityEvents } = cds.entities('com.sap.developers.ims.external');
    expect(CommunityEvents).toBeDefined();
    // Metadata-only SELECT — description is LargeString (NCLOB), do not include.
    const row = await SELECT.one.from(CommunityEvents).columns('slug', 'eventType', 'title');
    // Empty table is fine; the query resolving is the sanity check.
    if (row) {
      expect(typeof row.slug).toBe('string');
    }
  });

  it('CommunityEventConceptLinks entity is resolvable', async () => {
    const { CommunityEventConceptLinks } = cds.entities('com.sap.developers.ims.external');
    expect(CommunityEventConceptLinks).toBeDefined();
  });
});
