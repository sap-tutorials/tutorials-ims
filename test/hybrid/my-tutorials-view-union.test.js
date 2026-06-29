// test/hybrid/my-tutorials-view-union.test.js
//
// Issue #777. Exercises MyTutorialsView (4-source UNION ALL via three
// layered views) against real HANA. Inserts synthetic test data covering
// each source path, then queries the view and asserts:
//   1. All four sources contribute rows.
//   2. A user present in multiple sources gets ONE row with the highest-
//      confidence (lowest-priority-number) source as bestPriority.
//   3. The userId column resolves to Users.uuid, not Users.ID — the
//      established CAP invariant per spec §4.4.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';
import { isSafeForWrites } from './_guard.js';

cds.test('serve', '--project', '.', '--profile', 'hybrid');

const TS = `__TEST__777_${Date.now()}__`;

// Synthetic IDs.
const userId = `${TS}user1`;                                              // Users.ID
const userUuid = `${TS.replace(/[^a-z0-9]/gi, '')}uuid1`.slice(0, 36);    // Users.uuid (matches req.user.id)
const tutA = `${TS}tutA`;        // tutorial only via author_ID
const tutB = `${TS}tutB`;        // tutorial only via TutorialContributors.user_ID
const tutC = `${TS}tutC`;        // tutorial only via TutorialMeta.ownerEmail
const tutD = `${TS}tutD`;        // tutorial only via legacy TutorialMeta.owner text
const tutE = `${TS}tutE`;        // tutorial via BOTH author_ID and ownerEmail (multi-source)

describe.runIf(isSafeForWrites())('MyTutorialsView — 4-source UNION (hybrid, HANA only)', () => {
  let db;

  beforeAll(async () => {
    db = await cds.connect.to('db');
    const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
    if (!isHana) {
      throw new Error(
        'my-tutorials-view-union.test.js must run against HANA. ' +
        'Run via `npm run test:hybrid` after `cds bind` to the DEV space.'
      );
    }

    // Synthetic Users row. Both ID and uuid set — view's userId column
    // is uuid, so the filter must match uuid (not ID).
    await db.run(
      `INSERT INTO "COM_SAP_DEVELOPERS_IMS_USERS" ("ID", "uuid", "email", "firstName", "lastName") VALUES (?, ?, ?, ?, ?)`,
      [userId, userUuid, `${TS}user1@example.com`, 'Test', 'User'],
    );

    // 5 synthetic Tutorials. status='ACTIVE' so they're not filtered out.
    for (const id of [tutA, tutB, tutC, tutD, tutE]) {
      await db.run(
        `INSERT INTO "COM_SAP_DEVELOPERS_IMS_TUTORIALS" ("ID", "slug", "title", "status") VALUES (?, ?, ?, 'ACTIVE')`,
        [id, `${TS}slug-${id}`, `Test Tutorial ${id}`],
      );
    }

    // Source 1: tutA gets author_ID = userId (the Users.ID, not uuid — FK column).
    await db.run(
      `UPDATE "COM_SAP_DEVELOPERS_IMS_TUTORIALS" SET "author_ID" = ? WHERE "ID" = ?`,
      [userId, tutA],
    );
    // Source 1 + 3: tutE gets author_ID AND a TutorialMeta with matching ownerEmail.
    await db.run(
      `UPDATE "COM_SAP_DEVELOPERS_IMS_TUTORIALS" SET "author_ID" = ? WHERE "ID" = ?`,
      [userId, tutE],
    );

    // Source 2: TutorialContributors row for tutB.
    await db.run(
      `INSERT INTO "COM_SAP_DEVELOPERS_IMS_TUTORIALCONTRIBUTORS" ("ID", "tutorial_ID", "user_ID", "name", "email", "role")
       VALUES (?, ?, ?, ?, ?, ?)`,
      [`${TS}contrib1`, tutB, userId, 'Test User', `${TS}user1@example.com`, 'contributor'],
    );

    // Source 3: TutorialMeta row with ownerEmail for tutC.
    await db.run(
      `INSERT INTO "COM_SAP_DEVELOPERS_IMS_TUTORIALMETA" ("ID", "tutorial_ID", "OWNER", "OWNEREMAIL") VALUES (?, ?, ?, ?)`,
      [`${TS}meta3`, tutC, `${TS}user1@example.com`, `${TS}user1@example.com`],
    );

    // Source 4: TutorialMeta row with legacy free-text owner for tutD (NULL ownerEmail).
    // Uses Test User as the legacy owner name to match firstName + ' ' + lastName.
    await db.run(
      `INSERT INTO "COM_SAP_DEVELOPERS_IMS_TUTORIALMETA" ("ID", "tutorial_ID", "OWNER", "OWNEREMAIL") VALUES (?, ?, ?, NULL)`,
      [`${TS}meta4`, tutD, 'Test User'],
    );

    // For tutA, tutB, tutE we also need TutorialMeta rows because the
    // outer view INNER JOINs TutorialMeta. Use minimal rows.
    for (const tId of [tutA, tutB, tutE]) {
      await db.run(
        `INSERT INTO "COM_SAP_DEVELOPERS_IMS_TUTORIALMETA" ("ID", "tutorial_ID") VALUES (?, ?)`,
        [`${TS}meta-${tId}`, tId],
      );
    }
    // Source 3 for tutE — update the just-inserted meta row.
    await db.run(
      `UPDATE "COM_SAP_DEVELOPERS_IMS_TUTORIALMETA" SET "OWNEREMAIL" = ? WHERE "tutorial_ID" = ?`,
      [`${TS}user1@example.com`, tutE],
    );
  });

  afterAll(async () => {
    if (db) {
      // Clean up in reverse FK dependency order.
      await db.run(`DELETE FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALCONTRIBUTORS" WHERE "ID" LIKE '${TS}%'`);
      await db.run(`DELETE FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALMETA" WHERE "ID" LIKE '${TS}%'`);
      // Clear author_ID before deleting Users (FK constraint).
      await db.run(`UPDATE "COM_SAP_DEVELOPERS_IMS_TUTORIALS" SET "author_ID" = NULL WHERE "ID" LIKE '${TS}%'`);
      await db.run(`DELETE FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALS" WHERE "ID" LIKE '${TS}%'`);
      await db.run(`DELETE FROM "COM_SAP_DEVELOPERS_IMS_USERS" WHERE "ID" LIKE '${TS}%'`);
    }
  });

  it('userId column resolves to Users.uuid (not Users.ID)', async () => {
    // Should return all five synthetic tutorials (tutA-E) when filtered by uuid.
    const rows = await db.run(
      `SELECT "tutorial_ID", "userId", "bestPriority" FROM "COM_SAP_DEVELOPERS_IMS_MYTUTORIALSVIEW" WHERE "userId" = ?`,
      [userUuid],
    );
    expect(rows.length).toBeGreaterThanOrEqual(5);

    // Filter by Users.ID (the wrong UUID) must return nothing.
    const wrongRows = await db.run(
      `SELECT "tutorial_ID" FROM "COM_SAP_DEVELOPERS_IMS_MYTUTORIALSVIEW" WHERE "userId" = ?`,
      [userId],
    );
    expect(wrongRows.length).toBe(0);
  });

  it('source 1 (author_ID) contributes tutA with priority 1', async () => {
    const rows = await db.run(
      `SELECT "bestPriority" FROM "COM_SAP_DEVELOPERS_IMS_MYTUTORIALSVIEW" WHERE "userId" = ? AND "tutorial_ID" = ?`,
      [userUuid, tutA],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].bestPriority).toBe(1);
  });

  it('source 2 (contributor FK) contributes tutB with priority 2', async () => {
    const rows = await db.run(
      `SELECT "bestPriority" FROM "COM_SAP_DEVELOPERS_IMS_MYTUTORIALSVIEW" WHERE "userId" = ? AND "tutorial_ID" = ?`,
      [userUuid, tutB],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].bestPriority).toBe(2);
  });

  it('source 3 (ownerEmail) contributes tutC with priority 3', async () => {
    const rows = await db.run(
      `SELECT "bestPriority" FROM "COM_SAP_DEVELOPERS_IMS_MYTUTORIALSVIEW" WHERE "userId" = ? AND "tutorial_ID" = ?`,
      [userUuid, tutC],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].bestPriority).toBe(3);
  });

  it('source 4 (legacy owner text) contributes tutD with priority 4', async () => {
    const rows = await db.run(
      `SELECT "bestPriority" FROM "COM_SAP_DEVELOPERS_IMS_MYTUTORIALSVIEW" WHERE "userId" = ? AND "tutorial_ID" = ?`,
      [userUuid, tutD],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].bestPriority).toBe(4);
  });

  it('multi-source (tutE: author_ID + ownerEmail) → one row, MIN(priority) = 1', async () => {
    const rows = await db.run(
      `SELECT "bestPriority" FROM "COM_SAP_DEVELOPERS_IMS_MYTUTORIALSVIEW" WHERE "userId" = ? AND "tutorial_ID" = ?`,
      [userUuid, tutE],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].bestPriority).toBe(1);
  });
});
