/**
 * Hybrid-qa schema deploy probe.
 *
 * Verifies the four QA entities exist as physical HANA tables and respond
 * to a COUNT(*) query. Runs against the `tutorials-db-qa` HDI binding
 * routed via the `cds_requires_db_credentials_target` env var set in the
 * vitest project.
 *
 * Read-only — no writes, no guard interactions.
 */

import cds from '@sap/cds/lib';
import { describe, it, expect } from 'vitest';

describe('hybrid-qa schema deploy', () => {
  it('all four entities exist and are queryable', async () => {
    const db = await cds.connect.to('db');
    for (const name of ['ContentFiles', 'ContentManifest', 'TutorialBodyText', 'RepoCatalog']) {
      const r = await db.run(
        `SELECT COUNT(*) AS C FROM "COM_SAP_DEVELOPERS_IMS_QA_${name.toUpperCase()}"`
      );
      expect(r[0].C).toBeGreaterThanOrEqual(0);
    }
  });
});
