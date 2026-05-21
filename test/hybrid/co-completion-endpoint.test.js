// test/hybrid/co-completion-endpoint.test.js
import { describe, it, expect } from 'vitest'
import cds from '@sap/cds'

cds.test('serve', '--project', '.', '--profile', 'hybrid')

describe('/build/co-completions endpoint (hybrid HANA)', () => {
  it('returns a slug-keyed object with score arrays', async () => {
    const { data } = await GET('/build/co-completions')
    expect(typeof data).toBe('object')
    // Production HANA has 2.5M task records → at least some pairs
    const entries = Object.entries(data)
    expect(entries.length).toBeGreaterThan(0)
    const [, peers] = entries[0]
    expect(Array.isArray(peers)).toBe(true)
    expect(peers[0]).toMatchObject({ slug: expect.any(String), score: expect.any(Number) })
  })
})
