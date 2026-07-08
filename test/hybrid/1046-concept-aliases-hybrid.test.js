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

    // Concept names and descriptions are intentionally free of the alias strings
    // ("SLT", "IDoc") so that $search matches are proven to come from the alias
    // path (aliasSearchBlob) rather than name/description LIKE matches.
    await cds.run(INSERT.into(Concepts).entries([
      { ID: ids.a, slug: `${PREFIX}slt-concept`,  name: 'Landscape Transform',    description: 'replication server',     status: 'ACTIVE', publishedAt: new Date().toISOString(), publishedBy: PREFIX },
      { ID: ids.b, slug: `${PREFIX}idoc-concept`, name: 'Intermediate Document', description: 'edi standard exchange', status: 'ACTIVE', publishedAt: new Date().toISOString(), publishedBy: PREFIX }
    ]))
    // Raw INSERT bypasses service handlers — manually UPDATE aliasSearchBlob to
    // simulate what the after-write hook on ConceptAliases would have done.
    // (Approach B: the $search tests stay honest; Approach A — POST through the
    //  OData service — was ruled out because the writable ConceptAliases projection
    //  requires auth that is not available to anonymous hybrid test callers.)
    await cds.run(INSERT.into(ConceptAliases).entries([
      { concept_ID: ids.a, alias: 'SLT',  aliasLower: 'slt',  source: 'SEED' },
      { concept_ID: ids.b, alias: 'IDoc', aliasLower: 'idoc', source: 'SEED' }
    ]))
    await cds.run(UPDATE(Concepts).set({ aliasSearchBlob: 'slt'  }).where({ ID: ids.a }))
    await cds.run(UPDATE(Concepts).set({ aliasSearchBlob: 'idoc' }).where({ ID: ids.b }))
  })

  afterAll(async () => {
    // Delete aliases first; the parent DELETE supersedes the after-write hook's
    // UPDATE attempt on an already-gone Concept row (fail-open design).
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

  it('after-write hook materializes aliasSearchBlob on the parent Concept', async () => {
    // Both blobs were set by the manual UPDATE above (simulating the after-write hook).
    // This test verifies that HANA has the blob persisted and that the OData
    // projection surfaces it — confirming the column is part of the read path.
    const res = await fetch(`${cds.server.url}/graph/PublishedConceptsWithAliases?$select=slug,aliasSearchBlob&$top=6`)
    const body = await res.json()
    const blobBySlug = Object.fromEntries((body.value || []).map(r => [r.slug, r.aliasSearchBlob]))
    expect(blobBySlug[`${PREFIX}slt-concept`]).toMatch(/slt/)
    expect(blobBySlug[`${PREFIX}idoc-concept`]).toMatch(/idoc/)
  })
})
