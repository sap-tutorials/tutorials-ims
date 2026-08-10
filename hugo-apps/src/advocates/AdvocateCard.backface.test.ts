import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const css = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'styles/advocates.css'),
  'utf8',
)

// Regression guard for #1607: on iOS Safari (WebKit) the front-face photo
// showed through — mirrored — over the back-face text after a card flip,
// because only the unprefixed `backface-visibility` was declared. WebKit
// needs the `-webkit-` prefix, so both must ship together.
describe('advocate flip-card backface (iOS Safari, #1607)', () => {
  it('declares -webkit-backface-visibility alongside the unprefixed property', () => {
    expect(css).toMatch(/-webkit-backface-visibility:\s*hidden/)
    expect(css).toMatch(/[^-]backface-visibility:\s*hidden/)
  })

  it('declares -webkit-transform-style alongside the unprefixed property', () => {
    expect(css).toMatch(/-webkit-transform-style:\s*preserve-3d/)
    expect(css).toMatch(/[^-]transform-style:\s*preserve-3d/)
  })

  it('gives the front face an explicit rotateY(0) 3D layer for WebKit culling', () => {
    expect(css).toMatch(/\.adv-front\s*\{[^}]*transform:\s*rotateY\(0deg\)/)
  })
})
