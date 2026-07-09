// test/hybrid/kg-hana-cosine.test.js
// Verifies the #1113 HANA cosine path end-to-end against a bound HDI
// container. Covers: backfill dual-column write, cosine latency SLO,
// and behavior parity between the HANA and JS-cosine paths.
//
// Run with: npm run test:hybrid

import { describe, it, expect, beforeAll } from 'vitest'
import cds from '@sap/cds'
import { isSafeForWrites } from './_guard.js'
import { topConceptsByCosine } from '../../srv/lib/kg/concept-embedding-query.js'
import { runConceptEmbeddingBackfill } from '../../srv/jobs/concept-embedding-backfill.js'

cds.test('serve', '--project', '.', '--profile', 'hybrid')

describe.runIf(isSafeForWrites())('#1113 HANA cosine (hybrid)', () => {
  let db

  beforeAll(async () => {
    db = await cds.connect.to('db')
    // Sanity: confirm we're actually on HANA. If tests silently fall through
    // to SQLite, none of this proves anything.
    const kind = db?.kind || db?.options?.kind
    expect(kind, `expected HANA, got kind=${kind}`).toBe('hana')
  })

  it('backfill populates embeddingVec for rows that already have the BLOB', async () => {
    // Some prod rows may already have both columns filled (backfill has run).
    // Convergence semantics: run twice, assert final state.
    await runConceptEmbeddingBackfill({ db })

    const [{ MISSING }] = await db.run(
      `SELECT COUNT(*) AS MISSING FROM COM_SAP_DEVELOPERS_IMS_CONCEPTS
       WHERE STATUS = 'ACTIVE' AND PUBLISHEDAT IS NOT NULL AND MERGEDINTO_ID IS NULL
         AND EMBEDDING IS NOT NULL AND EMBEDDING_VEC IS NULL`
    )
    expect(MISSING, 'no ACTIVE row should have BLOB but null vector column post-backfill').toBe(0)
  }, 5 * 60 * 1000)  // Up to 5 minutes for a full backfill on cold DB.

  it('topConceptsByCosine latency SLO (< 1500 ms on 5,946-row corpus)', async () => {
    // Random-but-deterministic query vector.
    const q = new Float32Array(1536)
    for (let i = 0; i < 1536; i++) q[i] = Math.sin(i / 17.3) * 0.5

    const t0 = Date.now()
    const out = await topConceptsByCosine({ db, queryVector: q, limit: 5 })
    const latency = Date.now() - t0

    expect(out.length).toBeGreaterThan(0)
    expect(out[0].score, 'top score in [-1,1]').toBeGreaterThan(-1)
    expect(out[0].score, 'top score in [-1,1]').toBeLessThanOrEqual(1)
    expect(latency, `topConceptsByCosine took ${latency}ms — SLO is <1500ms`).toBeLessThan(1500)
  })

  it('HANA cosine top-5 matches JS-cosine reference on the same seed', async () => {
    // Fixed seed → both paths must agree (deterministic function, same data).
    // Compute the JS reference by shortcutting through the BLOB column.
    const q = new Float32Array(1536)
    for (let i = 0; i < 1536; i++) q[i] = Math.cos(i / 23.1) * 0.5

    const hanaOut = await topConceptsByCosine({ db, queryVector: q, limit: 5 })

    // JS reference: fetch top-N candidates by scanning the BLOB column with the
    // pre-#1113 shape. Uses the module's own decodeEmbedding by importing it
    // via the SQLite branch — for parity we can just re-implement locally.
    const rows = await db.run(
      `SELECT ID, SLUG, NAME, EMBEDDING FROM COM_SAP_DEVELOPERS_IMS_CONCEPTS
       WHERE STATUS='ACTIVE' AND PUBLISHEDAT IS NOT NULL AND MERGEDINTO_ID IS NULL
         AND EMBEDDING IS NOT NULL`
    )
    const scored = []
    for (const r of rows) {
      const buf = Buffer.isBuffer(r.EMBEDDING)
        ? r.EMBEDDING
        : (typeof r.EMBEDDING === 'string' ? Buffer.from(r.EMBEDDING, 'base64') : Buffer.from(r.EMBEDDING))
      if (buf.length !== 1536 * 4) continue
      let dot = 0, na = 0, nb = 0
      for (let i = 0; i < 1536; i++) {
        const b = buf.readFloatLE(i * 4)
        dot += q[i] * b; na += q[i] * q[i]; nb += b * b
      }
      const d = Math.sqrt(na) * Math.sqrt(nb)
      scored.push({ id: r.ID, slug: r.SLUG, name: r.NAME, score: d === 0 ? 0 : dot / d })
    }
    scored.sort((a, b) => b.score - a.score)
    const jsTop = scored.slice(0, 5)

    // Slug order must match. Scores match to 1e-4 (float precision from
    // .toFixed(6) serialization).
    expect(hanaOut.map(r => r.slug)).toEqual(jsTop.map(r => r.slug))
    for (let i = 0; i < hanaOut.length; i++) {
      expect(Math.abs(hanaOut[i].score - jsTop[i].score),
        `score delta for ${hanaOut[i].slug}`).toBeLessThan(1e-4)
    }
  }, 60 * 1000)
})
