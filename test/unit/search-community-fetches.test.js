// test/unit/search-community-fetches.test.js
// Unit tests for the KgCommunity fetch helpers (#1171). In-memory SQLite.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import path from 'node:path'
import cds from '@sap/cds'
import { fetchCommunityFingerprints, fetchCommunityMembers } from '../../srv/lib/kg/_search-fetches.js'

describe('search-fetches — KgCommunity helpers (#1171)', () => {
  let db
  beforeAll(async () => {
    // Deploy the full db/ directory so KgCommunity (in knowledge-graph-communities.cds,
    // not included from schema.cds) is available. Pattern from joule-tool-community-peers.test.js.
    await cds.deploy(path.join(process.cwd(), 'db')).to('sqlite::memory:')
    db = await cds.connect.to('db')
    // Two communities: fp-a has tutorials t1,t2,t3; fp-b has t4. Plus a
    // concept vertex in fp-a that must be filtered out (vertexType != tutorial).
    await db.run(INSERT.into('com.sap.developers.ims.KgCommunity').entries([
      { communityId: 1, vertexKey: 'tutorial:t1', vertexType: 'tutorial', slug: 't1', communityFingerprint: 'fp-a' },
      { communityId: 1, vertexKey: 'tutorial:t2', vertexType: 'tutorial', slug: 't2', communityFingerprint: 'fp-a' },
      { communityId: 1, vertexKey: 'tutorial:t3', vertexType: 'tutorial', slug: 't3', communityFingerprint: 'fp-a' },
      { communityId: 1, vertexKey: 'concept:c1',  vertexType: 'concept',  slug: 'c1', communityFingerprint: 'fp-a' },
      { communityId: 2, vertexKey: 'tutorial:t4', vertexType: 'tutorial', slug: 't4', communityFingerprint: 'fp-b' },
    ]))
  })
  afterAll(async () => { await db.disconnect?.() })

  it('fetchCommunityFingerprints returns tutorial-vertex fingerprints for anchor slugs', async () => {
    const rows = await fetchCommunityFingerprints(db, ['t1', 't4'])
    const byslug = Object.fromEntries(rows.map(r => [r.slug, r.communityFingerprint]))
    expect(byslug).toEqual({ t1: 'fp-a', t4: 'fp-b' })
  })

  it('fetchCommunityFingerprints ignores non-tutorial vertices', async () => {
    const rows = await fetchCommunityFingerprints(db, ['c1'])
    expect(rows).toEqual([])
  })

  it('fetchCommunityMembers returns tutorial members of the given fingerprints', async () => {
    const rows = await fetchCommunityMembers(db, ['fp-a'], 200)
    const slugs = rows.map(r => r.slug).sort()
    expect(slugs).toEqual(['t1', 't2', 't3'])
  })

  it('fetchCommunityMembers caps the total row count', async () => {
    const rows = await fetchCommunityMembers(db, ['fp-a'], 2)
    expect(rows.length).toBe(2)
  })

  it('empty inputs return [] without a DB call', async () => {
    expect(await fetchCommunityFingerprints(db, [])).toEqual([])
    expect(await fetchCommunityMembers(db, [], 200)).toEqual([])
  })
})
