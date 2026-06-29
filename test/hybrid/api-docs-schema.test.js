// test/hybrid/api-docs-schema.test.js
//
// Phase 4.5 (#746) Task 1: hybrid schema sanity check.
//
// BLOCKED-until-deploy. Validates that ApiDocs + ApiDocConceptLinks +
// JobLastRun entities deploy cleanly to HANA. Runs only when
// ALLOW_HYBRID_WRITES=true; uses __TEST__ prefix + cleanup in finally.

import { describe, it, beforeAll, expect } from 'vitest';
import cds from '@sap/cds';

describe('api-docs schema (hybrid)', () => {
  beforeAll(() => {
    if (!process.env.ALLOW_HYBRID_WRITES) {
      throw new Error('ALLOW_HYBRID_WRITES not set; refusing to write HANA.');
    }
  });

  it('ApiDocs entity exists and accepts a __TEST__ insert', async () => {
    const { ApiDocs } = cds.entities('com.sap.developers.ims.external');
    const testSlug = `__TEST__phase4.5-${Date.now()}`;
    try {
      await INSERT.into(ApiDocs).entries({
        slug: testSlug,
        title: 'Test API',
        description: 'hybrid schema sanity test row',
        url: 'https://api.sap.com/test',
        sourceId: 'TEST',
        contentHash: 'x'.repeat(64),
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
        category: 'Test',
        apiType: 'rest',
      });
      // Don't SELECT description alongside scalars — LOB-locator (§10.1).
      const rows = await SELECT.from(ApiDocs)
        .columns('ID', 'slug', 'title', 'category', 'apiType')
        .where({ slug: testSlug });
      expect(rows).toHaveLength(1);
      expect(rows[0].category).toBe('Test');
      expect(rows[0].apiType).toBe('rest');
    } finally {
      await DELETE.from(ApiDocs).where({ slug: testSlug });
    }
  });

  it('ApiDocConceptLinks entity is reachable from the runtime', async () => {
    const { ApiDocConceptLinks } = cds.entities('com.sap.developers.ims.external');
    expect(ApiDocConceptLinks).toBeDefined();
    // Constraint behavior is verified end-to-end in Task 2's cron test.
    // This case just asserts the entity is reachable — count query proves it
    // deployed to HANA.
    const rows = await SELECT.from(ApiDocConceptLinks).columns('count(*) as n');
    expect(rows?.[0]?.n ?? 0).toBeGreaterThanOrEqual(0);
  });

  it('JobLastRun entity exists in main namespace', async () => {
    const { JobLastRun } = cds.entities('com.sap.developers.ims');
    expect(JobLastRun).toBeDefined();
    const rows = await SELECT.from(JobLastRun).columns('count(*) as n');
    expect(rows?.[0]?.n ?? 0).toBeGreaterThanOrEqual(0);
  });
});
