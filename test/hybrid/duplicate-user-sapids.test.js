import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

// Hybrid-only — see beforeAll guard.
//
// Invariant: every Users row has a unique sapId. NULL sapId rows are
// allowed (HANA `@assert.unique` permits multiple NULLs); the migrator
// fix in PR A leaves NULL-sapId users in place as TaskRecord FK targets
// while logging an audit count. The schema-level
// `@assert.unique.sapId : [sapId]` (this PR) rejects future duplicate
// non-NULL sapIds at the DB layer; this test is the CI guard.
//
// If two rows ever share a non-NULL sapId, `getProgress` and
// `completeStep` (which look up by sapId from the JWT user_uuid) become
// nondeterministic.
//
// Runnable independently: `npx cds bind --exec -- npx vitest run \
//   --project hybrid test/hybrid/duplicate-user-sapids.test.js`

describe('Users sapId uniqueness invariant (issue: 2026-06-20 migration audit)', () => {
  let db;

  beforeAll(async () => {
    db = await cds.connect.to('db');
    const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
    if (!isHana) {
      throw new Error(
        'duplicate-user-sapids.test.js must run against HANA. ' +
        'Run via `npm run test:hybrid` after `cds bind` to the DEV space.'
      );
    }
  });

  it('Users has no duplicate non-NULL sapId values', async () => {
    const dups = await db.run(`
      SELECT "SAPID" AS S, COUNT(*) AS C
        FROM "COM_SAP_DEVELOPERS_IMS_USERS"
       WHERE "SAPID" IS NOT NULL
       GROUP BY "SAPID"
      HAVING COUNT(*) > 1
       ORDER BY C DESC, S
    `);
    if (dups.length > 0) {
      const sample = dups.slice(0, 5).map(r => `  ${r.S} → ${r.C} rows`).join('\n');
      throw new Error(
        `Found ${dups.length} duplicate-sapId group(s) in Users. Sample:\n${sample}\n` +
        `Two rows with the same sapId make getProgress/completeStep nondeterministic.`
      );
    }
    expect(dups.length).toBe(0);
  });
});
