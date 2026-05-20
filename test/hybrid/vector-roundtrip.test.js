import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';
import './_guard.js';

describe('HANA Vector(1536) round-trip', () => {
  const TUTORIAL_ID = '__TEST__-vector-roundtrip';

  beforeAll(async () => {
    await cds.connect.to('db');
    await cds.db.run(`DELETE FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALEMBEDDING" WHERE "tutorial_ID" = ?`, [TUTORIAL_ID]);
    await cds.db.run(`DELETE FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALS" WHERE "ID" = ?`, [TUTORIAL_ID]);
    await INSERT.into('com.sap.developers.ims.Tutorials').entries({ ID: TUTORIAL_ID, slug: '__test__-vec', title: '__test__' });
  });

  afterAll(async () => {
    await cds.db.run(`DELETE FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALEMBEDDING" WHERE "tutorial_ID" = ?`, [TUTORIAL_ID]);
    await cds.db.run(`DELETE FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALS" WHERE "ID" = ?`, [TUTORIAL_ID]);
  });

  it('inserts and retrieves a Vector(1536) and ranks by cosine similarity', async () => {
    const v1 = new Float32Array(1536); v1[0] = 1;
    const v2 = new Float32Array(1536); v2[0] = 0.9; v2[1] = 0.1;
    const v3 = new Float32Array(1536); v3[1535] = 1;

    for (const [n, v] of [[1, v1], [2, v2], [3, v3]]) {
      await cds.db.run(
        `INSERT INTO "COM_SAP_DEVELOPERS_IMS_TUTORIALEMBEDDING"
           ("tutorial_ID", "stepNumber", "contentHash", "embeddingModel", "embedding", "stepText", "charCount")
         VALUES (?, ?, ?, ?, TO_REAL_VECTOR(?), ?, ?)`,
        [TUTORIAL_ID, n, `h${n}`, 'text-embedding-3-small', JSON.stringify(Array.from(v)), `step${n}`, 6]
      );
    }

    const rows = await cds.db.run(
      `SELECT TOP 3 "stepNumber", COSINE_SIMILARITY("embedding", TO_REAL_VECTOR(?)) AS "score"
       FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALEMBEDDING" WHERE "tutorial_ID" = ? ORDER BY "score" DESC`,
      [JSON.stringify(Array.from(v1)), TUTORIAL_ID]
    );
    expect(rows[0].STEPNUMBER ?? rows[0].stepNumber).toBe(1);
    expect(rows[2].STEPNUMBER ?? rows[2].stepNumber).toBe(3);
  }, 30000);
});
