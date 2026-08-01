import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../styles.css'), 'utf8')

describe('arcade styles', () => {
  it('gates animation behind prefers-reduced-motion: reduce', () => {
    expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/)
    // the reduced-motion block must neutralize animation
    const block = css.slice(css.search(/@media\s*\(prefers-reduced-motion:\s*reduce\)/))
    expect(block).toMatch(/animation:\s*none/)
  })
  it('defines the ported keyframes', () => {
    for (const kf of ['bounce-7', 'beat', 'blinkGreen', 'fadeInAnimation']) {
      expect(css).toContain(`@keyframes ${kf}`)
    }
  })
  it('sets per-level avatar bounce iteration counts (avatar-4 infinite)', () => {
    expect(css).toMatch(/\.avatar-1\s*\{[^}]*animation[^}]*bounce-7[^}]*\b1\b/)
    expect(css).toMatch(/\.avatar-4\s*\{[^}]*bounce-7[^}]*infinite/)
  })
})
