// Hybrid HTTP test for GET /build/concepts — public, unauthenticated.
//
// Run with: npm run test:hybrid -- test/hybrid/build-concepts.test.js
// Requires: `cf login` to a HANA-bound CF space first.

import { describe, it, beforeAll, expect } from 'vitest'
import cds from '@sap/cds'

// Boot the CAP server bound to hybrid HANA.
const project = cds.test('serve', '--project', '.', '--profile', 'hybrid')

describe('/build/concepts (HTTP)', () => {
  it('returns 200 with concepts + generatedAt', async () => {
    const res = await project.get('/build/concepts')
    expect(res.status).toBe(200)
    expect(res.data).toHaveProperty('concepts')
    expect(Array.isArray(res.data.concepts)).toBe(true)
    expect(res.data).toHaveProperty('generatedAt')
  })

  it('does not require auth', async () => {
    const res = await project.get('/build/concepts')
    expect(res.status).toBe(200)
  })

  it('every returned concept has the contract shape', async () => {
    const res = await project.get('/build/concepts')
    for (const c of res.data.concepts) {
      expect(c).toHaveProperty('slug')
      expect(c).toHaveProperty('name')
      expect(c).toHaveProperty('teaches')
      expect(c).toHaveProperty('requires')
      expect(c).toHaveProperty('requiredBy')
      expect(c).toHaveProperty('relatedTo')
      expect(Array.isArray(c.teaches)).toBe(true)
    }
  })
})
