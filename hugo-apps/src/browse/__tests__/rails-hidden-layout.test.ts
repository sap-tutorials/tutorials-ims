// hugo-apps/src/browse/__tests__/rails-hidden-layout.test.ts
//
// Regression guard for issue #281: when the rails container has the
// [data-rails-hidden] attribute (set by controller.ts when any filter is
// active), the CSS in hugo/assets/css/browse.css MUST collapse its
// layout box, not just fade its opacity. The original implementation
// used `opacity: 0` only, which left a 1392px-tall invisible block above
// the card grid and made the page appear empty after any filter click.
//
// We verify by reading the CSS source file and asserting the
// [data-rails-hidden] rule sets `display: none` (the load-bearing
// declaration). A pure string match is sufficient because the failure
// mode is a missing declaration in a single, narrow rule — not anything
// that would benefit from a full layout engine. happy-dom does not
// compute layout, so a getComputedStyle-driven assertion would not
// distinguish the two cases.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const CSS_PATH = resolve(__dirname, '../../../../hugo/assets/css/browse.css')

function extractRule(css: string, selector: string): string | null {
  // Locate the selector and return its declaration block (between { and }).
  // Plain string scan rather than a CSS parser because the rule we care
  // about is exact-match and cannot legally span media queries (those are
  // separate rules).
  const idx = css.indexOf(selector)
  if (idx < 0) return null
  const open = css.indexOf('{', idx)
  const close = css.indexOf('}', open)
  if (open < 0 || close < 0) return null
  return css.slice(open + 1, close).trim()
}

describe('issue #281 — [data-rails-container][data-rails-hidden] collapses layout', () => {
  const css = readFileSync(CSS_PATH, 'utf8')

  it('the CSS file is non-empty and contains the rails-hidden selector', () => {
    expect(css.length).toBeGreaterThan(0)
    expect(css).toContain('[data-rails-container][data-rails-hidden]')
  })

  it('the rule sets display: none so the rails layout box collapses when hidden', () => {
    const block = extractRule(css, '[data-rails-container][data-rails-hidden]')
    expect(block).not.toBeNull()
    // The whole point of the regression guard: must remove from layout,
    // not merely fade. Either `display: none` or a `height: 0`+overflow
    // pair would technically work; we standardize on the former for
    // clarity.
    expect(block).toMatch(/\bdisplay\s*:\s*none\b/)
  })

  it('the rule does NOT rely on opacity:0 alone (the original bug)', () => {
    const block = extractRule(css, '[data-rails-container][data-rails-hidden]')
    expect(block).not.toBeNull()
    // opacity-only is the original bug. It is OK for the rule to also
    // set opacity (e.g. as part of a future fade-then-collapse pattern),
    // but a layout-removal declaration MUST also be present — and that
    // is asserted in the previous test. This test is the negative-form
    // partner: if someone removes display:none and ships only opacity,
    // the previous test fails. We keep this comment as the rationale.
    // (No additional assertion needed here beyond the matcher above.)
  })
})
