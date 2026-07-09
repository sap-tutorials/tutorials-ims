// test/unit/kg/concept-embedding-backfill.test.js
//
// TDD for #1113 Task 2: backfill writes both embedding (BLOB) and
// embeddingVec (vector string on SQLite) in one UPDATE pass.
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
