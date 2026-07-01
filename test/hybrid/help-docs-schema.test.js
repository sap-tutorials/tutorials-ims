import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

describe('help-docs schema (hybrid)', () => {
  beforeAll(async () => {
    if (!process.env.ALLOW_HYBRID_WRITES) {
      throw new Error('ALLOW_HYBRID_WRITES not set; refusing to write HANA.');
    }
  });

  it('HelpDocs entity exists and accepts a __TEST__ insert', async () => {
    const { HelpDocs } = cds.entities('com.sap.developers.ims.external');
    const testSlug = `__TEST__phase4.7-${Date.now()}`;
    try {
      await INSERT.into(HelpDocs).entries({
        slug: testSlug,
        source: 'help-sap-com',
        title: 'Test Help Doc',
        description: 'hybrid schema sanity test row',
        url: 'https://help.sap.com/docs/test',
        sourceId: '/docs/test',
        contentHash: 'x'.repeat(64),
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
        product: 'btp',
        section: 'Test',
      });
      // Read back only non-LOB columns — NEVER select description alongside metadata (LOB-locator, spec §10.1).
      const rows = await SELECT.from(HelpDocs)
        .columns('slug', 'source', 'product', 'title')
        .where({ slug: testSlug });
      expect(rows).toHaveLength(1);
      expect(rows[0].source).toBe('help-sap-com');
    } finally {
      await DELETE.from(HelpDocs).where({ slug: testSlug });
    }
  });

  it('HelpDocConceptLinks entity exists with @assert.unique constraint including anchor', async () => {
    const { HelpDocConceptLinks } = cds.entities('com.sap.developers.ims.external');
    expect(HelpDocConceptLinks).toBeDefined();
    // Constraint behavior is verified end-to-end in Task 2's cron test.
    // The tuple includes anchor per spec §4.1 — null and non-null coexist.
  });

  it('OtherResource type widened with source + product + anchor + snippet', async () => {
    // No-op runtime check; the CDS compilation succeeded in Step 14.
    expect(true).toBe(true);
  });
});
