// test/hybrid/concepts-dbside-embedding.hybrid.test.js
//
// Proves the DB-side GENERATED ALWAYS AS (VECTOR_EMBEDDING(...)) contract for
// Concepts.embeddingVec (#2810 Unit 1) against real HANA.
//
// What is asserted:
//   1. INSERT a Concept with name + description, NO embeddingVec → the generated
//      column auto-fills with a valid 1536-dim REAL_VECTOR (CARDINALITY check).
//   2. INSERT a Concept with name only (null description) → still 1536-dim
//      (the COALESCE(description,'') fallback embeds name alone).
//   3. Two rows with identical name+description score COSINE_SIMILARITY ≈ 1.0
//      (self-consistency: DB-side embedding is deterministic for the same text).
//
// Gotcha (CLAUDE.md): never SELECT the REAL_VECTOR alongside metadata via CDS QL
// — LOB-locator expiry on HANA. Use raw db.run() and read via CARDINALITY() or
// COSINE_SIMILARITY() so the vector is only consumed by a scalar, never returned
// as a column value.
//
// Self-skips locally (no hybrid binding): describe.runIf(isSafeForWrites())
// Run with: npx vitest run test/hybrid/concepts-dbside-embedding.hybrid.test.js --project hybrid

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import cds from '@sap/cds'
import { isSafeForWrites } from './_guard.js'

cds.test('serve', '--project', '.', '--profile', 'hybrid')

describe.runIf(isSafeForWrites())('#2810 DB-side Concepts.embeddingVec (hybrid)', () => {
  let Concepts
  let db

  // Fixed test IDs in a distinct range — unlikely to collide with real data.
  const PREFIX = '__TEST_2810_EMBED__'
  const ids = {
    full: '28100000-9999-0000-0000-000000000001',  // name + description
    nameOnly: '28100000-9999-0000-0000-000000000002',  // name only, null description
    twin: '28100000-9999-0000-0000-000000000003',  // identical text to `full` (self-consistency)
  }

  beforeAll(async () => {
    db = await cds.connect.to('db')

    // Sanity: confirm we're actually on HANA. If we silently fell back to
    // SQLite, the GENERATED ALWAYS column doesn't exist and every CARDINALITY
    // assertion would trivially pass on nothing useful.
    const kind = db?.kind ?? db?.options?.kind
    expect(kind, `expected HANA, got kind=${kind}`).toBe('hana')

    ;({ Concepts } = cds.entities('com.sap.developers.ims'))

    // Clean up any leftover rows from prior interrupted runs.
    await cds.run(DELETE.from(Concepts).where({ ID: { in: Object.values(ids) } }))

    // INSERT all three test rows WITHOUT supplying embeddingVec.
    // On HANA the GENERATED ALWAYS column auto-fills from name+description.
    // insertMintedConcept is not used here: we go through CQL INSERT directly
    // so the test proves the raw column contract (not the helper's logic).
    await cds.run(INSERT.into(Concepts).entries([
      {
        ID: ids.full,
        slug: `${PREFIX}full`,
        name: 'CAP Service Handlers',
        description: 'Event handlers registered with before/on/after in Node.js CAP services',
        status: 'ACTIVE',
        publishedAt: new Date().toISOString(),
        publishedBy: PREFIX,
        extractionCount: 1,
      },
      {
        ID: ids.nameOnly,
        slug: `${PREFIX}name-only`,
        name: 'OData Annotations',
        description: null,   // null description — generated expr falls back to name alone
        status: 'ACTIVE',
        publishedAt: new Date().toISOString(),
        publishedBy: PREFIX,
        extractionCount: 1,
      },
      {
        ID: ids.twin,
        slug: `${PREFIX}twin`,
        name: 'CAP Service Handlers',       // identical to ids.full
        description: 'Event handlers registered with before/on/after in Node.js CAP services',
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

  // ── Test 1: name + description → 1536-dim vector ───────────────────────────

  it('name+description row has embeddingVec auto-filled to 1536 dims', async () => {
    // CARDINALITY(col) returns the number of dimensions in a REAL_VECTOR.
    // We read it via raw SQL to avoid selecting the LOB/vector column directly.
    const rows = await db.run(
      `SELECT CARDINALITY("EMBEDDINGVEC") AS "DIMS" FROM COM_SAP_DEVELOPERS_IMS_CONCEPTS WHERE "ID" = ?`,
      [ids.full]
    )
    const dims = rows?.[0]?.DIMS ?? rows?.[0]?.dims
    expect(dims, 'embeddingVec must be non-null and 1536-dim for name+description row').toBe(1536)
  })

  // ── Test 2: name-only (null description) → still 1536-dim ──────────────────

  it('name-only row (null description) still produces a 1536-dim embeddingVec', async () => {
    // The GENERATED expr: COALESCE(description,'') → '' when null, so the
    // concatenation falls back to name alone. VECTOR_EMBEDDING of a non-empty
    // string must still yield a valid 1536-dim vector.
    const rows = await db.run(
      `SELECT CARDINALITY("EMBEDDINGVEC") AS "DIMS" FROM COM_SAP_DEVELOPERS_IMS_CONCEPTS WHERE "ID" = ?`,
      [ids.nameOnly]
    )
    const dims = rows?.[0]?.DIMS ?? rows?.[0]?.dims
    expect(dims, 'name-only row must produce a 1536-dim embeddingVec').toBe(1536)
  })

  // ── Test 3: self-consistency — two identical-text rows score ≈ 1.0 ─────────

  it('two rows with identical name+description have cosine ≈ 1.0 (embedding is deterministic)', async () => {
    // COSINE_SIMILARITY(a, b) = 1.0 when a and b are the same vector.
    // Both ids.full and ids.twin have the same name+description, so the
    // GENERATED ALWAYS expression should produce the same output.
    // Reading each row's EMBEDDINGVEC via TO_REAL_VECTOR is not needed here —
    // we compute the scalar inside HANA so neither vector value crosses the wire.
    const rows = await db.run(
      `SELECT COSINE_SIMILARITY(a."EMBEDDINGVEC", b."EMBEDDINGVEC") AS "SIM"
       FROM COM_SAP_DEVELOPERS_IMS_CONCEPTS a,
            COM_SAP_DEVELOPERS_IMS_CONCEPTS b
       WHERE a."ID" = ? AND b."ID" = ?`,
      [ids.full, ids.twin]
    )
    const sim = rows?.[0]?.SIM ?? rows?.[0]?.sim
    expect(typeof sim, 'COSINE_SIMILARITY must return a numeric score').toBe('number')
    // Allow ±0.001 tolerance for floating-point rounding in the DB.
    expect(sim, `identical-text rows should have cosine ≈ 1.0, got ${sim}`).toBeGreaterThan(0.999)
  })
})
