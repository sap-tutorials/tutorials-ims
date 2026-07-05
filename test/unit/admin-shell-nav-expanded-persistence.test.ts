// Structural guard for the #829 side-nav expand/collapse persistence
// (originally fixed in #832, regressed silently because the fix keyed off
// an ABSOLUTE propertyChange path — but UI5 emits the RELATIVE binding
// path plus a `context` for the row). Verified live via Playwright against
// DEV: the two-way binding writes `path: "expanded"` with context path
// `/groups/N`, never `path: "/groups/N/expanded"`.
//
// admin-shell has no UI test harness in this repo, so pin the structural
// invariants in Component.js text so a future refactor can't silently
// re-break the persistence again.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const COMPONENT_JS = path.resolve(
  import.meta.dirname,
  '../../app/admin-shell/webapp/Component.js',
)

describe('admin-shell side-nav expand/collapse persistence (#829)', () => {
  const src = readFileSync(COMPONENT_JS, 'utf8')

  it('reads the group-expanded state from localStorage on init', () => {
    // Init path must key on the same string used in the write path so
    // saved state actually round-trips.
    expect(src).toMatch(/localStorage\.getItem\(\s*"sap-tutorials-admin-nav-group-"\s*\+\s*g\.key\s*\)/)
  })

  it('writes the group-expanded state to localStorage on user toggle', () => {
    expect(src).toMatch(/localStorage\.setItem\(\s*"sap-tutorials-admin-nav-group-"\s*\+\s*[a-zA-Z]+\.key\s*,/)
  })

  it('propertyChange listener matches on the RELATIVE binding path + a /groups context', () => {
    // The relative-path check is the crux of the fix — the previous
    // regex-on-absolute-path never matched because UI5 emits `expanded`
    // (relative) with a `context` of `/groups/N`.
    expect(src, 'must key on relative path "expanded"').toMatch(/sPath\s*!==\s*"expanded"/)
    expect(src, 'must extract context from the event').toMatch(/getParameter\(\s*"context"\s*\)/)
    // The context path guard — /groups/\d+ (no trailing /expanded).
    expect(src).toMatch(/\/\^\\\/groups\\\/\\d\+\$\//)
  })

  it('does NOT keep the broken absolute-path regex from #832', () => {
    // If this line ever comes back, the persistence silently breaks again.
    expect(src).not.toMatch(/\/groups\\\/\\d\+\\\/expanded\$/)
  })
})
