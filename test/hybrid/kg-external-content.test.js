// test/hybrid/kg-external-content.test.js
// #1125 — exercises the fetchExternalContentLinks HANA-dialect branch
// (unit-untestable due to HANA UNION ALL syntax + double-quoted aliases)
// against a real HANA binding. Proves the lowercase-key contract from #1113.
//
// GATING: runs by default with `npm run test:hybrid` as long as isSafeForWrites().
// No env-flag opt-in needed — seeds one Concept + ApiDocs + ApiDocConceptLinks
// row and deletes them in afterAll.
//
// Run:
//   npx vitest run test/hybrid/kg-external-content.test.js --project hybrid

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import cds from '@sap/cds'
import { isSafeForWrites } from './_guard.js'
import { fetchExternalContentLinks } from '../../srv/lib/kg/_search-fetches.js'

cds.test('serve', '--project', '.', '--profile', 'hybrid')

describe.runIf(isSafeForWrites())('#1125 external content — HANA dialect', () => {
  // Stable IDs so cleanup can DELETE by ID even if a test dies mid-INSERT.
  const CONCEPT_ID = '00000000-0000-0000-0000-112500000001'
  const APIDOC_ID  = '00000000-0000-0000-0000-112500000002'
  const LINK_ID    = '00000000-0000-0000-0000-112500000003'

  const SLUG_PREFIX  = 'ec1125-'
  const CONCEPT_SLUG = `${SLUG_PREFIX}test-concept`
  const APIDOC_SLUG  = `${SLUG_PREFIX}test-api-doc`

  let db

  beforeAll(async () => {
    db = await cds.connect.to('db')
    const kind = db?.kind || db?.options?.kind
    expect(kind, `expected HANA, got kind=${kind}`).toBe('hana')

    const { Concepts } = cds.entities('com.sap.developers.ims')
    const { ApiDocs, ApiDocConceptLinks } = cds.entities('com.sap.developers.ims.external')

    // Seed one Concept.
    await INSERT.into(Concepts).entries({
      ID: CONCEPT_ID,
      slug: CONCEPT_SLUG,
      name: '__TEST__ EC1125 External Content Test Concept',
      status: 'ACTIVE',
    })

    // Seed one ApiDocs row. lastSeenAt = now so it sits within any TTL window.
    await INSERT.into(ApiDocs).entries({
      ID: APIDOC_ID,
      slug: APIDOC_SLUG,
      title: '__TEST__ EC1125 Test API Doc',
      url: 'https://api.sap.com/__test__/ec1125',
      lastSeenAt: new Date().toISOString(),
    })

    // Seed the link joining them.
    await INSERT.into(ApiDocConceptLinks).entries({
      ID: LINK_ID,
      apiDoc_ID: APIDOC_ID,
      concept_ID: CONCEPT_ID,
      predicate: 'officialReferenceFor',
      confidence: 0.9,
    })
  }, 30_000)

  afterAll(async () => {
    if (!db) return
    const { Concepts } = cds.entities('com.sap.developers.ims')
    const { ApiDocs, ApiDocConceptLinks } = cds.entities('com.sap.developers.ims.external')

    // Delete in FK-safe order: link rows first, then content rows, then concept.
    try {
      await DELETE.from(ApiDocConceptLinks).where({ ID: LINK_ID })
    } catch (_) { /* best-effort */ }
    try {
      await DELETE.from(ApiDocs).where({ ID: APIDOC_ID })
    } catch (_) { /* best-effort */ }
    try {
      await DELETE.from(Concepts).where({ ID: CONCEPT_ID })
    } catch (_) { /* best-effort */ }

    // Belt-and-braces sweep by slug prefix so a rerun after a partial-cleanup
    // failure doesn't trip @assert.unique.slug on the next run.
    try {
      await DELETE.from(ApiDocConceptLinks).where({ apiDoc_ID: APIDOC_ID })
    } catch (_) { /* best-effort */ }
    try {
      await DELETE.from(ApiDocs).where({ slug: { like: `${SLUG_PREFIX}%` } })
    } catch (_) { /* best-effort */ }
    try {
      await DELETE.from(Concepts).where({ slug: { like: `${SLUG_PREFIX}%` } })
    } catch (_) { /* best-effort */ }
  }, 30_000)

  it('fetchExternalContentLinks returns lowercased-key rows for a seeded api-doc concept link', async () => {
    const rows = await fetchExternalContentLinks(db, [CONCEPT_ID])

    // Unconditional — seeded fixture must always be present; a zero-row result
    // means the UNION or the link-insert failed, not that DEV is sparse.
    expect(rows.length, `expected at least one row for concept ${CONCEPT_ID}`).toBeGreaterThan(0)

    const apiDocRow = rows.find((r) => r.content_type === 'api-doc' && r.slug === APIDOC_SLUG)
    expect(
      apiDocRow,
      `expected api-doc row with slug=${APIDOC_SLUG} in ${JSON.stringify(rows)}`,
    ).toBeDefined()

    // Lowercase-key contract — HANA folds UNQUOTED aliases to uppercase; the
    // double-quoted aliases in the HANA branch of fetchExternalContentLinks
    // preserve lowercase (#1113). Presence of CONTENT_TYPE would mean the
    // fix regressed.
    expect(apiDocRow).toHaveProperty('content_type')
    expect(apiDocRow).toHaveProperty('concept_id')
    expect(apiDocRow).toHaveProperty('slug')
    expect(apiDocRow).toHaveProperty('url')
    expect(apiDocRow).not.toHaveProperty('CONTENT_TYPE')
  })
})
