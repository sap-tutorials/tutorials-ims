import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

// Hybrid-only — see beforeAll guard. Mirrors duplicate-slugs.test.js and
// duplicate-tutorial-meta.test.js: a CI guard that turns red whenever the
// underlying invariant breaks, and back to green only after the dedupe
// migration runs.

describe('Steps stepCount invariant (issue: duplicate Step rows from Java IMS cutover)', () => {
  let db;

  beforeAll(async () => {
    db = await cds.connect.to('db');
    const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
    if (!isHana) {
      throw new Error(
        'duplicate-step-rows.test.js must run against HANA. ' +
        'Run via `npm run test:hybrid` after `cds bind` to the DEV space.'
      );
    }
  });

  it('no Tutorial has more Step rows than its declared stepCount', async () => {
    const overrun = await db.run(`
      SELECT t."SLUG", t."STEPCOUNT", COUNT(s."ID") AS C
        FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALS" t
        JOIN "COM_SAP_DEVELOPERS_IMS_STEPS" s ON s."TUTORIAL_ID" = t."ID"
       WHERE t."STEPCOUNT" IS NOT NULL
         AND t."SLUG" IS NOT NULL
       GROUP BY t."SLUG", t."STEPCOUNT"
      HAVING COUNT(s."ID") > t."STEPCOUNT"
       ORDER BY (COUNT(s."ID") - t."STEPCOUNT") DESC, t."SLUG"
    `);
    if (overrun.length > 0) {
      const sample = overrun.slice(0, 5)
        .map(r => `  ${r.SLUG}: stepCount=${r.STEPCOUNT}, actual=${r.C}`)
        .join('\n');
      throw new Error(
        `Found ${overrun.length} tutorial(s) with more Step rows than stepCount. Sample:\n${sample}\n` +
        `Run: npx cds bind --exec -- node scripts/dedupe-migrated-step-rows.cjs --commit`
      );
    }
    expect(overrun.length).toBe(0);
  });

  it('no Step row has STATUS=NULL (all post-dedupe rows are publish-native)', async () => {
    const nullStatus = await db.run(`
      SELECT COUNT(*) AS C
        FROM "COM_SAP_DEVELOPERS_IMS_STEPS"
       WHERE "STATUS" IS NULL
    `);
    const c = nullStatus[0]?.C ?? 0;
    if (c > 0) {
      throw new Error(
        `Found ${c} Step row(s) with STATUS=NULL — these are migrated rows ` +
        `from the Java IMS cutover that should have been deduped.\n` +
        `Run: npx cds bind --exec -- node scripts/dedupe-migrated-step-rows.cjs --commit`
      );
    }
    expect(c).toBe(0);
  });
});
