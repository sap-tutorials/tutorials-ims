// srv/lib/kg/concept-embedding-query.js
//
// Cosine similarity over Concepts.embedding (BLOB, Float32 LE, 1536 dims).
// HANA path uses raw db.run() to avoid LOB-locator expiry: fetch IDs+metadata
// first (never SELECT the BLOB alongside metadata), then hydrate embeddings
// by ID. SQLite path uses JS-side cosine on the full row set.

const DIMS = 1536
const BYTES_PER_FLOAT = 4

function decodeEmbedding(buf) {
  if (!buf) return null
  let bytes
  if (Buffer.isBuffer(buf)) bytes = buf
  else if (typeof buf === 'string') bytes = Buffer.from(buf, 'base64')
  else if (buf instanceof Uint8Array) bytes = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength)
  else bytes = Buffer.from(buf)
  if (bytes.length !== DIMS * BYTES_PER_FLOAT) return null
  const out = new Float32Array(DIMS)
  for (let i = 0; i < DIMS; i++) out[i] = bytes.readFloatLE(i * BYTES_PER_FLOAT)
  return out
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < DIMS; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  const d = Math.sqrt(na) * Math.sqrt(nb)
  return d === 0 ? 0 : dot / d
}

function isHana(db) {
  return db?.kind === 'hana' || db?.options?.kind === 'hana'
}

export async function topConceptsByCosine({ db, queryVector, limit = 5 }) {
  const q = queryVector instanceof Float32Array ? queryVector : Float32Array.from(queryVector)
  const gate = "STATUS = 'ACTIVE' AND PUBLISHEDAT IS NOT NULL AND MERGEDINTO_ID IS NULL"

  if (isHana(db)) {
    // Step 1: IDs + metadata only (no BLOB)
    const metaRows = await db.run(
      `SELECT ID, SLUG, NAME FROM COM_SAP_DEVELOPERS_IMS_CONCEPTS WHERE ${gate}`
    )
    if (!metaRows || metaRows.length === 0) return []
    // Step 2: Hydrate embeddings in bounded batches to avoid huge IN clauses
    const scored = []
    const BATCH = 200
    for (let i = 0; i < metaRows.length; i += BATCH) {
      const chunk = metaRows.slice(i, i + BATCH)
      const placeholders = chunk.map(() => '?').join(',')
      const embRows = await db.run(
        `SELECT ID, EMBEDDING FROM COM_SAP_DEVELOPERS_IMS_CONCEPTS WHERE ID IN (${placeholders})`,
        chunk.map(r => r.ID)
      )
      const embMap = new Map()
      for (const r of embRows || []) {
        const v = decodeEmbedding(r.EMBEDDING)
        if (v) embMap.set(r.ID, v)
      }
      for (const meta of chunk) {
        const v = embMap.get(meta.ID)
        if (!v) continue
        scored.push({ id: meta.ID, slug: meta.SLUG, name: meta.NAME, score: cosine(q, v) })
      }
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, limit)
  }

  // SQLite path — small dataset in tests, full scan is fine.
  const rows = await db.run(
    `SELECT ID as id, slug, name, embedding FROM com_sap_developers_ims_Concepts
     WHERE status = 'ACTIVE' AND publishedAt IS NOT NULL AND mergedInto_ID IS NULL`
  )
  const scored = []
  for (const r of rows || []) {
    const v = decodeEmbedding(r.embedding)
    if (!v) continue
    scored.push({ id: r.id, slug: r.slug, name: r.name, score: cosine(q, v) })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit)
}
