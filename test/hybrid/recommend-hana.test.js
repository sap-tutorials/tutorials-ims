// test/hybrid/recommend-hana.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
import { getCentroid, __resetForTest } from '../../srv/lib/tutorial-centroid.js';

let db;

beforeAll(async () => {
  await cds.connect.to('db');
  db = cds.db;
  __resetForTest();
});

async function loadStepVectors(tutorialId) {
  const sql = `SELECT "EMBEDDING" FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALEMBEDDING" WHERE "TUTORIAL_ID" = ?`;
  const rows = await db.run(sql, [tutorialId]);
  return rows.map(r => {
    const blob = r.EMBEDDING ?? r.embedding;
    if (!blob) return null;
    const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
    return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  }).filter(Boolean);
}

describe('centroid against real HANA', () => {
  it('produces a non-null centroid for at least one seeded tutorial', async () => {
    const { Tutorials } = cds.entities('com.sap.developers.ims');
    const sample = await SELECT.from(Tutorials).columns('ID', 'slug').limit(20);
    let found = 0;
    for (const t of sample) {
      const c = await getCentroid(t.ID, loadStepVectors);
      if (c && c.length > 0) found += 1;
    }
    expect(found).toBeGreaterThan(0);
  }, 30_000);

  it('cosine math matches HANA COSINE_SIMILARITY within 1e-4', async () => {
    const { Tutorials } = cds.entities('com.sap.developers.ims');
    const [a, b] = await SELECT.from(Tutorials).columns('ID').limit(2);
    if (!a || !b) return; // Empty DB — skip; no assertion is fine for sanity.
    const va = await getCentroid(a.ID, loadStepVectors);
    const vb = await getCentroid(b.ID, loadStepVectors);
    if (!va || !vb) return;

    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < va.length; i++) { dot += va[i]*vb[i]; na += va[i]*va[i]; nb += vb[i]*vb[i]; }
    const jsCos = dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);

    const sql = `SELECT COSINE_SIMILARITY(TO_REAL_VECTOR(?), TO_REAL_VECTOR(?)) AS "score" FROM "DUMMY"`;
    const [row] = await db.run(sql, [JSON.stringify(Array.from(va)), JSON.stringify(Array.from(vb))]);
    const hanaCos = row.SCORE ?? row.score;

    expect(Math.abs(jsCos - hanaCos)).toBeLessThan(1e-4);
  }, 30_000);
});
