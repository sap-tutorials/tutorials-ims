import { describe, it, beforeAll, afterAll, expect } from 'vitest'
import path from 'node:path'
import cds from '@sap/cds'

// #708 — fetch-learning-journeys-job is not crash-safe (partial-state).
//
// The fix introduces a `lastExtractedHash` column distinct from
// `contentHash`. The cron sets contentHash on upsert (step 2) and
// lastExtractedHash only AFTER successful link persist (step 4). The
// re-extraction gate reads `lastExtractedHash !== contentHash`, so a crash
// between DELETE and INSERT leaves lastExtractedHash at the PREVIOUS value
// and the next cycle re-extracts.
//
// These tests assert the gate semantics against the actual CDS schema +
// query path, since the cron orchestrator itself is too coupled to MCP and
// the LLM for direct unit testing. The hybrid test
// (test/hybrid/learning-journeys-cron.test.js) exercises the end-to-end path
// against real HANA.
describe('LearningJourneys lastExtractedHash gate (#708)', () => {
  beforeAll(async () => {
    const schemaRoots = [
      path.join(process.cwd(), 'db'),
      path.join(process.cwd(), 'srv'),
    ]
    await cds.deploy(schemaRoots).to('sqlite::memory:')
  })

  afterAll(async () => {
    await cds.disconnect()
  })

  it('signals re-extraction when lastExtractedHash !== contentHash (crash mid-extract)', async () => {
    const { LearningJourneys } = cds.entities('com.sap.developers.ims.external')
    const slug = 'crashed-journey'
    await INSERT.into(LearningJourneys).entries({
      slug,
      title: 'Crashed Journey',
      url: 'https://learning.sap.com/learning-journeys/crashed-journey',
      contentHash: 'HASH_V2',
      // lastExtractedHash NOT set (or set to a previous hash) — simulates the
      // state after a cron crash between the upsert and the link persist.
      lastExtractedHash: 'HASH_V1',
    })

    const existing = await SELECT.one
      .from(LearningJourneys)
      .columns('ID', 'contentHash', 'lastExtractedHash')
      .where({ slug })

    const newHash = 'HASH_V2'
    const needsExtraction = !existing || existing.lastExtractedHash !== newHash
    expect(needsExtraction).toBe(true)
  })

  it('skips re-extraction when lastExtractedHash === contentHash (clean prior run)', async () => {
    const { LearningJourneys } = cds.entities('com.sap.developers.ims.external')
    const slug = 'clean-journey'
    await INSERT.into(LearningJourneys).entries({
      slug,
      title: 'Clean Journey',
      url: 'https://learning.sap.com/learning-journeys/clean-journey',
      contentHash: 'HASH_V2',
      // Both hashes match — last extraction completed cleanly.
      lastExtractedHash: 'HASH_V2',
    })

    const existing = await SELECT.one
      .from(LearningJourneys)
      .columns('ID', 'contentHash', 'lastExtractedHash')
      .where({ slug })

    const newHash = 'HASH_V2'
    const needsExtraction = !existing || existing.lastExtractedHash !== newHash
    expect(needsExtraction).toBe(false)
  })

  it('signals re-extraction when lastExtractedHash is null (never extracted)', async () => {
    const { LearningJourneys } = cds.entities('com.sap.developers.ims.external')
    const slug = 'never-extracted'
    await INSERT.into(LearningJourneys).entries({
      slug,
      title: 'Never Extracted',
      url: 'https://learning.sap.com/learning-journeys/never-extracted',
      contentHash: 'HASH_V1',
      // lastExtractedHash omitted — newly-inserted journey, never extracted.
    })

    const existing = await SELECT.one
      .from(LearningJourneys)
      .columns('ID', 'contentHash', 'lastExtractedHash')
      .where({ slug })

    expect(existing.lastExtractedHash).toBeNull()

    const newHash = 'HASH_V1'
    const needsExtraction = !existing || existing.lastExtractedHash !== newHash
    expect(needsExtraction).toBe(true)
  })

  it('UPDATE of lastExtractedHash transitions a journey from re-extract to skip', async () => {
    const { LearningJourneys } = cds.entities('com.sap.developers.ims.external')
    const slug = 'transitions'
    await INSERT.into(LearningJourneys).entries({
      slug,
      title: 'Transitions',
      url: 'https://learning.sap.com/learning-journeys/transitions',
      contentHash: 'HASH_V3',
      lastExtractedHash: 'HASH_V2',
    })

    const before = await SELECT.one
      .from(LearningJourneys)
      .columns('ID', 'lastExtractedHash')
      .where({ slug })
    expect(before.lastExtractedHash !== 'HASH_V3').toBe(true) // gate fires

    // Simulate the post-persist UPDATE the cron now performs (#708 fix).
    await UPDATE(LearningJourneys)
      .set({ lastExtractedHash: 'HASH_V3' })
      .where({ ID: before.ID })

    const after = await SELECT.one
      .from(LearningJourneys)
      .columns('lastExtractedHash')
      .where({ slug })
    expect(after.lastExtractedHash).toBe('HASH_V3')
    expect(after.lastExtractedHash !== 'HASH_V3').toBe(false) // gate now skips
  })
})
