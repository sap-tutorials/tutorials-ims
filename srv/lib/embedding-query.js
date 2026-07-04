// srv/lib/embedding-query.js
//
// RAG retrieval for the Joule chat `getRelevantSteps` tool. Embeds the user's
// query, then ranks TutorialEmbedding rows by cosine similarity and returns
// the top-K steps above `embeddingMinScore`.
//
// Two implementations gated by `db.options.kind`:
//   - HANA: raw SQL using the native COSINE_SIMILARITY scalar. Raw SQL (not
//     CDS QL) because SELECTing the EMBEDDING BLOB alongside metadata via
//     CDS QL triggers HANA LOB-locator expiry before the row is consumed
//     (see CLAUDE.md `HANA LOB locator expiry` gotcha). Also: identifiers
//     are quoted-uppercase — the .hdbtable declares them unquoted, so HANA
//     stores them upper-case in its catalog.
//   - SQLite (unit tests): fetch all rows for the model and rank in JS via
//     the local `cosine()` helper. No LOB-locator concern on SQLite.
//
// Vector encoding on the wire: HANA expects a JSON array literal fed into
// TO_REAL_VECTOR(?), so the caller-side query vector (a Float32Array) is
// wrapped in `JSON.stringify(Array.from(qVec))`. Passing the raw typed
// array binds as a BLOB and the scalar returns wrong-shape results.

import cds from '@sap/cds';
import { embed } from './embedding-client.js';

// LOG declared for future structured tracing; unused at this stage.
const LOG = cds.log('rag-query');

/**
 * Cosine similarity of two equal-length numeric vectors.
 * Returns dot / (|a| * |b|); collapses to 0 when either magnitude is 0
 * so a zero-vector doesn't produce NaN (SQLite-path fallback only).
 */
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

/**
 * Find tutorial steps whose embedding is most similar to `query`.
 *
 * Called by the Joule chat orchestrator's `getRelevantSteps` tool when
 * `ChatSettings.ragEnabled` is on. Also usable by ad-hoc admin diagnostics.
 *
 * @param {object} args
 * @param {string} args.query - Free-text user query. Empty/whitespace-only
 *   input short-circuits to `[]` before any AI call is made.
 * @param {object} args.settings - Chat settings snapshot.
 * @param {number} [args.settings.embeddingTopK=4] - Max rows to return.
 *   Clamped to [1, 10] — 10 is the hard cap to keep the chat prompt bounded.
 * @param {number} [args.settings.embeddingMinScore=0.25] - Rows scoring
 *   strictly below this cosine value are dropped. On the HANA path the
 *   filter happens in JS after `ORDER BY score DESC` so the raw top-K
 *   ranking is preserved even when everything is below the floor.
 * @param {string} args.settings.embeddingModel - Embedding model name (resolved upstream via resolveEmbeddingSettings)
 *
 * @returns {Promise<Array<{
 *   tutorialId: string,
 *   tutorialSlug: string,
 *   tutorialTitle: string,
 *   stepNumber: number,
 *   text: string,
 *   score: number
 * }>>} Rows sorted by score descending, length ≤ topK, all scores ≥ minScore.
 */
export async function findRelevantSteps({ query, settings }) {
  if (!query || !query.trim()) return [];
  const topK = Math.min(Math.max(settings.embeddingTopK ?? 4, 1), 10);
  const minScore = settings.embeddingMinScore ?? 0.25;
  // model is resolved upstream via resolveEmbeddingSettings() — trust the caller.
  const model = settings.embeddingModel;

  const [qVec] = await embed([query.trim()], model);
  const db = cds.db;
  const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';

  if (isHana) {
    // Identifiers must be quoted-uppercase: the .hdbtable declares them unquoted,
    // so HANA stores them upper-case in the catalog (TUTORIAL_ID, not tutorial_ID).
    // TO_REAL_VECTOR(?) accepts a JSON array literal — pass Array.from(qVec) to
    // avoid binding the Float32Array as a BLOB.
    const sql = `
      SELECT TOP ${topK}
        e."TUTORIAL_ID", e."STEPNUMBER", e."STEPTEXT",
        t."SLUG" AS "tutorialSlug", t."TITLE" AS "tutorialTitle",
        COSINE_SIMILARITY(e."EMBEDDING", TO_REAL_VECTOR(?)) AS "score"
      FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALEMBEDDING" e
      JOIN "COM_SAP_DEVELOPERS_IMS_TUTORIALS" t ON t."ID" = e."TUTORIAL_ID"
      WHERE e."EMBEDDINGMODEL" = ?
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
  // Safe here because SQLite doesn't use LOB locators — the BLOB is served
  // inline with the row. Cost scales with total embedding rows for the model,
  // which is fine for a test corpus.
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
