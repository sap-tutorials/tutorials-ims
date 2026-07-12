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

  it('teaches items carry experienceTag + stepCount when present; concept edges carry description', async () => {
    const res = await project.get('/build/concepts')
    // Find a concept with at least one teaches entry and at least one requires/relatedTo edge.
    const withTeaches = res.data.concepts.find(c => c.teaches.length > 0)
    if (withTeaches) {
      const t = withTeaches.teaches[0]
      expect(t).toHaveProperty('slug')
      expect(t).toHaveProperty('title')
      // experienceTag/stepCount are optional per-row; assert the keys are
      // allowed shapes when present (string / number), never objects.
      if ('experienceTag' in t) expect(typeof t.experienceTag).toBe('string')
      if ('stepCount' in t) expect(typeof t.stepCount).toBe('number')
    }
    const withEdge = res.data.concepts.find(
      c => c.requires.length > 0 || c.relatedTo.length > 0 || c.requiredBy.length > 0,
    )
    if (withEdge) {
      const edge = [...withEdge.requires, ...withEdge.relatedTo, ...withEdge.requiredBy][0]
      expect(edge).toHaveProperty('slug')
      expect(edge).toHaveProperty('name')
      if ('description' in edge) expect(typeof edge.description).toBe('string')
    }
  })
})
