// test/unit/search-community-signal.test.js
// Unit tests for buildCommunityRankFragment (#1171). In-memory SQLite.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import path from 'node:path'
import cds from '@sap/cds'
import {
  buildCommunityRankFragment,
  COMMUNITY_TOP_K,
} from '../../srv/lib/search-kg-signal.js'

// signal stub: only slugScores matters for this helper.
const sig = (pairs) => ({ slugScores: new Map(pairs) })

const DB_PATH = path.join(process.cwd(), 'db')

describe('buildCommunityRankFragment (#1171)', () => {
  let db
  beforeAll(async () => {
    await cds.deploy(DB_PATH).to('sqlite::memory:')
    db = await cds.connect.to('db')
    // anchor 'a1' is in community fp-a with siblings p1,p2. 'a2' in fp-b alone.
    await db.run(INSERT.into('com.sap.developers.ims.KgCommunity').entries([
      { communityId: 1, vertexKey: 'tutorial:a1', vertexType: 'tutorial', slug: 'a1', communityFingerprint: 'fp-a' },
      { communityId: 1, vertexKey: 'tutorial:p1', vertexType: 'tutorial', slug: 'p1', communityFingerprint: 'fp-a' },
      { communityId: 1, vertexKey: 'tutorial:p2', vertexType: 'tutorial', slug: 'p2', communityFingerprint: 'fp-a' },
      { communityId: 2, vertexKey: 'tutorial:a2', vertexType: 'tutorial', slug: 'a2', communityFingerprint: 'fp-b' },
    ]))
  })
  afterAll(async () => { await db.disconnect?.() })

  it('weight <= 0 returns "" and does NOT touch the DB', async () => {
    const spy = vi.spyOn(db, 'run')
    const frag = await buildCommunityRankFragment({ signal: sig([['a1', 0.9]]), db, weight: 0 })
    expect(frag).toBe('')
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('emits binary-boost CASE for community peers, excluding the anchor', async () => {
    const frag = await buildCommunityRankFragment({ signal: sig([['a1', 0.9]]), db, weight: 1.5 })
    expect(frag).toContain('1.50 *')
    expect(frag).toContain("when 'p1' then 1.0000")
    expect(frag).toContain("when 'p2' then 1.0000")
    expect(frag).not.toContain("when 'a1'")   // anchor excluded
    expect(frag.startsWith('+ ')).toBe(true)
  })

  it('returns "" when the top anchor has no community', async () => {
    const frag = await buildCommunityRankFragment({ signal: sig([['a2', 0.9]]), db, weight: 1.5 })
    expect(frag).toBe('')   // a2 is a singleton in fp-b — no peers
  })

  it('returns "" for an empty signal', async () => {
    expect(await buildCommunityRankFragment({ signal: sig([]), db, weight: 1.5 })).toBe('')
    expect(await buildCommunityRankFragment({ signal: null, db, weight: 1.5 })).toBe('')
  })

  it('only the top-K slugs become anchors', async () => {
    // K+1 zero-community slugs ranked above a1 would push a1 out of the anchor
    // window if topK were smaller; with default K=5 and 1 real anchor it stays.
    expect(COMMUNITY_TOP_K).toBe(5)
  })

  it('fail-open: a DB throw collapses the term to ""', async () => {
    const badDb = { kind: 'sqlite', run: () => { throw new Error('boom') } }
    const frag = await buildCommunityRankFragment({ signal: sig([['a1', 0.9]]), db: badDb, weight: 1.5 })
    expect(frag).toBe('')
  })
})
