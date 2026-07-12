import { describe, it, expect, beforeAll, afterEach, afterAll, beforeEach, vi } from 'vitest'
import cds from '@sap/cds'
import { EXPAND_SEARCH_CONCEPTS_TOOL, expandSearchConceptsHandler } from '../srv/lib/kg/joule-tool-expand-concepts.js'
import { enqueueOnDemandExtraction } from '../srv/lib/kg/on-demand-enqueue.js'

// vi.mock is hoisted by Vitest to before all imports, so the mocked version of
// enqueueOnDemandExtraction is what joule-tool-expand-concepts.js receives too.
vi.mock('../srv/lib/kg/on-demand-enqueue.js', () => ({
  enqueueOnDemandExtraction: vi.fn().mockResolvedValue({ status: 'enqueued', normalizedKey: 'x' }),
}))

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

  it('returns { warning: "timeout" } when embed honours AbortSignal', async () => {
    const abortingClient = {
      embed: (_text, opts) => new Promise((_resolve, reject) => {
        opts?.signal?.addEventListener('abort', () => {
          const err = new Error('aborted')
          err.name = 'AbortError'
          reject(err)
        })
      }),
    }
    const out = await expandSearchConceptsHandler({
      db, embedClient: abortingClient, args: { query: 'slow' }, timeoutMs: 30,
    })
    expect(out.warning).toBe('timeout')
    expect(out.concepts).toEqual([])
    expect(out.tutorials).toEqual([])
  })

  it('returns { warning: "timeout" } when embed resolves after the deadline', async () => {
    const slowClient = {
      embed: () => new Promise(resolve => setTimeout(() => resolve(Float32Array.from(unit(0))), 60)),
    }
    const out = await expandSearchConceptsHandler({
      db, embedClient: slowClient, args: { query: 'lagging' }, timeoutMs: 30,
    })
    expect(out.warning).toBe('timeout')
    expect(out.concepts).toEqual([])
    expect(out.tutorials).toEqual([])
  })

  // #1114: db.run() ignores AbortSignal on HANA — a hanging cosine/edge/link
  // query must still return warning=timeout at the deadline, not stall the turn.
  it('returns { warning: "timeout" } fast when a DB leg hangs (db.run ignores signal)', async () => {
    const embedClientOk = { embed: async () => Float32Array.from(unit(0)) }
    const hangingDb = { kind: 'sqlite', run: () => new Promise(() => {}) }  // never settles
    const t0 = Date.now()
    const out = await expandSearchConceptsHandler({
      db: hangingDb, embedClient: embedClientOk, args: { query: 'db hangs here' }, timeoutMs: 40,
    })
    expect(out.warning).toBe('timeout')
    expect(out.concepts).toEqual([])
    expect(out.tutorials).toEqual([])
    expect(Date.now() - t0).toBeLessThan(1000)
  })
})

describe('expandSearchConcepts on-demand enqueue side-effect (#948)', () => {
  // Zero-seed db: in-memory SQLite with no concept embeddings that would match
  // any query vector. Reuses the same deploy pattern as the existing "no ACTIVE
  // concepts" test above — a fresh empty schema.
  let zeroSeedDb
  let happyDb
  const happyConceptIds = ['c-z1', 'c-z2']
  const happyTutorialId = 't-z1'

  beforeAll(async () => {
    // Zero-seed db: empty schema, no rows.
    zeroSeedDb = await cds.connect.to({ kind: 'sqlite', credentials: { url: ':memory:' } })
    await cds.deploy(cds.model || 'db/schema.cds').to(zeroSeedDb)

    // Happy-path db: mirrors the main describe block's setup so topConceptsByCosine
    // returns results and seeds.length > 0.
    happyDb = await cds.connect.to({ kind: 'sqlite', credentials: { url: ':memory:' } })
    await cds.deploy(cds.model || 'db/schema.cds').to(happyDb)
    const active = { status: 'ACTIVE', publishedAt: new Date().toISOString(), mergedInto_ID: null }
    await happyDb.run(INSERT.into('com.sap.developers.ims.Concepts').entries([
      { ID: happyConceptIds[0], slug: 'cap-z', name: 'CAP Z', embedding: encode(unit(0)), ...active },
      { ID: happyConceptIds[1], slug: 'btp-z', name: 'BTP Z', embedding: encode(unit(1)), ...active },
    ]))
    await happyDb.run(INSERT.into('com.sap.developers.ims.Tutorials').entries([
      { ID: happyTutorialId, slug: 'cap-intro-z', title: 'CAP Intro Z' },
    ]))
    await happyDb.run(INSERT.into('com.sap.developers.ims.TutorialConceptLinks').entries([
      { ID: cds.utils.uuid(), tutorial_ID: happyTutorialId, concept_ID: happyConceptIds[0], predicate: 'teaches', confidence: 0.9 },
    ]))
  })

  afterAll(async () => {
    await zeroSeedDb.disconnect?.()
    await happyDb.disconnect?.()
  })

  beforeEach(() => {
    vi.mocked(enqueueOnDemandExtraction).mockClear()
    vi.mocked(enqueueOnDemandExtraction).mockResolvedValue({ status: 'enqueued', normalizedKey: 'x' })
  })

  it('zero seeds → calls enqueueOnDemandExtraction with the raw query', async () => {
    const embedClient = { embed: vi.fn(async () => new Float32Array(1536)) }

    const result = await expandSearchConceptsHandler({
      db: zeroSeedDb, embedClient,
      args: { query: 'obscure query' },
      requester: { id: 'u1', kind: 'user' },
    })

    expect(result.concepts).toEqual([])
    expect(result.tutorials).toEqual([])
    expect(enqueueOnDemandExtraction).toHaveBeenCalledTimes(1)
    expect(enqueueOnDemandExtraction).toHaveBeenCalledWith(expect.objectContaining({
      query: 'obscure query',
      requester: { id: 'u1', kind: 'user' },
    }))
  })

  it('zero seeds + enqueue throws → tool STILL returns empty success (fire-and-forget)', async () => {
    vi.mocked(enqueueOnDemandExtraction).mockRejectedValueOnce(new Error('DB down'))
    const embedClient = { embed: vi.fn(async () => new Float32Array(1536)) }

    const result = await expandSearchConceptsHandler({
      db: zeroSeedDb, embedClient,
      args: { query: 'obscure query' },
      requester: { kind: 'anon', ipHash: 'ip1' },
    })

    expect(result.concepts).toEqual([])
    expect(result.tutorials).toEqual([])
    // No throw — fire-and-forget contract preserved.
  })

  it('non-zero seeds → enqueue is never called', async () => {
    const embedClient = { embed: vi.fn(async () => Float32Array.from(unit(0))) }

    await expandSearchConceptsHandler({
      db: happyDb, embedClient,
      args: { query: 'CAP' },
      requester: { id: 'u1', kind: 'user' },
    })

    expect(enqueueOnDemandExtraction).not.toHaveBeenCalled()
  })

  it('no requester → enqueue still called with kind:anon (backward-compat)', async () => {
    const embedClient = { embed: vi.fn(async () => new Float32Array(1536)) }

    await expandSearchConceptsHandler({
      db: zeroSeedDb, embedClient,
      args: { query: 'obscure query' },
    })

    expect(enqueueOnDemandExtraction).toHaveBeenCalledTimes(1)
    expect(enqueueOnDemandExtraction).toHaveBeenCalledWith(expect.objectContaining({
      requester: expect.objectContaining({ kind: 'anon' }),
    }))
  })
})
