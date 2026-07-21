// test/hybrid/joule-find-path-handler.test.js
//
// Handler-level hybrid guard for findLearningPathHandler (issue #445).
//
// WHY THIS EXISTS: the KG_QUERY PATH_BETWEEN procedure has its own hybrid test
// (kg-path-between.test.js), and the tool-pick discrimination has an AI-judge
// fixture — but NOTHING exercised the handler's own hydration SQL against real
// HANA. That gap let `SELECT ... ESTIMATEDTIMEMINUTES` ship: a nonexistent
// column that threw `invalid column name` on every real call, which the
// orchestrator swallowed into "couldn't compute a route". Unit tests use
// SQLite + CQL and never hit the raw column name. This test runs the whole
// handler against HANA so a wrong column name fails loudly here.
//
// HOW TO RUN
//   npx cds bind --exec -- npx vitest run --project hybrid \
//     test/hybrid/joule-find-path-handler.test.js

import { describe, it, expect, beforeAll } from 'vitest'
import cds from '@sap/cds'
import { findLearningPathHandler } from '../../srv/lib/kg/joule-tool-find-path.js'

// Known-valid DEV slug pair (both confirmed present in Tutorials, 2026-07-21).
const FROM_SLUG = 'abap-create-basic-app'
const TO_SLUG = 'abap-create-project'

describe('findLearningPathHandler — end-to-end against HANA (issue #445)', () => {
  let db

  beforeAll(async () => {
    db = await cds.connect.to('db')
    const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService'
    if (!isHana) throw new Error('joule-find-path-handler.test.js requires HANA. Use `npm run test:hybrid`.')
  })

  it('returns a rendered path (not an error string) for a valid slug pair', async () => {
    const out = await findLearningPathHandler({
      db,
      args: { fromSlug: FROM_SLUG, toSlug: TO_SLUG },
      user: null,
      telemetry: null,
    })

    // The handler swallows SQL errors into these friendly strings; assert we
    // got NONE of them — i.e. the hydration SQL actually ran.
    expect(out).not.toMatch(/Internal error finding a learning path/i)
    expect(out).not.toMatch(/couldn't find a path/i)
    expect(out).not.toMatch(/timed out/i)

    // A real rendered path starts with the "Here's a path" header and contains
    // at least one numbered tutorial link.
    expect(out).toMatch(/Here's a path from/i)
    expect(out).toMatch(/\d+\.\s+\*\*.+\*\*\s+—\s+\[[a-z0-9-]+\]/)
  }, 30_000)

  it('hydration query column exists — a bare SELECT of the real column succeeds', async () => {
    // Direct guard on the exact column the handler hydrates. If someone renames
    // it back to a nonexistent column, this throws `invalid column name` here
    // rather than silently degrading Joule.
    const rows = await db.run(
      `SELECT SLUG, TITLE, AVERAGETIMETOCOMPLETE
       FROM COM_SAP_DEVELOPERS_IMS_TUTORIALS
       WHERE SLUG = ?`,
      [TO_SLUG]
    )
    expect(rows.length).toBe(1)
    expect(rows[0].SLUG).toBe(TO_SLUG)
    // Column resolves (value may be null, but the SELECT must not throw).
    expect('AVERAGETIMETOCOMPLETE' in rows[0]).toBe(true)
  }, 15_000)
})
