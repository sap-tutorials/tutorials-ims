// srv/lib/step-vectors.js
//
// HANA-aware tutorial step-embedding loader. Pulled out of
// srv/handlers/recommendations.js so both the recommend pipeline and the
// PR 2 branch loaders can share one implementation.
//
// HANA-only path uses raw SQL because mixing BLOB columns with metadata
// in CDS QL triggers LOB-locator expiry (see CLAUDE.md gotcha).

import cds from '@sap/cds';

export async function loadStepVectors(tutorialId) {
  const db = cds.db;
  const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
  if (isHana) {
    const sql = `
      SELECT "EMBEDDING"
      FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALEMBEDDING"
      WHERE "TUTORIAL_ID" = ?`;
    const rows = await db.run(sql, [tutorialId]);
    return rows.map(r => bufToFloat32(r.EMBEDDING ?? r.embedding)).filter(Boolean);
  }
  const { TutorialEmbedding } = cds.entities('com.sap.developers.ims');
  const rows = await SELECT.from(TutorialEmbedding).columns('embedding').where({ tutorial_ID: tutorialId });
  return rows.map(r => bufToFloat32(r.embedding)).filter(Boolean);
}

export function bufToFloat32(blob) {
  if (!blob) return null;
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  if (buf.byteLength % 4 !== 0) return null;
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}
