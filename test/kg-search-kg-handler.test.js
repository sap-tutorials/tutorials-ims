import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import cds from '@sap/cds'
import { readFileSync } from 'node:fs'
import { searchKgHandler } from '../srv/lib/kg/search-kg-handler.js'
import { enqueueOnDemandExtraction } from '../srv/lib/kg/on-demand-enqueue.js'

vi.mock('../srv/lib/kg/on-demand-enqueue.js', () => ({
  enqueueOnDemandExtraction: vi.fn().mockResolvedValue({ status: 'enqueued' }),
}))

function encode(vec) {
  const buf = Buffer.alloc(vec.length * 4)
  for (let i = 0; i < vec.length; i++) buf.writeFloatLE(vec[i], i * 4)
  return buf
}
function unit(i, dims = 1536) { const v = new Array(dims).fill(0); v[i] = 1; return v }

describe('searchKgHandler', () => {
  let db, embedClient
  const conceptIds = ['c-cap', 'c-cds', 'c-other']
  const tutorialIds = ['t-cap', 't-abap']

  beforeAll(async () => {
    cds.env.requires.db = { kind: 'sqlite', credentials: { url: ':memory:' } }
    db = await cds.connect.to('db')
    await cds.deploy(cds.model || 'db/schema.cds').to(db)
    const active = { status: 'ACTIVE', publishedAt: new Date().toISOString(), mergedInto_ID: null }
    await db.run(INSERT.into('com.sap.developers.ims.Concepts').entries([
      { ID: conceptIds[0], slug: 'cap-service', name: 'CAP Service',    embedding: encode(unit(0)), ...active },
      { ID: conceptIds[1], slug: 'cds-model',   name: 'CDS Model',      embedding: encode(unit(1)), ...active },
      { ID: conceptIds[2], slug: 'unrelated',   name: 'Unrelated',      embedding: encode(unit(2)), ...active },
    ]))
    await db.run(INSERT.into('com.sap.developers.ims.ConceptEdges').entries([
      { ID: cds.utils.uuid(), source_ID: conceptIds[0], target_ID: conceptIds[1], predicate: 'relatedTo', confidence: 0.8 },
    ]))
    await db.run(INSERT.into('com.sap.developers.ims.Tutorials').entries([
      { ID: tutorialIds[0], slug: 'build-cap-svc', title: 'Build a CAP service' },
      { ID: tutorialIds[1], slug: 'basic-abap',    title: 'Basic ABAP' },
    ]))
    await db.run(INSERT.into('com.sap.developers.ims.TutorialConceptLinks').entries([
      { ID: cds.utils.uuid(), tutorial_ID: tutorialIds[0], concept_ID: conceptIds[0], predicate: 'teaches', confidence: 0.9 },
      { ID: cds.utils.uuid(), tutorial_ID: tutorialIds[0], concept_ID: conceptIds[1], predicate: 'teaches', confidence: 0.7 },
      { ID: cds.utils.uuid(), tutorial_ID: tutorialIds[1], concept_ID: conceptIds[2], predicate: 'teaches', confidence: 0.9 },
    ]))
    embedClient = { embed: vi.fn(async () => Float32Array.from(unit(0))) }
  })
  afterAll(async () => { await db.disconnect?.() })

  it('returns concepts + tutorials for a valid query, sans queryEcho/rationale', async () => {
    const out = await searchKgHandler({
      db, embedClient, args: { term: 'cap service', maxConcepts: 3, maxTutorials: 5 },
    })
    expect(out).toHaveProperty('concepts')
    expect(out).toHaveProperty('tutorials')
    expect(out.queryEcho).toBeUndefined()
    expect(out.concepts.map(c => c.slug)).toContain('cap-service')
    expect(out.tutorials.map(t => t.slug)).toContain('build-cap-svc')
    for (const t of out.tutorials) expect(t.rationale).toBeUndefined()
  })

  it('returns { concepts: [], tutorials: [] } for empty/whitespace query — no error', async () => {
    const out = await searchKgHandler({ db, embedClient, args: { term: '   ' } })
    expect(out.concepts).toEqual([])
    expect(out.tutorials).toEqual([])
  })

  it('returns empty arrays on embed failure (fail-open, never throws)', async () => {
    const bad = { embed: vi.fn().mockRejectedValue(new Error('embed 500')) }
    const out = await searchKgHandler({ db, embedClient: bad, args: { term: 'anything' } })
    expect(out.concepts).toEqual([])
    expect(out.tutorials).toEqual([])
  })

  it('returns empty arrays when KG has no matching seeds', async () => {
    const empty = await cds.connect.to({ kind: 'sqlite', credentials: { url: ':memory:' } })
    await cds.deploy(cds.model || 'db/schema.cds').to(empty)
    const out = await searchKgHandler({ db: empty, embedClient, args: { term: 'anything' } })
    expect(out.concepts).toEqual([])
    expect(out.tutorials).toEqual([])
  })

  it('NEVER calls enqueueOnDemandExtraction — even on zero-seed queries', async () => {
    const empty = await cds.connect.to({ kind: 'sqlite', credentials: { url: ':memory:' } })
    await cds.deploy(cds.model || 'db/schema.cds').to(empty)
    await searchKgHandler({ db: empty, embedClient, args: { term: 'zzz nothing here' } })
    expect(enqueueOnDemandExtraction).not.toHaveBeenCalled()
  })

  it('handler source file does not import on-demand-enqueue.js (static guarantee)', () => {
    const src = readFileSync(new URL('../srv/lib/kg/search-kg-handler.js', import.meta.url), 'utf8')
    expect(src).not.toMatch(/on-demand-enqueue/)
    expect(src).not.toMatch(/enqueueOnDemandExtraction/)
  })

  it('clamps maxConcepts and maxTutorials to sane bounds', async () => {
    const out = await searchKgHandler({
      db, embedClient, args: { term: 'x', maxConcepts: 999, maxTutorials: -1 },
    })
    expect(out.concepts.length).toBeLessThanOrEqual(10)
    expect(out.tutorials.length).toBeGreaterThanOrEqual(0)
  })
})
