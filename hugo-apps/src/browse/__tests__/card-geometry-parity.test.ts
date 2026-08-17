// hugo-apps/src/browse/__tests__/card-geometry-parity.test.ts
//
// Drift guard for issue #1854 — /browse/ residual CLS ≈ 0.187.
//
// Root cause: card.css (hugo-apps/src/shared/cards/card.css) is injected by
// JS (vite-plugin-css-injected-by-js) AFTER first paint. Its layout-affecting
// rules — padding:1.5rem, the desc -webkit-line-clamp:3, text metrics, margins,
// borders — therefore land late, so SSR'd cards reflow when the island mounts.
// #1842 only mirrored `min-height:200px`+flex into browse.css, which floored
// short cards (0.503→0.187) but left taller cards to shift. The durable fix
// (#1854) mirrors the FULL layout surface of card.css into the render-blocking
// browse.css "@card-geometry-guard" block so SSR and post-mount heights match.
//
// This test keeps the two in sync: for every mirrored selector, every
// NON-cosmetic declaration in card.css must appear — with the same value — in
// the browse.css guard region. Cosmetics (colour, background, shadow, radius,
// transition, etc.) are allow-listed and intentionally left to load via JS,
// because they don't affect layout. If card.css gains/changes a layout
// property and the guard isn't updated, this test fails — preventing a silent
// CLS regression that no unit test on the mount path could otherwise catch.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CARD_CSS = join(__dirname, '../../shared/cards/card.css')
const BROWSE_CSS = join(__dirname, '../../../../hugo/assets/css/browse.css')

// Selectors whose layout the browse.css guard mirrors from card.css.
const MIRRORED_SELECTORS = [
  '.nav-card',
  '.nav-card__type',
  '.nav-card__title',
  '.nav-card__desc',
  '.nav-card__meta',
  '.nav-card__meta-item',
  '.nav-card__tag',
  '.card-category-chip',
]

// Properties that DON'T affect layout box height/flow — safe to leave in
// card.css (JS-injected). Everything else on a mirrored selector must be
// duplicated into the render-blocking guard.
const COSMETIC_PROPS = new Set([
  'color',
  'background',
  'background-color',
  'box-shadow',
  'border-radius',
  'transition',
  'text-decoration',
  'letter-spacing',
  'text-transform',
  'cursor',
  'outline',
  '-webkit-tap-highlight-color',
])

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

/** Collapse internal whitespace so `1px  solid` === `1px solid`. */
function normVal(v: string): string {
  return v.replace(/\s+/g, ' ').trim()
}

/** Parse a flat (un-nested) CSS string into selector → (prop → value). */
function parseBlocks(css: string): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>()
  const clean = stripComments(css)
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g
  let m: RegExpExecArray | null
  while ((m = ruleRe.exec(clean)) !== null) {
    const selector = m[1].trim()
    const decls = new Map<string, string>()
    for (const chunk of m[2].split(';')) {
      const i = chunk.indexOf(':')
      if (i < 0) continue
      const prop = chunk.slice(0, i).trim()
      const val = chunk.slice(i + 1).trim()
      if (prop) decls.set(prop, normVal(val))
    }
    out.set(selector, decls)
  }
  return out
}

function extractGuardRegion(css: string): string {
  const start = css.indexOf('@card-geometry-guard:start')
  const end = css.indexOf('@card-geometry-guard:end')
  expect(start, 'guard start marker present in browse.css').toBeGreaterThan(-1)
  expect(end, 'guard end marker present in browse.css').toBeGreaterThan(start)
  // Slice from the end of the start-marker comment to the start of the
  // end-marker comment so the extracted region is pure CSS rules.
  const afterStart = css.indexOf('*/', start) + 2
  const beforeEnd = css.lastIndexOf('/*', end)
  return css.slice(afterStart, beforeEnd)
}

describe('#1854 — browse.css card-geometry guard mirrors card.css layout', () => {
  const cardCss = readFileSync(CARD_CSS, 'utf8')
  const browseCss = readFileSync(BROWSE_CSS, 'utf8')

  const cardBlocks = parseBlocks(cardCss)
  const guardBlocks = parseBlocks(extractGuardRegion(browseCss))

  it('the guard markers exist in browse.css', () => {
    expect(browseCss).toContain('@card-geometry-guard:start')
    expect(browseCss).toContain('@card-geometry-guard:end')
  })

  it('sanity: the load-bearing shifters live in the guard', () => {
    // These are the declarations #1842 missed and #1854 adds — if any regress,
    // the residual 0.187 CLS returns.
    const navCard = guardBlocks.get('.nav-card')
    expect(navCard?.get('padding')).toBe('1.5rem')
    expect(navCard?.get('min-height')).toBe('200px')
    const desc = guardBlocks.get('.nav-card__desc')
    expect(desc?.get('-webkit-line-clamp')).toBe('3')
  })

  for (const selector of MIRRORED_SELECTORS) {
    it(`guard mirrors every layout property of ${selector}`, () => {
      const card = cardBlocks.get(selector)
      expect(card, `${selector} exists in card.css`).toBeTruthy()
      const guard = guardBlocks.get(selector)
      expect(guard, `${selector} exists in browse.css guard`).toBeTruthy()

      for (const [prop, val] of card!.entries()) {
        if (COSMETIC_PROPS.has(prop)) continue
        expect(
          guard!.get(prop),
          `browse.css guard must mirror card.css \`${selector} { ${prop}: ${val} }\` ` +
            `(layout-affecting; add it to the @card-geometry-guard block or the ` +
            `SSR'd card will reflow when card.css injects → CLS)`
        ).toBe(val)
      }
    })
  }
})
