// test/hybrid/repair-mission-completion-path-data.test.js
// Hybrid SQL contract regression for #436 — mirrors
// test/hybrid/repair-tutorial-legacyid.test.js (PR #452). Exercises the
// repair script's per-row UPDATE statements directly against HANA.

import cds from '@sap/cds';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { isSafeForWrites } from './_guard.js';
import { slugify, ensureUniqueSlug } from '../../srv/lib/slug-utils.js';

const NS = 'com.sap.developers.ims';
const TEST_PREFIX = '__TEST__436-repair-';

const MISSIONS_TBL = '"COM_SAP_DEVELOPERS_IMS_MISSIONS"';
const PATHS_TBL = '"COM_SAP_DEVELOPERS_IMS_COMPLETIONPATHS"';
const MISSION_SEQ = '"COM_SAP_DEVELOPERS_IMS_MISSIONS_SEQ"';
const PATH_SEQ = '"COM_SAP_DEVELOPERS_IMS_COMPLETIONPATHS_SEQ"';

describe('repair-mission-completion-path-data (#436) — HANA', () => {
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
    await db.run(`DELETE FROM ${PATHS_TBL}
      WHERE "MISSION_ID" IN (SELECT "ID" FROM ${MISSIONS_TBL} WHERE "TITLE" LIKE '${TEST_PREFIX}%')`);
    await db.run(`DELETE FROM ${MISSIONS_TBL} WHERE "TITLE" LIKE '${TEST_PREFIX}%'`);
  });

  it('backfills NULL Missions.legacyId via the sequence', async () => {
    const missionId = cds.utils.uuid();
    await db.run(
      `INSERT INTO ${MISSIONS_TBL} ("ID", "TITLE", "STATUS", "LEGACYID") VALUES (?, ?, ?, NULL)`,
      [missionId, `${TEST_PREFIX}mission-legacy`, 'ACTIVE']
    );

    let assignedLegacyId;
    await db.tx(async tx => {
      const [seq] = await tx.run(`SELECT ${MISSION_SEQ}.NEXTVAL AS "v" FROM DUMMY`);
      assignedLegacyId = seq.v;
      await tx.run(
        `UPDATE ${MISSIONS_TBL} SET "LEGACYID" = ? WHERE "ID" = ? AND "LEGACYID" IS NULL`,
        [assignedLegacyId, missionId]
      );
    });

    expect(typeof assignedLegacyId).toBe('number');
    expect(assignedLegacyId).toBeGreaterThan(0);

    const after = await db.run(`SELECT "LEGACYID" FROM ${MISSIONS_TBL} WHERE "ID" = ?`, [missionId]);
    expect(after[0].LEGACYID).toBe(assignedLegacyId);
  });

  it('backfills NULL CompletionPaths.legacyId + slug, scope-unique per mission', async () => {
    const missionId = cds.utils.uuid();
    const path1Id = cds.utils.uuid();
    const path2Id = cds.utils.uuid();

    // Seed parent Mission (with legacyId so we don't trip the FK gauntlet).
    await db.run(
      `INSERT INTO ${MISSIONS_TBL} ("ID", "TITLE", "STATUS", "LEGACYID") VALUES (?, ?, ?, ?)`,
      [missionId, `${TEST_PREFIX}mission-with-paths`, 'ACTIVE', 999_888_001]
    );
    // Two CompletionPaths under same mission with same name, both NULL slug+legacyId.
    await db.run(
      `INSERT INTO ${PATHS_TBL} ("ID", "MISSION_ID", "NAME", "SLUG", "LEGACYID") VALUES (?, ?, ?, NULL, NULL)`,
      [path1Id, missionId, 'Same Name Path']
    );
    await db.run(
      `INSERT INTO ${PATHS_TBL} ("ID", "MISSION_ID", "NAME", "SLUG", "LEGACYID") VALUES (?, ?, ?, NULL, NULL)`,
      [path2Id, missionId, 'Same Name Path']
    );

    // Repair path 1 first.
    await db.tx(async tx => {
      const [seq] = await tx.run(`SELECT ${PATH_SEQ}.NEXTVAL AS "v" FROM DUMMY`);
      const siblings = await tx.run(
        `SELECT "SLUG" FROM ${PATHS_TBL} WHERE "MISSION_ID" = ? AND "SLUG" IS NOT NULL AND "ID" <> ?`,
        [missionId, path1Id]
      );
      const taken = new Set(siblings.map(s => s.SLUG).filter(Boolean));
      const slug = ensureUniqueSlug(slugify('Same Name Path'), taken, null);
      await tx.run(
        `UPDATE ${PATHS_TBL} SET "LEGACYID" = ?, "SLUG" = ? WHERE "ID" = ?`,
        [seq.v, slug, path1Id]
      );
    });

    // Repair path 2 — it should see path 1's slug in `taken` and append -2.
    await db.tx(async tx => {
      const [seq] = await tx.run(`SELECT ${PATH_SEQ}.NEXTVAL AS "v" FROM DUMMY`);
      const siblings = await tx.run(
        `SELECT "SLUG" FROM ${PATHS_TBL} WHERE "MISSION_ID" = ? AND "SLUG" IS NOT NULL AND "ID" <> ?`,
        [missionId, path2Id]
      );
      const taken = new Set(siblings.map(s => s.SLUG).filter(Boolean));
      const slug = ensureUniqueSlug(slugify('Same Name Path'), taken, null);
      await tx.run(
        `UPDATE ${PATHS_TBL} SET "LEGACYID" = ?, "SLUG" = ? WHERE "ID" = ?`,
        [seq.v, slug, path2Id]
      );
    });

    const after1 = await db.run(`SELECT "SLUG", "LEGACYID" FROM ${PATHS_TBL} WHERE "ID" = ?`, [path1Id]);
    const after2 = await db.run(`SELECT "SLUG", "LEGACYID" FROM ${PATHS_TBL} WHERE "ID" = ?`, [path2Id]);
    expect(after1[0].SLUG).toBe('same-name-path');
    expect(after2[0].SLUG).toBe('same-name-path-2');
    expect(after1[0].LEGACYID).toBeGreaterThan(0);
    expect(after2[0].LEGACYID).toBeGreaterThan(0);
    expect(after1[0].LEGACYID).not.toBe(after2[0].LEGACYID);
  });
});
