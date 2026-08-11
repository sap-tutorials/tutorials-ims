// test/unit/hugo/header-mobile-nav-overflow.test.ts
//
// Issue #1652: on mobile the shellbar collapses "Navigate"/"Share" into its
// overflow popover. A clicked overflow item's `targetRef` is the transient list
// item inside that popover (which closes on the same click), so anchoring our
// nav/share popover to it silently no-ops. The header script must instead detect
// the overflow case and anchor to the always-present overflow button, deferring
// the open one frame. Cheap regex pins so a future edit can't silently revert
// the fix — the real behavioral coverage lives in test/e2e/header-mobile-nav.test.js.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const header = readFileSync(
  path.resolve(import.meta.dirname, '../../../hugo/layouts/partials/header.html'),
  'utf8',
)

describe('header.html — mobile overflow nav (#1652)', () => {
  it('anchors overflow opens to the shellbar overflow button', () => {
    expect(
      header.includes('[data-ui5-stable="overflow"]'),
      'expected an overflow-button opener lookup',
    ).toBe(true)
  })

  it('detects the overflow state before choosing an opener', () => {
    // Either the ShellBarItem.inOverflow signal or the overflow list-item tag.
    expect(header).toMatch(/inOverflow|isOverflowed/)
  })

  it('defers the popover open one frame when opened from overflow', () => {
    expect(header.includes('requestAnimationFrame'), 'expected a deferred open').toBe(true)
  })

  it('both the Navigate and Share items use the overflow-aware opener', () => {
    // openAt(...) must be called with resolveOpener(...) — not the bare targetRef —
    // for both sb-nav and sb-share.
    const openCalls = header.match(/openAt\([^)]*resolveOpener\(/g) || []
    expect(openCalls.length, 'both nav and share should use resolveOpener').toBeGreaterThanOrEqual(2)
  })
})
