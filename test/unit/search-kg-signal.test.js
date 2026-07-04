// test/unit/search-kg-signal.test.js
//
// Unit tests for srv/lib/search-kg-signal.js (issue #945).
// In-memory SQLite; seeds a tiny KG (mirrors test/kg-joule-tool-expand-concepts.test.js).

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import cds from '@sap/cds'
import {
  computeKgSignal,
  buildKgRankFragment,
  peekSignal,
  KG_WEIGHT,
  _resetForTest,
} from '../../srv/lib/search-kg-signal.js'

function encode(vec) {
  const buf = Buffer.alloc(vec.length * 4)
  for (let i = 0; i < vec.length; i++) buf.writeFloatLE(vec[i], i * 4)
  return buf
}
function unit(i, dims = 1536) {
  const v = new Array(dims).fill(0)
  v[i] = 1
  return v
}

describe('search-kg-signal', () => {
  let db
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
  })
  afterAll(async () => { await db.disconnect?.() })
  beforeEach(() => _resetForTest())

  // ---- Cache + single-flight

  it('caches successful signals — second call same phrase does NOT re-embed', async () => {
    const embedClient = { embed: vi.fn(async () => Float32Array.from(unit(0))) }
    const s1 = await computeKgSignal({ phrase: 'async abap', db, embedClient })
    expect(s1.slugScores.get('abap-async-rap')).toBeGreaterThan(0)
    expect(embedClient.embed).toHaveBeenCalledTimes(1)

    const s2 = await computeKgSignal({ phrase: 'async abap', db, embedClient })
    expect(embedClient.embed).toHaveBeenCalledTimes(1)  // still 1 — cache hit
    expect(s2).toBe(s1)  // identity: same cached object
  })

  it('normalizes key by trim + lowercase — "  Async ABAP  " hits same cache entry', async () => {
    const embedClient = { embed: vi.fn(async () => Float32Array.from(unit(0))) }
    await computeKgSignal({ phrase: 'async abap', db, embedClient })
    await computeKgSignal({ phrase: '  ASYNC abap  ', db, embedClient })
    expect(embedClient.embed).toHaveBeenCalledTimes(1)
  })

  it('single-flight — two concurrent identical calls share one embed', async () => {
    let embedCallCount = 0
    const slowEmbed = () => new Promise(resolve => {
      embedCallCount += 1
      setTimeout(() => resolve(Float32Array.from(unit(0))), 30)
    })
    const embedClient = { embed: slowEmbed }
    const [a, b] = await Promise.all([
      computeKgSignal({ phrase: 'async abap', db, embedClient }),
      computeKgSignal({ phrase: 'async abap', db, embedClient }),
    ])
    expect(embedCallCount).toBe(1)
    expect(a).toBe(b)
  })

  // ---- Empty / disabled

  it('returns empty signal when enabled=false without calling embed', async () => {
    const embedClient = { embed: vi.fn() }
    const s = await computeKgSignal({ phrase: 'anything', db, embedClient, enabled: false })
    expect(s.slugScores.size).toBe(0)
    expect(s.warning).toBe('disabled')
    expect(embedClient.embed).not.toHaveBeenCalled()
  })

  it('returns empty signal for empty / whitespace-only phrase', async () => {
    const embedClient = { embed: vi.fn() }
    const s = await computeKgSignal({ phrase: '   ', db, embedClient })
    expect(s.slugScores.size).toBe(0)
    expect(embedClient.embed).not.toHaveBeenCalled()
  })

  it('returns empty signal (warning=kg_empty) when KG has no ACTIVE concepts', async () => {
    // Use a separate in-memory DB with the schema deployed but no concepts.
    const empty = await cds.connect.to({ kind: 'sqlite', credentials: { url: ':memory:' } })
    await cds.deploy(cds.model || 'db/schema.cds').to(empty)
    const embedClient = { embed: async () => Float32Array.from(unit(0)) }
    const s = await computeKgSignal({ phrase: 'anything', db: empty, embedClient })
    expect(s.slugScores.size).toBe(0)
    expect(s.warning).toBe('kg_empty')
  })

  // ---- Error handling

  it('does NOT cache non-timeout embed failures', async () => {
    let calls = 0
    const flakyClient = { embed: async () => { calls += 1; throw new Error('boom') } }
    const s1 = await computeKgSignal({ phrase: 'flaky', db, embedClient: flakyClient })
    expect(s1.warning).toBe('embed_failed')
    // Second call should embed again (not cached)
    const s2 = await computeKgSignal({ phrase: 'flaky', db, embedClient: flakyClient })
    expect(calls).toBe(2)
    expect(s2.warning).toBe('embed_failed')
  })

  it('honours timeoutMs — aborting embed returns warning=timeout', async () => {
    const abortingClient = {
      embed: (_text, opts) => new Promise((_resolve, reject) => {
        opts?.signal?.addEventListener('abort', () => {
          const err = new Error('aborted')
          err.name = 'AbortError'
          reject(err)
        })
      }),
    }
    const s = await computeKgSignal({ phrase: 'slow', db, embedClient: abortingClient, timeoutMs: 30 })
    expect(s.warning).toBe('timeout')
    expect(s.slugScores.size).toBe(0)
  })

  // ---- Rationale + scoring shape

  it('rationale combines top-2 contributing concept names', async () => {
    const embedClient = { embed: async () => Float32Array.from(unit(0)) }
    const s = await computeKgSignal({ phrase: 'async abap', db, embedClient })
    const r = s.slugRationale.get('abap-async-rap')
    expect(r).toBeTruthy()
    expect(r).toMatch(/Teaches (Asynchronous ABAP|RAP)/)
  })

  // ---- SQL fragment builder

  it('buildKgRankFragment returns "" for empty signal — rank formula unchanged', () => {
    expect(buildKgRankFragment({ slugScores: new Map() })).toBe('')
    expect(buildKgRankFragment(null)).toBe('')
    expect(buildKgRankFragment(undefined)).toBe('')
  })

  it('buildKgRankFragment emits weighted CASE with valid slugs only', () => {
    const signal = {
      slugScores: new Map([
        ['abap-async-rap', 0.81],
        ['cap-outbox', 0.64],
      ]),
    }
    const frag = buildKgRankFragment(signal)
    expect(frag).toContain(`${KG_WEIGHT.toFixed(2)} *`)
    expect(frag).toContain("when 'abap-async-rap' then 0.8100")
    expect(frag).toContain("when 'cap-outbox' then 0.6400")
    expect(frag).toContain('else 0 end')
  })

  it('buildKgRankFragment filters malformed slugs (defense in depth)', () => {
    const signal = {
      slugScores: new Map([
        ['abap-async-rap', 0.81],
        ["evil'; drop table Tutorials--", 0.99],  // injection attempt
        ['UPPER-CASE', 0.5],                       // not lowercase-kebab
        ['has spaces', 0.5],                       // has spaces
        ['unicode-café', 0.5],                     // non-ASCII
      ]),
    }
    const frag = buildKgRankFragment(signal)
    expect(frag).toContain("when 'abap-async-rap' then")
    // Everything else must be rejected before hitting SQL.
    expect(frag).not.toMatch(/drop table/i)
    expect(frag).not.toContain("UPPER-CASE")
    expect(frag).not.toContain("has spaces")
    expect(frag).not.toContain("café")
  })

  it('buildKgRankFragment returns "" when all slugs are rejected', () => {
    const signal = {
      slugScores: new Map([
        ['UPPER', 0.5],
        ['has spaces', 0.5],
      ]),
    }
    expect(buildKgRankFragment(signal)).toBe('')
  })

  it('buildKgRankFragment skips zero / negative / non-finite scores', () => {
    const signal = {
      slugScores: new Map([
        ['abap-async-rap', 0.81],
        ['zero-slug', 0],
        ['neg-slug', -0.5],
        ['nan-slug', NaN],
      ]),
    }
    const frag = buildKgRankFragment(signal)
    expect(frag).toContain("when 'abap-async-rap' then")
    expect(frag).not.toContain('zero-slug')
    expect(frag).not.toContain('neg-slug')
    expect(frag).not.toContain('nan-slug')
    expect(frag).not.toContain('NaN')
  })

  // ---- peekSignal (cache read without compute)

  it('peekSignal returns cached entry or null — never computes', async () => {
    expect(peekSignal('nothing here')).toBe(null)
    const embedClient = { embed: async () => Float32Array.from(unit(0)) }
    await computeKgSignal({ phrase: 'async abap', db, embedClient })
    const peeked = peekSignal('async abap')
    expect(peeked).not.toBeNull()
    expect(peeked.slugScores.get('abap-async-rap')).toBeGreaterThan(0)
  })
})
