import cds from '@sap/cds'
import { describe, it, beforeAll, expect } from 'vitest'

// Phase 3 #446 — SearchableItems indexes published concepts.
//
// Read-only against bound HANA. Asserts:
//   1. A published concept appears as a row with taskType='CONCEPT' in
//      the SearchService.SearchableItems entity.
//   2. The view's CONCEPT branch never surfaces unpublished or vetoed
//      rows — every visible CONCEPT row has publishedAt IS NOT NULL
//      AND status = 'ACTIVE'.
//
// When the env has no published concepts (fresh deploy / QA), tests
// call `ctx.skip()` so vitest reports a VISIBLE skip rather than a
// silent pass — same posture as the Task 2 smoke test.

cds.test('serve', '--project', '.', '--profile', 'hybrid')

describe('SearchableItems includes published concepts', () => {
  let search

  beforeAll(async () => {
    search = await cds.connect.to('SearchService')
  })

  it('returns a published concept row when read by slug', async (ctx) => {
    // Pick a real published concept from the DB so we exercise the
    // production UNION branch end-to-end rather than mocking a slug.
    const sample = await SELECT.one
      .from('com.sap.developers.ims.Concepts')
      .columns('slug', 'name')
      .where({ publishedAt: { '!=': null }, status: 'ACTIVE' })

    if (!sample) {
      // Visible skip — no published concepts on this env. Surfaces in
      // CI as a skipped test, not a silent PASS.
      ctx.skip()
      return
    }

    const rows = await search.read('SearchableItems').where({ slug: sample.slug, taskType: 'CONCEPT' })
    expect(rows.length).toBeGreaterThan(0)
    const row = rows[0]
    expect(row.slug).toBe(sample.slug)
    expect(row.title).toBe(sample.name)
    expect(row.taskType).toBe('CONCEPT')
  })

  it('does NOT return unpublished or vetoed concepts', async (ctx) => {
    // Read everything taskType=CONCEPT, then cross-check that each row's
    // backing Concepts entity is in the gated state. If the view ever
    // leaks an unpublished or VETOED row, this fails.
    const rows = await search.read('SearchableItems').where({ taskType: 'CONCEPT' })
    if (rows.length === 0) {
      ctx.skip()
      return
    }

    const slugs = rows.map(r => r.slug)
    const conceptRows = await SELECT.from('com.sap.developers.ims.Concepts')
      .columns('slug', 'publishedAt', 'status')
      .where({ slug: { in: slugs } })

    // Every concept that appears in the search view must satisfy the gate.
    expect(conceptRows.length).toBeGreaterThan(0)
    for (const r of conceptRows) {
      expect(r.publishedAt, `concept ${r.slug} should be published`).not.toBeNull()
      expect(r.status, `concept ${r.slug} should be ACTIVE`).toBe('ACTIVE')
    }
  })
})
