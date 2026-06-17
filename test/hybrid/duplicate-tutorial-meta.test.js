import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

// Hybrid-only — see beforeAll guard. Mirrors duplicate-slugs.test.js.
describe('TutorialMeta singleton invariant (follow-up to PR #386)', () => {
  let db;

  beforeAll(async () => {
    db = await cds.connect.to('db');
    const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
    if (!isHana) {
      throw new Error(
        'duplicate-tutorial-meta.test.js must run against HANA. ' +
        'Run via `npm run test:hybrid` after `cds bind` to the DEV space.'
      );
    }
  });

  it('TutorialMeta has at most one row per tutorial', async () => {
    const dups = await db.run(`
      SELECT "TUTORIAL_ID", COUNT(*) AS C
        FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALMETA"
       WHERE "TUTORIAL_ID" IS NOT NULL
       GROUP BY "TUTORIAL_ID"
      HAVING COUNT(*) > 1
       ORDER BY C DESC
    `);
    if (dups.length > 0) {
      const sample = dups.slice(0, 5).map(r => `  ${r.TUTORIAL_ID} → ${r.C} rows`).join('\n');
      throw new Error(
        `Found ${dups.length} tutorial(s) with > 1 TutorialMeta row. Sample:\n${sample}\n` +
        `Run: npx cds bind --exec -- node scripts/dedupe-tutorial-meta.cjs --commit`
      );
    }
    expect(dups.length).toBe(0);
  });
});
