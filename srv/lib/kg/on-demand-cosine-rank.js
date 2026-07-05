// srv/lib/kg/on-demand-cosine-rank.js
//
// Rank ACTIVE tutorials by MAX cosine similarity between a query vector
// and any TutorialEmbedding step of that tutorial.
//
// Vector(1536) is a HANA BLOB — LOB expiry applies. Two-phase pattern:
//   1. IDs + metadata only (no BLOB).
//   2. Hydrate embeddings by ID in a second raw-SQL pass on HANA.
// Same shape as srv/lib/kg/concept-embedding-query.js.
//
// SQLite tests use raw db.run() for both phases because CDS QL INSERT
// serializes Buffer as JSON {"type":"Buffer","data":[...]} rather than
// a plain binary payload. Raw SQL SELECT returns a consistent base64 or
// JSON string that decodeEmbedding handles. HANA always uses raw SQL for
// LOB-locator safety.
//
// Result: top-K { tutorialId, slug, title, score } sorted by score DESC.
//
// Spec: docs/superpowers/specs/2026-07-05-948-kg-ondemand-triggers-design.md §1
// Issue: #948

const DIMS = 1536;
const BYTES_PER_FLOAT = 4;

function decodeEmbedding(buf) {
  if (!buf) return null;
  let bytes;
  if (Buffer.isBuffer(buf)) {
    bytes = buf;
  } else if (typeof buf === 'string') {
    // Two wire formats from SQLite:
    //   1. Base64 string (when stored via db.run raw SQL INSERT)
    //   2. JSON {"type":"Buffer","data":[...]} (when stored via CDS QL INSERT)
    if (buf.startsWith('{')) {
      try {
        const parsed = JSON.parse(buf);
        if (parsed.type === 'Buffer' && Array.isArray(parsed.data)) {
          bytes = Buffer.from(parsed.data);
        } else {
          bytes = Buffer.from(buf, 'base64');
        }
      } catch {
        bytes = Buffer.from(buf, 'base64');
      }
    } else {
      bytes = Buffer.from(buf, 'base64');
    }
  } else if (buf instanceof Uint8Array) {
    bytes = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  } else {
    bytes = Buffer.from(buf);
  }
  if (bytes.length !== DIMS * BYTES_PER_FLOAT) return null;
  const out = new Float32Array(DIMS);
  for (let i = 0; i < DIMS; i++) out[i] = bytes.readFloatLE(i * BYTES_PER_FLOAT);
  return out;
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < DIMS; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}

function isHana(db) {
  return db?.kind === 'hana' || db?.options?.kind === 'hana' ||
    db?.constructor?.name === 'HANAService';
}

/**
 * Rank ACTIVE tutorials by MAX cosine similarity between queryVector and
 * any TutorialEmbedding step.
 *
 * @param {object} opts
 * @param {object} opts.db          cds.connect.to('db') handle
 * @param {Float32Array|number[]} opts.queryVector  1536-dim query embedding
 * @param {number} opts.limit       Top-K to return (default 5)
 * @returns {Promise<Array<{ tutorialId: string, slug: string, title: string, score: number }>>}
 */
export async function rankTutorialsByQueryVector({ db, queryVector, limit = 5 }) {
  const q = queryVector instanceof Float32Array
    ? queryVector
    : Float32Array.from(queryVector);

  // Phase 1: fetch ACTIVE tutorial IDs + metadata (no BLOB).
  // Use raw db.run() on both paths so the embedding BLOB comes back as a
  // consistent base64 string (same as concept-embedding-query.js's SQLite path).
  // CDS QL INSERT serializes Buffer as JSON {type:"Buffer",data:[...]};
  // raw SQL SELECT returns it as a base64 string that decodeEmbedding handles.
  let activeTutorials;
  if (isHana(db)) {
    activeTutorials = await db.run(
      `SELECT ID, SLUG, TITLE FROM COM_SAP_DEVELOPERS_IMS_TUTORIALS WHERE STATUS = 'ACTIVE'`
    );
    if (!activeTutorials || activeTutorials.length === 0) return [];
    activeTutorials = activeTutorials.map(r => ({ ID: r.ID, slug: r.SLUG, title: r.TITLE }));
  } else {
    const rows = await db.run(
      `SELECT ID, slug, title FROM com_sap_developers_ims_Tutorials WHERE status = 'ACTIVE'`
    );
    if (!rows || rows.length === 0) return [];
    activeTutorials = rows;
  }

  const metaById = new Map(activeTutorials.map(t => [t.ID, t]));

  // Phase 2: fetch embeddings for ACTIVE tutorials only.
  // On HANA: raw db.run() to avoid LOB locator expiry.
  // On SQLite: also raw db.run() so the BLOB comes back as a base64 string
  //   (CDS QL returns Buffer serialized as {"type":"Buffer","data":[...]} JSON).
  const ids = [...metaById.keys()];
  let rows;
  if (isHana(db)) {
    const placeholders = ids.map(() => '?').join(',');
    const sql = `SELECT TUTORIAL_ID, STEPNUMBER, EMBEDDING FROM COM_SAP_DEVELOPERS_IMS_TUTORIALEMBEDDING WHERE TUTORIAL_ID IN (${placeholders})`;
    rows = await db.run(sql, ids);
  } else {
    const placeholders = ids.map(() => '?').join(',');
    const sql = `SELECT tutorial_ID, stepNumber, embedding FROM com_sap_developers_ims_TutorialEmbedding WHERE tutorial_ID IN (${placeholders})`;
    rows = await db.run(sql, ids);
  }

  // Compute MAX(cosine) per tutorial.
  const bestByTutorial = new Map();
  for (const r of rows) {
    const tid = r.tutorial_ID ?? r.TUTORIAL_ID;
    const emb = decodeEmbedding(r.embedding ?? r.EMBEDDING);
    if (!emb) continue;
    const c = cosine(q, emb);
    const prev = bestByTutorial.get(tid) ?? -Infinity;
    if (c > prev) bestByTutorial.set(tid, c);
  }

  const scored = [...bestByTutorial.entries()]
    .map(([tid, score]) => {
      const meta = metaById.get(tid);
      return meta ? { tutorialId: tid, slug: meta.slug, title: meta.title, score } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return scored;
}
