// test/scripts/concept-alias-backfill.smoke.test.js
// Smoke test for the AI Core-backed concept alias backfill (#1046 Task 10).
//
// Mock strategy:
//   - OrchestrationClient from @sap-ai-sdk/orchestration is mocked using
//     vi.hoisted so the constructor mock is available before vi.mock runs.
//   - resolveChatLlmSettings is mocked to bypass ChatSettings DB lookup and
//     the deploymentId-missing throw. Returns a stable { modelName, deploymentId }.
//   - The mock client's chatCompletion returns a plain-text response via
//     getContent() returning JSON { aliases: ['IDoc', 'idoc', 'I-Doc'] }.
//   - These three aliases collapse to 2 unique aliasLower values: 'idoc' and 'i-doc'.

import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest'
import path from 'node:path'
import cds from '@sap/cds'

// ---------------------------------------------------------------------------
// Mock setup — must be hoisted before any module is imported.
// ---------------------------------------------------------------------------

const { chatCompletionMock, OrchestrationClientMock } = vi.hoisted(() => {
  const chatCompletionMock = vi.fn()
  const OrchestrationClientMock = vi.fn(function () {
    this.chatCompletion = chatCompletionMock
  })
  return { chatCompletionMock, OrchestrationClientMock }
})

vi.mock('@sap-ai-sdk/orchestration', () => ({
  OrchestrationClient: OrchestrationClientMock,
}))

// Mock resolveChatLlmSettings so it doesn't require ChatSettings DB row
// and doesn't throw on missing deploymentId.
vi.mock('../../srv/lib/chat-settings-resolver.js', () => ({
  resolveChatLlmSettings: async () => ({
    modelName: 'mock-model',
    deploymentId: 'mock-deployment-id',
  }),
  resolveEmbeddingSettings: async () => ({ model: 'mock-embedding' }),
}))

// ---------------------------------------------------------------------------
// DB bootstrap — deploy schema once for the whole suite.
// ---------------------------------------------------------------------------

const schemaPath = path.join(process.cwd(), 'db', 'schema.cds')

beforeAll(async () => {
  await cds.deploy(schemaPath).to('sqlite::memory:')
  // Configure mock LLM response: returns three aliases where two lowercase to 'idoc'
  // and one to 'i-doc'. After deduplication we expect 2 rows per concept.
  chatCompletionMock.mockResolvedValue({
    getContent: () => JSON.stringify({ aliases: ['IDoc', 'idoc', 'I-Doc'] }),
    getTokenUsage: () => null,
  })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function seedConcept(slug, name) {
  const { Concepts } = cds.entities('com.sap.developers.ims')
  await cds.run(
    INSERT.into(Concepts).entries({
      slug, name, status: 'ACTIVE',
      publishedAt: new Date().toISOString(),
    })
  )
  return (await cds.run(SELECT.one.from(Concepts).where({ slug }))).ID
}

async function countAliases(conceptId) {
  const { ConceptAliases } = cds.entities('com.sap.developers.ims')
  const rows = await cds.run(SELECT.from(ConceptAliases).where({ concept_ID: conceptId }))
  return rows.length
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('#1046 concept-alias-backfill smoke', () => {
  afterEach(async () => {
    const { ConceptAliases, Concepts } = cds.entities('com.sap.developers.ims')
    await cds.run(DELETE.from(ConceptAliases))
    await cds.run(DELETE.from(Concepts).where({ slug: { like: 'smoke1046-%' } }))
  })

  it('collapses case-duplicate LLM output to one row per unique aliasLower', async () => {
    const id = await seedConcept('smoke1046-idoc', 'Intermediate Document')
    const { runBackfill } = await import('../../srv/scripts/concept-alias-backfill.js')
    await runBackfill({ dryRun: false, onlySlug: 'smoke1046-idoc' })
    // Mock returned ['IDoc', 'idoc', 'I-Doc'] — aliasLower ['idoc', 'idoc', 'i-doc']
    // → 2 rows after dedupe.
    expect(await countAliases(id)).toBe(2)
  })

  it('is idempotent — second run without --force is a no-op', async () => {
    const id = await seedConcept('smoke1046-mta', 'Multi-Target Application')
    const { runBackfill } = await import('../../srv/scripts/concept-alias-backfill.js')
    await runBackfill({ dryRun: false, onlySlug: 'smoke1046-mta' })
    const count1 = await countAliases(id)
    await runBackfill({ dryRun: false, onlySlug: 'smoke1046-mta' })  // no --force
    const count2 = await countAliases(id)
    expect(count2).toBe(count1)
  })

  it('--dry-run writes nothing', async () => {
    const id = await seedConcept('smoke1046-slt', 'SAP Landscape Transformation')
    const { runBackfill } = await import('../../srv/scripts/concept-alias-backfill.js')
    await runBackfill({ dryRun: true, onlySlug: 'smoke1046-slt' })
    expect(await countAliases(id)).toBe(0)
  })
})
