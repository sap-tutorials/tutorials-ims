import cds from '@sap/cds';
import { embed } from './embedding-client.js';

// LOG declared for future structured tracing; unused at this stage.
const LOG = cds.log('rag-query');

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

export async function findRelevantSteps({ query, settings }) {
  if (!query || !query.trim()) return [];
  const topK = Math.min(Math.max(settings.embeddingTopK ?? 4, 1), 10);
  const minScore = settings.embeddingMinScore ?? 0.7;
  const model = settings.embeddingModel || 'text-embedding-3-small';

  const [qVec] = await embed([query.trim()], model);
  const db = cds.db;
  const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';

  if (isHana) {
    const sql = `
      SELECT TOP ${topK}
        e."tutorial_ID", e."stepNumber", e."stepText",
        t."slug" AS "tutorialSlug", t."title" AS "tutorialTitle",
        COSINE_SIMILARITY(e."embedding", TO_REAL_VECTOR(?)) AS "score"
      FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALEMBEDDING" e
      JOIN "COM_SAP_DEVELOPERS_IMS_TUTORIALS" t ON t."ID" = e."tutorial_ID"
      WHERE e."embeddingModel" = ?
      ORDER BY "score" DESC`;
    const rows = await db.run(sql, [JSON.stringify(Array.from(qVec)), model]);
    return rows
      .filter((r) => (r.SCORE ?? r.score) >= minScore)
      .map((r) => ({
        tutorialId: r.TUTORIAL_ID ?? r.tutorial_ID,
        tutorialSlug: r.TUTORIALSLUG ?? r.tutorialSlug,
        tutorialTitle: r.TUTORIALTITLE ?? r.tutorialTitle,
        stepNumber: r.STEPNUMBER ?? r.stepNumber,
        text: r.STEPTEXT ?? r.stepText,
        score: r.SCORE ?? r.score
      }));
  }

  // SQLite test path: fetch all rows for the current model and rank in JS.
  const { TutorialEmbedding, Tutorials } = cds.entities('com.sap.developers.ims');
  const rows = await SELECT.from(TutorialEmbedding).columns(
    'tutorial_ID', 'stepNumber', 'stepText', 'embedding'
  ).where({ embeddingModel: model });
  const tutorialIndex = await SELECT.from(Tutorials).columns('ID', 'slug', 'title');
  const tMap = new Map(tutorialIndex.map((t) => [t.ID, t]));
  const scored = rows.map((r) => {
    const buf = Buffer.isBuffer(r.embedding) ? r.embedding : Buffer.from(r.embedding);
    const v = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    const t = tMap.get(r.tutorial_ID) || {};
    return {
      tutorialId: r.tutorial_ID,
      tutorialSlug: t.slug,
      tutorialTitle: t.title,
      stepNumber: r.stepNumber,
      text: r.stepText,
      score: cosine(v, qVec)
    };
  });
  return scored.filter((s) => s.score >= minScore).sort((a, b) => b.score - a.score).slice(0, topK);
}
