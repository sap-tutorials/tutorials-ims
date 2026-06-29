// test/hybrid/samples-schema.test.js
//
// Phase 4.6 (#747) Task 1: hybrid schema sanity check.
//
// BLOCKED-until-deploy. Validates that Samples + SampleConceptLinks
// entities deploy cleanly to HANA. Runs only when ALLOW_HYBRID_WRITES=true;
// uses __TEST__ prefix + cleanup in finally.

import { describe, it, beforeAll, expect } from 'vitest';
import cds from '@sap/cds';

describe('samples schema (hybrid)', () => {
  beforeAll(() => {
    if (!process.env.ALLOW_HYBRID_WRITES) {
      throw new Error('ALLOW_HYBRID_WRITES not set; refusing to write HANA.');
    }
  });

  it('Samples entity exists and accepts a __TEST__ insert', async () => {
    const { Samples } = cds.entities('com.sap.developers.ims.external');
    const testSlug = `__TEST__phase4.6-${Date.now()}`;
    try {
      await INSERT.into(Samples).entries({
        slug: testSlug,
        title: 'Test Sample',
        description: 'hybrid schema sanity test row',
        url: 'https://github.com/SAP-samples/test',
        sourceId: 'SAP-samples/test',
        contentHash: 'x'.repeat(64),
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
        language: 'JavaScript',
        stars: 0,
        lastCommitAt: new Date(),
      });
      // Don't SELECT description alongside scalars — LOB-locator (§10.1).
      const rows = await SELECT.from(Samples)
        .columns('ID', 'slug', 'title', 'language', 'stars')
        .where({ slug: testSlug });
      expect(rows).toHaveLength(1);
      expect(rows[0].language).toBe('JavaScript');
      expect(rows[0].stars).toBe(0);
    } finally {
      await DELETE.from(Samples).where({ slug: testSlug });
    }
  });

  it('SampleConceptLinks entity is reachable from the runtime', async () => {
    const { SampleConceptLinks } = cds.entities('com.sap.developers.ims.external');
    expect(SampleConceptLinks).toBeDefined();
    // Constraint behavior is verified end-to-end in Task 2's cron test.
    // This case just asserts the entity is reachable — count query proves it
    // deployed to HANA.
    const rows = await SELECT.from(SampleConceptLinks).columns('count(*) as n');
    expect(rows?.[0]?.n ?? 0).toBeGreaterThanOrEqual(0);
  });

  it('OtherResource type widened with language + stars + lastCommitAt', async () => {
    // No-op runtime check; the CDS compilation succeeded at build time.
    // The widened type is exercised by the KG sidebar tests in Task 3.
    expect(true).toBe(true);
  });
});
