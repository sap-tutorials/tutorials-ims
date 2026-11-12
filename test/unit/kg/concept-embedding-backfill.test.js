// test/unit/kg/concept-embedding-backfill.test.js
//
// TDD for #1113 Task 2: backfill writes both embedding (BLOB) and
// embeddingVec (vector string on SQLite) in one UPDATE pass.
//
// TDD for #2810 Task 2: on HANA, backfill writes only EMBEDDING (BLOB);
// embeddingVec is now a GENERATED ALWAYS column and must NOT be explicitly
// written. On SQLite, existing behavior is unchanged.
//
// Mocks:
//   - job-lock.js (acquireLock/releaseLock): always acquire to avoid JobLocks
//     table dependency during unit tests.
//   - chat-settings-resolver.js (resolveEmbeddingSettings): returns a fixed
//     model name so the default embedClient constructor doesn't call AI Core.
//
// The embedClient is injected via opts so no real AI call is made.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import cds from '@sap/cds'

// Mock job-lock before importing the backfill module so vi.mock hoisting works.
vi.mock('../../../srv/jobs/job-lock.js', () => ({
  acquireLock: vi.fn(async () => true),
  releaseLock: vi.fn(async () => undefined),
}))

// Mock chat-settings-resolver so resolveEmbeddingSettings never hits the DB.
vi.mock('../../../srv/lib/chat-settings-resolver.js', () => ({
  resolveEmbeddingSettings: vi.fn(async () => ({ model: 'text-embedding-3-small' })),
  resolveChatLlmSettings: vi.fn(async () => ({ modelName: 'mock', deploymentId: 'mock' })),
}))

import { runConceptEmbeddingBackfill } from '../../../srv/jobs/concept-embedding-backfill.js'

describe('#1113 concept-embedding-backfill dual-column write', () => {
  let db
  const conceptIds = ['1113-c1', '1113-c2']

  beforeAll(async () => {
    cds.env.requires.db = { kind: 'sqlite', credentials: { url: ':memory:' } }
    db = await cds.connect.to('db')
    await cds.deploy(cds.model || 'db/schema.cds').to(db)
    const active = { status: 'ACTIVE', publishedAt: new Date().toISOString(), mergedInto_ID: null }
    await db.run(INSERT.into('com.sap.developers.ims.Concepts').entries([
      { ID: conceptIds[0], slug: '1113-c1', name: 'C1', description: 'd1', ...active },
      { ID: conceptIds[1], slug: '1113-c2', name: 'C2', description: 'd2', ...active },
    ]))
  })

  afterAll(async () => { await db.disconnect?.() })

  it('populates both embedding and embeddingVec columns for candidates missing either', async () => {
    const embedClient = { embed: vi.fn(async () => new Float32Array(1536).fill(0.001)) }
    const result = await runConceptEmbeddingBackfill({ db, embedClient })
    expect(result.processed).toBe(2)
    expect(result.failed).toBe(0)

    // Read back both columns
    const rows = await db.run(
      `SELECT ID, embedding, embeddingVec FROM com_sap_developers_ims_Concepts WHERE ID IN (?,?)`,
      conceptIds
    )
    for (const r of rows) {
      expect(r.embedding, 'BLOB column filled').toBeTruthy()
      // SQLite branch stores the vector-string form; HANA converts via TO_REAL_VECTOR
      expect(r.embeddingVec ?? r.EMBEDDINGVEC, 'vector column filled').toBeTruthy()
    }
  })
})

// ---------------------------------------------------------------------------
// #2810 Task 2: HANA branch must NOT write embeddingVec (generated column)
// ---------------------------------------------------------------------------
describe('#2810 concept-embedding-backfill HANA branch omits embeddingVec', () => {
  // Build a minimal HANA-shaped db mock that captures db.run() SQL calls.
  // The mock returns one candidate row from fetchCandidates, then records the
  // UPDATE SQL so we can assert on its text.
  const capturedSql = []

  function makeHanaMockDb() {
    return {
      kind: 'hana',
      run: vi.fn(async (sql, _params) => {
        capturedSql.push(sql.replace(/\s+/g, ' ').trim())
        // First call is fetchCandidates SELECT — return one row so the UPDATE fires.
        // Subsequent calls are the UPDATE — return nothing.
        if (/^SELECT/i.test(sql)) {
          return [{ ID: 'h1', SLUG: 'h1', NAME: 'Concept H1', DESCRIPTION: 'desc h1' }]
        }
        return []
      }),
    }
  }

  beforeEach(() => { capturedSql.length = 0 })

  it('HANA UPDATE contains SET EMBEDDING = ? and does NOT contain EMBEDDINGVEC', async () => {
    const db = makeHanaMockDb()
    const embedClient = { embed: vi.fn(async () => new Float32Array(1536).fill(0.002)) }
    await runConceptEmbeddingBackfill({ db, embedClient })

    const updateSql = capturedSql.find(s => /^UPDATE/i.test(s))
    expect(updateSql, 'UPDATE statement should have been issued').toBeTruthy()
    expect(updateSql).toMatch(/SET EMBEDDING = \?/i)
    expect(updateSql).not.toMatch(/EMBEDDINGVEC/i)
  })

  it('HANA fetchCandidates predicate selects on EMBEDDING IS NULL only (not EMBEDDINGVEC IS NULL)', async () => {
    const db = makeHanaMockDb()
    const embedClient = { embed: vi.fn(async () => new Float32Array(1536).fill(0.002)) }
    await runConceptEmbeddingBackfill({ db, embedClient })

    const selectSql = capturedSql.find(s => /^SELECT/i.test(s))
    expect(selectSql, 'SELECT statement should have been issued').toBeTruthy()
    // Must still filter on EMBEDDING IS NULL
    expect(selectSql).toMatch(/EMBEDDING IS NULL/i)
    // Must NOT include EMBEDDINGVEC IS NULL as a condition
    expect(selectSql).not.toMatch(/EMBEDDINGVEC IS NULL/i)
  })
})

// ---------------------------------------------------------------------------
// #2810 Task 2: SQLite branch must still write embeddingVec (unchanged)
// ---------------------------------------------------------------------------
describe('#2810 concept-embedding-backfill SQLite branch still writes embeddingVec', () => {
  const capturedSql = []

  function makeSqliteMockDb() {
    return {
      kind: 'sqlite',
      run: vi.fn(async (sql, _params) => {
        capturedSql.push(sql.replace(/\s+/g, ' ').trim())
        if (/^SELECT/i.test(sql)) {
          return [{ id: 's1', slug: 's1', name: 'Concept S1', description: 'desc s1' }]
        }
        return []
      }),
    }
  }

  beforeEach(() => { capturedSql.length = 0 })

  it('SQLite UPDATE still contains embeddingVec assignment (behavior unchanged)', async () => {
    const db = makeSqliteMockDb()
    const embedClient = { embed: vi.fn(async () => new Float32Array(1536).fill(0.003)) }
    await runConceptEmbeddingBackfill({ db, embedClient })

    const updateSql = capturedSql.find(s => /^UPDATE/i.test(s))
    expect(updateSql, 'UPDATE statement should have been issued').toBeTruthy()
    expect(updateSql).toMatch(/embedding = \?/i)
    expect(updateSql).toMatch(/embeddingVec = \?/i)
  })
})
