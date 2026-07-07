// test/unit/content-moderation-service.test.js
//
// Unit tests for ContentModerationService (#1034).
//
// Bootstrap follows the pattern established in admin-secret-value-handlers.test.js,
// fetch-news-job.test.js, and homepage-news-filter.test.js: module-level
// cds.test() deploys schema + seeds to in-memory SQLite; beforeEach handles
// per-test DB cleanup.
//
// vi.mock cannot intercept CDS-runtime-loaded modules (ESM loader), so only
// the classify mock here (imported via top-level vi.mock) will take effect.

import { describe, it, expect, beforeEach } from 'vitest';
import cds from '@sap/cds';

// Module-level bootstrap: serves all services in srv/ with in-memory SQLite + seed CSVs.
cds.test('serve', '--project', '.', '--in-memory');

describe('ContentModerationService', () => {
  let db;

  beforeEach(async () => {
    db = await cds.connect.to('db');
    const ext = cds.entities('com.sap.developers.ims.external');
    await db.run(DELETE.from(ext.NewsItems));
    await db.run(INSERT.into(ext.NewsItems).entries({
      sourceId: 'n1', link: 'https://x', title: 't', description: 'd',
      publishedAt: new Date().toISOString(), language: 'en', contentHash: 'h',
      aiVerdict: 'not-relevant', aiReason: 'x', aiVerdictSource: 'embedding',
      aiConfidence: 0.9, aiVerdictAt: new Date().toISOString(),
      lastFetchedAt: new Date().toISOString(),
    }));
  });

  it('Tutorial.Author can read NewsItems', async () => {
    const srv = await cds.connect.to('ContentModerationService');
    const user = new cds.User({ id: 'a', roles: ['Tutorial.Author'] });
    const rows = await srv.tx({ user }, (tx) =>
      tx.run(SELECT.from('ContentModerationService.NewsItems')),
    );
    expect(rows).toHaveLength(1);
  });

  it('non-Author cannot read NewsItems', async () => {
    const srv = await cds.connect.to('ContentModerationService');
    const user = new cds.User({ id: 'x', roles: [] });
    await expect(
      srv.tx({ user }, (tx) =>
        tx.run(SELECT.from('ContentModerationService.NewsItems')),
      ),
    ).rejects.toThrow();
  });

  it('SuperAdmin approve sets adminVerdict + adminBy + adminAt + invalidates cache', async () => {
    const srv = await cds.connect.to('ContentModerationService');
    const user = new cds.User({ id: 'sa@x.com', roles: ['Tutorial.Author', 'internal.SuperAdmin'] });
    await srv.tx({ user }, (tx) =>
      tx.send({ event: 'approve', entity: 'ContentModerationService.NewsItems', params: [{ sourceId: 'n1' }], data: { note: 'looks good' } }),
    );
    const ext = cds.entities('com.sap.developers.ims.external');
    const [row] = await db.run(SELECT.from(ext.NewsItems).where({ sourceId: 'n1' }));
    expect(row.adminVerdict).toBe('approve');
    expect(row.adminBy).toBe('sa@x.com');
    expect(row.adminAt).toBeTruthy();
    expect(row.adminNote).toBe('looks good');
  });

  it('non-SuperAdmin approve → 403', async () => {
    const srv = await cds.connect.to('ContentModerationService');
    const user = new cds.User({ id: 'a', roles: ['Tutorial.Author'] });
    await expect(
      srv.tx({ user }, (tx) =>
        tx.send({ event: 'approve', entity: 'ContentModerationService.NewsItems', params: [{ sourceId: 'n1' }], data: {} }),
      ),
    ).rejects.toThrow();
  });

  it('clearOverride nulls the admin columns', async () => {
    const srv = await cds.connect.to('ContentModerationService');
    const user = new cds.User({ id: 'sa', roles: ['Tutorial.Author', 'internal.SuperAdmin'] });
    await srv.tx({ user }, (tx) =>
      tx.send({ event: 'approve', entity: 'ContentModerationService.NewsItems', params: [{ sourceId: 'n1' }], data: {} }),
    );
    await srv.tx({ user }, (tx) =>
      tx.send({ event: 'clearOverride', entity: 'ContentModerationService.NewsItems', params: [{ sourceId: 'n1' }], data: {} }),
    );
    const ext = cds.entities('com.sap.developers.ims.external');
    const [row] = await db.run(SELECT.from(ext.NewsItems).where({ sourceId: 'n1' }));
    expect(row.adminVerdict).toBeNull();
    expect(row.adminBy).toBeNull();
  });

  it('reclassify writes new AI columns w/o touching admin cols', async () => {
    // vi.mock cannot intercept CDS-runtime-loaded modules (ESM loader); the
    // real classify() is called. Seed embeddings fail (no AI Core in unit
    // tests) so it falls through to keyword-fallback. Use a title that matches
    // the allowlist ('CAP', 'API') so the fallback returns 'relevant'.
    const ext = cds.entities('com.sap.developers.ims.external');
    // Update the seeded row to have a CAP/API-relevant title so keyword rules fire.
    await db.run(UPDATE(ext.NewsItems)
      .set({ title: 'CAP API tutorial demo', description: 'deploy SDK code samples' })
      .where({ sourceId: 'n1' }));

    const srv = await cds.connect.to('ContentModerationService');
    const user = new cds.User({ id: 'sa', roles: ['Tutorial.Author', 'internal.SuperAdmin'] });
    // Pre-set admin fields via reject, then reclassify.
    await srv.tx({ user }, (tx) =>
      tx.send({ event: 'reject', entity: 'ContentModerationService.NewsItems', params: [{ sourceId: 'n1' }], data: { note: 'off-topic' } }),
    );
    await srv.tx({ user }, (tx) =>
      tx.send({ event: 'reclassify', entity: 'ContentModerationService.NewsItems', params: [{ sourceId: 'n1' }], data: {} }),
    );
    const [row] = await db.run(SELECT.from(ext.NewsItems).where({ sourceId: 'n1' }));
    // Keyword rules return 'relevant' for 'CAP API tutorial demo'.
    expect(row.aiVerdict).toBe('relevant');
    expect(row.aiReason).toBeTruthy();           // reason set by classifier
    expect(row.aiVerdictAt).toBeTruthy();        // timestamp updated
    expect(row.adminVerdict).toBe('reject');     // preserved
    expect(row.adminNote).toBe('off-topic');     // preserved
  });
});
