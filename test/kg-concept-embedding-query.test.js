import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import cds from '@sap/cds'
import { topConceptsByCosine } from '../srv/lib/kg/concept-embedding-query.js'

// Encode a 1536-dim Float32 LE vector as a Buffer (BLOB payload shape)
function encode(vec) {
  const buf = Buffer.alloc(vec.length * 4)
  for (let i = 0; i < vec.length; i++) buf.writeFloatLE(vec[i], i * 4)
  return buf
}

function normalize(v) {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1
  return v.map(x => x / norm)
}

describe('topConceptsByCosine (SQLite path)', () => {
  let db
  beforeAll(async () => {
    cds.env.requires.db = { kind: 'sqlite', credentials: { url: ':memory:' } }
    db = await cds.connect.to('db')
    await cds.deploy(cds.model || 'db/schema.cds').to(db)
    const [c1, c2, c3] = ['a', 'b', 'c'].map(() => cds.utils.uuid())
    const active = { status: 'ACTIVE', publishedAt: new Date().toISOString(), mergedInto_ID: null }
    const v1 = normalize(Array(1536).fill(0).map((_, i) => (i === 0 ? 1 : 0)))
    const v2 = normalize(Array(1536).fill(0).map((_, i) => (i === 0 ? 0.9 : (i === 1 ? 0.1 : 0))))
    const v3 = normalize(Array(1536).fill(0).map((_, i) => (i === 1 ? 1 : 0)))
    await db.run(INSERT.into('com.sap.developers.ims.Concepts').entries([
      { ID: c1, slug: 'async-abap', name: 'Async ABAP', embedding: encode(v1), ...active },
      { ID: c2, slug: 'rap', name: 'RAP', embedding: encode(v2), ...active },
      { ID: c3, slug: 'other', name: 'Other', embedding: encode(v3), ...active },
    ]))
  })
  afterAll(async () => { await db.disconnect?.() })

  it('returns concepts ordered by cosine similarity, respecting publish gate', async () => {
    const query = normalize(Array(1536).fill(0).map((_, i) => (i === 0 ? 1 : 0)))
    const rows = await topConceptsByCosine({ db, queryVector: query, limit: 2 })
    expect(rows.map(r => r.slug)).toEqual(['async-abap', 'rap'])
    expect(rows[0].score).toBeGreaterThan(rows[1].score)
  })
})
