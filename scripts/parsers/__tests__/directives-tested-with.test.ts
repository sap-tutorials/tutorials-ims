// scripts/parsers/__tests__/directives-tested-with.test.ts
//
// Tests for KNOWN_VERSIONS and checkTestedWithFreshness from
// scripts/parsers/directives/tested-with.ts

import { describe, it, expect } from 'vitest'
import { checkTestedWithFreshness, KNOWN_VERSIONS } from '../directives/tested-with.js'

describe('KNOWN_VERSIONS', () => {
  it('contains @sap/cds with major 10', () => {
    expect(KNOWN_VERSIONS['@sap/cds']).toBe(10)
  })
  it('contains node with major 22', () => {
    expect(KNOWN_VERSIONS['node']).toBe(22)
  })
})

describe('checkTestedWithFreshness', () => {
  it('returns finding when @sap/cds major is below known current', () => {
    const findings = checkTestedWithFreshness({ '@sap/cds': '7.x' })
    expect(findings).toHaveLength(1)
    expect(findings[0].pkg).toBe('@sap/cds')
    expect(findings[0].declared).toBe(7)
    expect(findings[0].current).toBe(10)
  })

  it('returns no finding for current major', () => {
    expect(checkTestedWithFreshness({ '@sap/cds': '10.x' })).toHaveLength(0)
  })

  it('returns no finding for a future major (above known)', () => {
    expect(checkTestedWithFreshness({ '@sap/cds': '12.x' })).toHaveLength(0)
  })

  it('returns no finding for unknown package', () => {
    expect(checkTestedWithFreshness({ 'my-custom-lib': '3.x' })).toHaveLength(0)
  })

  it('skips non-numeric versions like "latest"', () => {
    expect(checkTestedWithFreshness({ '@sap/cds': 'latest' })).toHaveLength(0)
  })

  it('skips non-numeric versions like "next"', () => {
    expect(checkTestedWithFreshness({ 'node': 'next' })).toHaveLength(0)
  })

  it('returns multiple findings when multiple packages are outdated', () => {
    const findings = checkTestedWithFreshness({ '@sap/cds': '7.x', 'node': '18' })
    expect(findings).toHaveLength(2)
    const pkgs = findings.map(f => f.pkg)
    expect(pkgs).toContain('@sap/cds')
    expect(pkgs).toContain('node')
    const cdsFinding = findings.find(f => f.pkg === '@sap/cds')!
    expect(cdsFinding.declared).toBe(7)
    expect(cdsFinding.current).toBe(10)
    const nodeFinding = findings.find(f => f.pkg === 'node')!
    expect(nodeFinding.declared).toBe(18)
    expect(nodeFinding.current).toBe(22)
  })

  it('handles empty testedWith map', () => {
    expect(checkTestedWithFreshness({})).toHaveLength(0)
  })

  it('parses bare integer version strings', () => {
    const findings = checkTestedWithFreshness({ 'node': '18' })
    expect(findings).toHaveLength(1)
    expect(findings[0].declared).toBe(18)
    expect(findings[0].current).toBe(22)
  })

  it('parses version with patch (e.g. "9.8.2")', () => {
    const findings = checkTestedWithFreshness({ '@sap/cds': '9.8.2' })
    expect(findings).toHaveLength(1)
    expect(findings[0].declared).toBe(9)
  })
})
