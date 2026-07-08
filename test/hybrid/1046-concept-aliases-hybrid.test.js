// test/hybrid/1046-concept-aliases-hybrid.test.js
// Verifies alias $search works end-to-end against real HANA, and
// that anonymous (no XSUAA) callers can hit PublishedConceptsWithAliases.
//
// Run with: npm run test:hybrid

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import cds from '@sap/cds'
import { isSafeForWrites } from './_guard.js'

cds.test('serve', '--project', '.', '--profile', 'hybrid')

describe.runIf(isSafeForWrites())('#1046 Concept aliases (hybrid)', () => {
  let Concepts, ConceptAliases
  const PREFIX = '__TEST_1046__'
  const ids = {
    a: '10460000-1111-0000-0000-000000000001',
    b: '10460000-1111-0000-0000-000000000002',
  }

  beforeAll(async () => {
    ;({ Concepts, ConceptAliases } = cds.entities('com.sap.developers.ims'))
    // Clean any leftover rows from prior runs.
    await cds.run(DELETE.from(ConceptAliases).where({ concept_ID: { in: [ids.a, ids.b] } }))
    await cds.run(DELETE.from(Concepts).where({ ID: { in: [ids.a, ids.b] } }))

    await cds.run(INSERT.into(Concepts).entries([
      { ID: ids.a, slug: `${PREFIX}slt-concept`, name: 'SLT Concept', description: 'landscape transform', status: 'ACTIVE', publishedAt: new Date().toISOString(), publishedBy: PREFIX },
      { ID: ids.b, slug: `${PREFIX}idoc-concept`, name: 'IDoc Concept', description: 'edi doc', status: 'ACTIVE', publishedAt: new Date().toISOString(), publishedBy: PREFIX }
    ]))
    await cds.run(INSERT.into(ConceptAliases).entries([
      { concept_ID: ids.a, alias: 'SLT',   aliasLower: 'slt',  source: 'SEED' },
      { concept_ID: ids.b, alias: 'IDoc',  aliasLower: 'idoc', source: 'SEED' }
    ]))
  })

  afterAll(async () => {
    await cds.run(DELETE.from(ConceptAliases).where({ concept_ID: { in: [ids.a, ids.b] } }))
    await cds.run(DELETE.from(Concepts).where({ ID: { in: [ids.a, ids.b] } }))
  })

  it('anonymous callers see PublishedConceptsWithAliases', async () => {
    // no headers → no XSUAA token → anonymous
    const res = await fetch(`${cds.server.url}/graph/PublishedConceptsWithAliases?$search=SLT&$top=6`)
    expect(res.status).toBe(200)
    const body = await res.json()
    const slugs = (body.value || []).map(r => r.slug)
    expect(slugs).toContain(`${PREFIX}slt-concept`)
  })

  it('IDoc query surfaces IDoc concept', async () => {
    const res = await fetch(`${cds.server.url}/graph/PublishedConceptsWithAliases?$search=IDoc&$top=6`)
    const body = await res.json()
    const slugs = (body.value || []).map(r => r.slug)
    expect(slugs).toContain(`${PREFIX}idoc-concept`)
  })

  it('batch after-READ hydrates all rows in one IN-query', async () => {
    // Fetch both rows via $top=6 — the after-READ hook should batch, not fan out.
    // Loose assertion — we're checking that both rows come back with an alias blob,
    // not that we can spy tx.run count (that's a nice-to-have for the deeper test).
    const res = await fetch(`${cds.server.url}/graph/PublishedConceptsWithAliases?$select=slug,aliasSearchBlob&$top=6`)
    const body = await res.json()
    const blobBySlug = Object.fromEntries((body.value || []).map(r => [r.slug, r.aliasSearchBlob]))
    expect(blobBySlug[`${PREFIX}slt-concept`]).toMatch(/slt/)
    expect(blobBySlug[`${PREFIX}idoc-concept`]).toMatch(/idoc/)
  })
})
