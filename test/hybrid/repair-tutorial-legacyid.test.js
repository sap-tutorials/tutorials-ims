import cds from '@sap/cds';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { isSafeForWrites } from './_guard.js';

const NS = 'com.sap.developers.ims';
const TEST_PREFIX = '__TEST__legacyid-repair-';

const TUT_TBL = '"COM_SAP_DEVELOPERS_IMS_TUTORIALS"';
const CPI_TBL = '"COM_SAP_DEVELOPERS_IMS_COMPLETIONPATHITEMS"';
const PATH_TBL = '"COM_SAP_DEVELOPERS_IMS_COMPLETIONPATHS"';
const TUT_SEQ = '"COM_SAP_DEVELOPERS_IMS_TUTORIALS_SEQ"';

describe('repair-tutorial-legacyid (#431) — HANA', () => {
  let db;

  beforeAll(async () => {
    if (process.env.ALLOW_HYBRID_WRITES !== 'true') {
      throw new Error('Hybrid writes require ALLOW_HYBRID_WRITES=true');
    }
    if (!isSafeForWrites()) {
      throw new Error('Refusing to run hybrid writes against production');
    }
    db = await cds.connect.to('db');
  });

  afterAll(async () => {
    // Clean up everything our prefix touched.
    await db.run(`DELETE FROM ${CPI_TBL}
      WHERE "TUTORIAL_ID" IN (SELECT "ID" FROM ${TUT_TBL} WHERE "SLUG" LIKE '${TEST_PREFIX}%')`);
    await db.run(`DELETE FROM ${PATH_TBL} WHERE "SLUG" LIKE '${TEST_PREFIX}%'`);
    await db.run(`DELETE FROM ${TUT_TBL} WHERE "SLUG" LIKE '${TEST_PREFIX}%'`);
  });

  it('backfills NULL Tutorials.legacyId and propagates to CompletionPathItems via FK', async () => {
    const tutorialId = cds.utils.uuid();
    const slug = `${TEST_PREFIX}probe`;
    const pathId = cds.utils.uuid();
    const cpiId = cds.utils.uuid();

    // 1. Seed a parent CompletionPath (FK target for the CPI row).
    // CompletionPaths inherits LegacyKeyed, so seed legacyId too — defensive
    // against any future NOT NULL constraint and consistent with how the
    // entity is written elsewhere.
    const pathLegacyId = 999_900_001;
    await db.run(
      `INSERT INTO ${PATH_TBL} ("ID", "SLUG", "TITLE", "STATUS", "LEGACYID") VALUES (?, ?, ?, ?, ?)`,
      [pathId, `${TEST_PREFIX}path`, 'Repair test path', 'ACTIVE', pathLegacyId]
    );

    // 2. Seed a Tutorials row with legacyId NULL (mimics the bug shape).
    await db.run(
      `INSERT INTO ${TUT_TBL} ("ID", "SLUG", "TITLE", "STATUS", "LEGACYID") VALUES (?, ?, ?, ?, NULL)`,
      [tutorialId, slug, 'Repair test tutorial', 'ACTIVE']
    );

    // 3. Seed a CompletionPathItems row pointing at the tutorial via FK,
    //    with taskLegacyId NULL (mimics the downstream-NULL shape).
    await db.run(
      `INSERT INTO ${CPI_TBL}
         ("ID", "PATH_ID", "TASKLEGACYID", "TASKTYPE", "TUTORIAL_ID", "ITEMORDER")
       VALUES (?, ?, NULL, 'TUTORIAL', ?, 1)`,
      [cpiId, pathId, tutorialId]
    );

    // Sanity: pre-state.
    const tutBefore = await db.run(`SELECT "LEGACYID" FROM ${TUT_TBL} WHERE "ID" = ?`, [tutorialId]);
    expect(tutBefore[0].LEGACYID).toBeNull();
    const cpiBefore = await db.run(`SELECT "TASKLEGACYID" FROM ${CPI_TBL} WHERE "ID" = ?`, [cpiId]);
    expect(cpiBefore[0].TASKLEGACYID).toBeNull();

    // 4. Apply the repair logic in a tx (mirrors the script's per-tutorial block).
    let assignedLegacyId;
    await db.tx(async tx => {
      const [seqRow] = await tx.run(`SELECT ${TUT_SEQ}.NEXTVAL AS "nextval" FROM DUMMY`);
      assignedLegacyId = seqRow.nextval;
      await tx.run(
        `UPDATE ${TUT_TBL} SET "LEGACYID" = ? WHERE "ID" = ? AND "LEGACYID" IS NULL`,
        [assignedLegacyId, tutorialId]
      );
      await tx.run(`
        UPDATE ${CPI_TBL}
           SET "TASKLEGACYID" = ?
         WHERE "TUTORIAL_ID" = ?
           AND "TASKLEGACYID" IS NULL
           AND "TASKTYPE" = 'TUTORIAL'
      `, [assignedLegacyId, tutorialId]);
    });

    // 5. Assert: both rows now carry the same positive legacyId.
    expect(typeof assignedLegacyId).toBe('number');
    expect(assignedLegacyId).toBeGreaterThan(0);

    const tutAfter = await db.run(`SELECT "LEGACYID" FROM ${TUT_TBL} WHERE "ID" = ?`, [tutorialId]);
    expect(tutAfter[0].LEGACYID).toBe(assignedLegacyId);

    const cpiAfter = await db.run(`SELECT "TASKLEGACYID" FROM ${CPI_TBL} WHERE "ID" = ?`, [cpiId]);
    expect(cpiAfter[0].TASKLEGACYID).toBe(assignedLegacyId);
  });

  it('leaves CompletionPathItems alone when taskLegacyId is already non-NULL', async () => {
    const tutorialId = cds.utils.uuid();
    const slug = `${TEST_PREFIX}skip`;
    const pathId = cds.utils.uuid();
    const cpiId = cds.utils.uuid();
    const preExistingTaskLegacyId = 999_999_001;

    await db.run(
      `INSERT INTO ${PATH_TBL} ("ID", "SLUG", "TITLE", "STATUS", "LEGACYID") VALUES (?, ?, ?, ?, ?)`,
      [pathId, `${TEST_PREFIX}path-skip`, 'Skip test path', 'ACTIVE', 999_900_002]
    );
    await db.run(
      `INSERT INTO ${TUT_TBL} ("ID", "SLUG", "TITLE", "STATUS", "LEGACYID") VALUES (?, ?, ?, ?, NULL)`,
      [tutorialId, slug, 'Skip test tutorial', 'ACTIVE']
    );
    // CPI starts with a non-NULL taskLegacyId — repair should NOT overwrite.
    await db.run(
      `INSERT INTO ${CPI_TBL}
         ("ID", "PATH_ID", "TASKLEGACYID", "TASKTYPE", "TUTORIAL_ID", "ITEMORDER")
       VALUES (?, ?, ?, 'TUTORIAL', ?, 1)`,
      [cpiId, pathId, preExistingTaskLegacyId, tutorialId]
    );

    // Apply the repair tx.
    await db.tx(async tx => {
      const [seqRow] = await tx.run(`SELECT ${TUT_SEQ}.NEXTVAL AS "nextval" FROM DUMMY`);
      await tx.run(
        `UPDATE ${TUT_TBL} SET "LEGACYID" = ? WHERE "ID" = ? AND "LEGACYID" IS NULL`,
        [seqRow.nextval, tutorialId]
      );
      await tx.run(`
        UPDATE ${CPI_TBL}
           SET "TASKLEGACYID" = ?
         WHERE "TUTORIAL_ID" = ?
           AND "TASKLEGACYID" IS NULL
           AND "TASKTYPE" = 'TUTORIAL'
      `, [seqRow.nextval, tutorialId]);
    });

    // Assert: the pre-existing taskLegacyId is unchanged.
    const cpiAfter = await db.run(`SELECT "TASKLEGACYID" FROM ${CPI_TBL} WHERE "ID" = ?`, [cpiId]);
    expect(cpiAfter[0].TASKLEGACYID).toBe(preExistingTaskLegacyId);
  });
});
