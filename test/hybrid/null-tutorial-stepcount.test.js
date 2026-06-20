import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

// Hybrid-only — see beforeAll guard.
//
// Invariant: any Tutorials row that has at least one Step row must have
// a non-NULL stepCount. The 2026-06-20 HANA audit found 1391 tutorials
// with NULL stepCount; PR A's migrator fix populates stepCount during
// import. This test catches recurrence.
//
// Fresh tutorials with no Steps yet are deliberately allowed (NULL is a
// valid pre-publish state for an authoring draft); we only fail when
// Step rows exist but stepCount was never set.
//
// Note: there is no schema-level @assert for "non-NULL when X exists" —
// CDS doesn't express conditional NOT NULL — so this test is the only
// enforcement. The publish path
// (srv/lib/content-publish-session.js) writes stepCount on every
// publish; the migrator must do the same.
//
// Runnable independently: `npx cds bind --exec -- npx vitest run \
//   --project hybrid test/hybrid/null-tutorial-stepcount.test.js`

describe('Tutorials.stepCount invariant (issue: 2026-06-20 migration audit)', () => {
  let db;

  beforeAll(async () => {
    db = await cds.connect.to('db');
    const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
    if (!isHana) {
      throw new Error(
        'null-tutorial-stepcount.test.js must run against HANA. ' +
        'Run via `npm run test:hybrid` after `cds bind` to the DEV space.'
      );
    }
  });

  it('no Tutorials row has NULL stepCount when Step rows exist', async () => {
    const offenders = await db.run(`
      SELECT t."SLUG", COUNT(s."ID") AS STEP_ROWS
        FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALS" t
        JOIN "COM_SAP_DEVELOPERS_IMS_STEPS" s ON s."TUTORIAL_ID" = t."ID"
       WHERE t."STEPCOUNT" IS NULL
       GROUP BY t."SLUG"
       ORDER BY STEP_ROWS DESC, t."SLUG"
    `);
    if (offenders.length > 0) {
      const sample = offenders.slice(0, 5)
        .map(r => `  ${r.SLUG}: ${r.STEP_ROWS} step rows, stepCount=NULL`)
        .join('\n');
      throw new Error(
        `Found ${offenders.length} tutorial(s) with Step rows but NULL stepCount. Sample:\n${sample}\n` +
        `These are migrated rows from the Java IMS cutover where the migrator failed to ` +
        `populate stepCount. Re-run the migrator (PR A fix) or republish content to repair.`
      );
    }
    expect(offenders.length).toBe(0);
  });
});
