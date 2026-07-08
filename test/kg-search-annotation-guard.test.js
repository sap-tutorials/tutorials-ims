// test/kg-search-annotation-guard.test.js
// #1046 — if this annotation is deleted or loses aliasSearchBlob, the palette's
// CONCEPTS group silently collapses to name-only match. Fail CI, not users.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

describe('#1046 PublishedConceptsWithAliases @cds.search annotation guard', () => {
  const src = readFileSync(resolve(__dirname, '..', 'srv', 'knowledge-graph-service.cds'), 'utf8')

  it('PublishedConceptsWithAliases is defined', () => {
    expect(src).toMatch(/entity\s+PublishedConceptsWithAliases\b/)
  })

  it('carries @cds.search covering aliasSearchBlob', () => {
    // Match the annotation immediately above the entity, tolerant of whitespace.
    const idx = src.indexOf('PublishedConceptsWithAliases')
    expect(idx).toBeGreaterThan(-1)
    const preamble = src.slice(Math.max(0, idx - 400), idx)
    expect(preamble).toMatch(/@cds\.search/)
    expect(preamble).toMatch(/aliasSearchBlob/)
  })
})
