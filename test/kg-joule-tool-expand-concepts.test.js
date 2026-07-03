import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import cds from '@sap/cds'
import { EXPAND_SEARCH_CONCEPTS_TOOL, expandSearchConceptsHandler } from '../srv/lib/kg/joule-tool-expand-concepts.js'

function encode(vec) {
  const buf = Buffer.alloc(vec.length * 4)
  for (let i = 0; i < vec.length; i++) buf.writeFloatLE(vec[i], i * 4)
  return buf
}
function unit(i, dims = 1536) { const v = new Array(dims).fill(0); v[i] = 1; return v }

describe('EXPAND_SEARCH_CONCEPTS_TOOL descriptor', () => {
  it('uses OpenAI function-calling shape (bare parameters)', () => {
    expect(EXPAND_SEARCH_CONCEPTS_TOOL.type).toBe('function')
    expect(EXPAND_SEARCH_CONCEPTS_TOOL.function.name).toBe('expandSearchConcepts')
    expect(EXPAND_SEARCH_CONCEPTS_TOOL.function.parameters.properties.query).toBeDefined()
    expect(EXPAND_SEARCH_CONCEPTS_TOOL.function.parameters.required).toContain('query')
    // NOT wrapped in input_schema (Anthropic shape) — see feedback_llm_adapter_schema_shape (PR #885)
    expect(EXPAND_SEARCH_CONCEPTS_TOOL.function.input_schema).toBeUndefined()
  })
})

describe('expandSearchConceptsHandler', () => {
  let db, embedClient
  const conceptIds = ['c-async', 'c-rap', 'c-other']
  const tutorialIds = ['t-rap', 't-abap']

  beforeAll(async () => {
    cds.env.requires.db = { kind: 'sqlite', credentials: { url: ':memory:' } }
    db = await cds.connect.to('db')
    await cds.deploy(cds.model || 'db/schema.cds').to(db)
    const active = { status: 'ACTIVE', publishedAt: new Date().toISOString(), mergedInto_ID: null }
    await db.run(INSERT.into('com.sap.developers.ims.Concepts').entries([
      { ID: conceptIds[0], slug: 'async-abap', name: 'Asynchronous ABAP', embedding: encode(unit(0)), ...active },
      { ID: conceptIds[1], slug: 'rap',        name: 'RAP',                embedding: encode(unit(1)), ...active },
      { ID: conceptIds[2], slug: 'other',      name: 'Other',              embedding: encode(unit(2)), ...active },
    ]))
    await db.run(INSERT.into('com.sap.developers.ims.ConceptEdges').entries([
      { ID: cds.utils.uuid(), source_ID: conceptIds[0], target_ID: conceptIds[1], predicate: 'relatedTo', confidence: 0.8 },
    ]))
    await db.run(INSERT.into('com.sap.developers.ims.Tutorials').entries([
      { ID: tutorialIds[0], slug: 'abap-async-rap', title: 'Async RAP in ABAP Cloud' },
      { ID: tutorialIds[1], slug: 'basic-abap',     title: 'Basic ABAP' },
    ]))
    await db.run(INSERT.into('com.sap.developers.ims.TutorialConceptLinks').entries([
      { ID: cds.utils.uuid(), tutorial_ID: tutorialIds[0], concept_ID: conceptIds[0], predicate: 'teaches', confidence: 0.9 },
      { ID: cds.utils.uuid(), tutorial_ID: tutorialIds[0], concept_ID: conceptIds[1], predicate: 'teaches', confidence: 0.7 },
      { ID: cds.utils.uuid(), tutorial_ID: tutorialIds[1], concept_ID: conceptIds[2], predicate: 'teaches', confidence: 0.9 },
    ]))
    embedClient = { embed: vi.fn(async () => Float32Array.from(unit(0))) }
  })
  afterAll(async () => { await db.disconnect?.() })

  it('returns concepts + tutorials with rationales for a valid query', async () => {
    const out = await expandSearchConceptsHandler({
      db, embedClient, args: { query: 'async abap', maxConcepts: 3, maxTutorials: 5 },
    })
    expect(out.queryEcho).toBe('async abap')
    expect(out.concepts.map(c => c.slug)).toContain('async-abap')
    expect(out.tutorials.map(t => t.slug)).toContain('abap-async-rap')
    const rap = out.tutorials.find(t => t.slug === 'abap-async-rap')
    expect(rap.rationale).toMatch(/Asynchronous ABAP|RAP/)
  })

  it('clamps out-of-range maxConcepts and maxTutorials', async () => {
    const out = await expandSearchConceptsHandler({
      db, embedClient, args: { query: 'x', maxConcepts: 999, maxTutorials: -1 },
    })
    expect(out.concepts.length).toBeLessThanOrEqual(10)
    expect(out.tutorials.length).toBeGreaterThanOrEqual(0)
  })

  it('rejects empty query', async () => {
    const out = await expandSearchConceptsHandler({ db, embedClient, args: { query: '   ' } })
    expect(out.error).toBeDefined()
  })

  it('rejects overlong query', async () => {
    const out = await expandSearchConceptsHandler({
      db, embedClient, args: { query: 'x'.repeat(201) },
    })
    expect(out.error).toBeDefined()
  })

  it('returns empty arrays when KG has no ACTIVE concepts', async () => {
    const empty = await cds.connect.to({ kind: 'sqlite', credentials: { url: ':memory:' } })
    await cds.deploy(cds.model || 'db/schema.cds').to(empty)
    const out = await expandSearchConceptsHandler({ db: empty, embedClient, args: { query: 'anything' } })
    expect(out.concepts).toEqual([])
    expect(out.tutorials).toEqual([])
  })
})
