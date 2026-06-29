import { describe, it, beforeAll, expect } from 'vitest';
import cds from '@sap/cds';

describe('Videos schema (hybrid)', () => {
  beforeAll(() => {
    if (!process.env.ALLOW_HYBRID_WRITES) {
      throw new Error('ALLOW_HYBRID_WRITES not set; refusing to read HANA.');
    }
  });

  it('Videos table exists and is queryable', async () => {
    const { Videos } = cds.entities('com.sap.developers.ims.external');
    const rows = await SELECT.from(Videos).columns('count(*) as n');
    expect(rows?.[0]?.n ?? 0).toBeGreaterThanOrEqual(0);
  });

  it('VideoConceptLinks table exists and is queryable', async () => {
    const { VideoConceptLinks } = cds.entities('com.sap.developers.ims.external');
    const rows = await SELECT.from(VideoConceptLinks).columns('count(*) as n');
    expect(rows?.[0]?.n ?? 0).toBeGreaterThanOrEqual(0);
  });

  it('VideoServices table exists and is queryable', async () => {
    const { VideoServices } = cds.entities('com.sap.developers.ims.external');
    const rows = await SELECT.from(VideoServices).columns('count(*) as n');
    expect(rows?.[0]?.n ?? 0).toBeGreaterThanOrEqual(0);
  });
});
