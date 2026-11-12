// test/hybrid/concepts-dbside-embedding.hybrid.test.js
//
// Proves the option-2 contract for Concepts.embeddingVec (#2810) against real
// HANA: the knowledge-graph tables are now JOURNALED (deploy as
// .hdbmigrationtable, so schema changes actually land), and embeddingVec is a
// PLAIN, WRITABLE REAL_VECTOR(1536) column populated by the Node embedding
// writers (backfill + mint) — NOT a DB-side GENERATED ALWAYS column.
//
// What is asserted:
//   1. INSERT a Concept WITHOUT embeddingVec → the column is NULL (no DB-side
//      auto-generation; the Node writer owns it). This is the regression guard
//      that a generated clause did NOT sneak back in.
//   2. A raw UPDATE writing TO_REAL_VECTOR(?) into embeddingVec SUCCEEDS and the
//      column reads back 1536-dim. A GENERATED ALWAYS column would REJECT the
//      write — so this proves the column is plain/writable (the option-2 goal).
//   3. The column's GENERATION_TYPE in SYS.TABLE_COLUMNS is NULL (definitive:
//      the column is not generated).
//
// Gotcha (CLAUDE.md): never SELECT the REAL_VECTOR alongside metadata via CDS QL
// — LOB-locator expiry on HANA. Use raw db.run() and read via CARDINALITY() so
// the vector is only consumed by a scalar, never returned as a column value.
//
// Self-skips locally (no hybrid binding): describe.runIf(isSafeForWrites())
// Run with: npx vitest run test/hybrid/concepts-dbside-embedding.hybrid.test.js --project hybrid

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import cds from '@sap/cds'
import { isSafeForWrites } from './_guard.js'

cds.test('serve', '--project', '.', '--profile', 'hybrid')

describe.runIf(isSafeForWrites())('#2810 Concepts.embeddingVec is a plain Node-written column (hybrid)', () => {
  let Concepts
  let db

  const PREFIX = '__TEST_2810_EMBED__'
  const ids = {
    plain: '28100000-9999-0000-0000-000000000001',   // INSERT without embeddingVec → NULL
    written: '28100000-9999-0000-0000-000000000002',  // then UPDATE writes a vector → 1536
  }

  // A deterministic 1536-dim unit-ish vector literal for the write test.
  const vecLiteral = '[' + Array.from({ length: 1536 }, (_, i) => (i === 0 ? '1.0' : '0.0')).join(',') + ']'

  beforeAll(async () => {
    db = await cds.connect.to('db')

    const kind = db?.kind ?? db?.options?.kind
    expect(kind, `expected HANA, got kind=${kind}`).toBe('hana')

    ;({ Concepts } = cds.entities('com.sap.developers.ims'))

    await cds.run(DELETE.from(Concepts).where({ ID: { in: Object.values(ids) } }))

    // INSERT both rows WITHOUT embeddingVec. If a GENERATED ALWAYS clause had
    // sneaked back in, HDI would auto-fill it; option-2 contract says it stays NULL.
    await cds.run(INSERT.into(Concepts).entries([
      {
        ID: ids.plain,
        slug: `${PREFIX}plain`,
        name: 'CAP Service Handlers',
        description: 'Event handlers registered with before/on/after in Node.js CAP services',
        status: 'ACTIVE',
        publishedAt: new Date().toISOString(),
        publishedBy: PREFIX,
        extractionCount: 1,
      },
      {
        ID: ids.written,
        slug: `${PREFIX}written`,
        name: 'OData Annotations',
        description: 'UI and persistence annotations on CDS services',
        status: 'ACTIVE',
        publishedAt: new Date().toISOString(),
        publishedBy: PREFIX,
        extractionCount: 1,
      },
    ]))
  }, 60_000)

  afterAll(async () => {
    await cds.run(DELETE.from(Concepts).where({ ID: { in: Object.values(ids) } }))
  }, 30_000)

  // ── Test 1: INSERT without embeddingVec leaves it NULL (not auto-generated) ──

  it('INSERT without embeddingVec leaves the column NULL (no DB-side generation)', async () => {
    const rows = await db.run(
      `SELECT CARDINALITY("EMBEDDINGVEC") AS "DIMS" FROM COM_SAP_DEVELOPERS_IMS_CONCEPTS WHERE "ID" = ?`,
      [ids.plain]
    )
    const dims = rows?.[0]?.DIMS ?? rows?.[0]?.dims
    expect(dims, 'embeddingVec must be NULL after a plain INSERT — a generated column would have auto-filled it').toBeNull()
  })

  // ── Test 2: a raw UPDATE writing the vector SUCCEEDS (column is writable) ────

  it('UPDATE writing TO_REAL_VECTOR into embeddingVec succeeds and reads back 1536-dim', async () => {
    // A GENERATED ALWAYS column would reject this UPDATE with a write error.
    await db.run(
      `UPDATE COM_SAP_DEVELOPERS_IMS_CONCEPTS SET "EMBEDDINGVEC" = TO_REAL_VECTOR(?) WHERE "ID" = ?`,
      [vecLiteral, ids.written]
    )
    const rows = await db.run(
      `SELECT CARDINALITY("EMBEDDINGVEC") AS "DIMS" FROM COM_SAP_DEVELOPERS_IMS_CONCEPTS WHERE "ID" = ?`,
      [ids.written]
    )
    const dims = rows?.[0]?.DIMS ?? rows?.[0]?.dims
    expect(dims, 'embeddingVec must be writable (plain column) and read back 1536-dim').toBe(1536)
  })

  // ── Test 3: GENERATION_TYPE is NULL — definitively not a generated column ────

  it('embeddingVec is NOT a generated column (GENERATION_TYPE is NULL)', async () => {
    const rows = await db.run(
      `SELECT "GENERATION_TYPE" AS "GT" FROM SYS.TABLE_COLUMNS
       WHERE "SCHEMA_NAME" = CURRENT_SCHEMA
         AND "TABLE_NAME" = 'COM_SAP_DEVELOPERS_IMS_CONCEPTS'
         AND "COLUMN_NAME" = 'EMBEDDINGVEC'`
    )
    const gt = rows?.[0]?.GT ?? rows?.[0]?.gt ?? null
    expect(gt, 'embeddingVec GENERATION_TYPE must be NULL (plain column, Node-written)').toBeNull()
  })
})
