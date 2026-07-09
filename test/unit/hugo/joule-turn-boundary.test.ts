// test/unit/hugo/joule-turn-boundary.test.ts
//
// The Joule chat client accumulates streamed `delta` frames into a single
// `assistantText` string per user turn. When the LLM decides to call a
// tool mid-answer, its prose ends without a trailing separator and the
// FOLLOWING turn's deltas begin with a new sentence — so a naive
// `assistantText += delta` produces "…catalog details.Now let me fetch…"
// which markdown-it renders as one run-on paragraph.
//
// Fix: any tool-related SSE frame (`tool`, `tutorial-cards`,
// `doc-citations`, `step-citations`, `analytics-result`) sets a
// `needsTurnBreak` flag; the next `delta` consumes the flag and prepends
// `\n\n` iff neither side already carries a paragraph break.
//
// hugo/static/js/joule.js is a plain IIFE that reads the panel DOM at load
// time — driving the full stream loop inside a unit harness would mean
// rebuilding the panel scaffold in happy-dom. Instead we pin the shape by
// regex over the source (same approach as joule-open-with-prefill.test.ts,
// which pairs with the smoke tests that assert deployed behaviour).

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const src = readFileSync(
  path.resolve(import.meta.dirname, '../../../hugo/static/js/joule.js'),
  'utf8',
)

describe('joule.js — turn-boundary paragraph breaks', () => {
  it('declares a needsTurnBreak flag in the send() closure', () => {
    expect(src).toMatch(/let\s+needsTurnBreak\s*=\s*false/)
  })

  it('sets needsTurnBreak=true on every tool-response frame', () => {
    // These are the five SSE payload types the server emits when the LLM
    // called a tool. All of them must arm the break so the next delta
    // (which starts a fresh assistant turn) is separated from the previous
    // one. If a new frame type is added and its `needsTurnBreak = true`
    // line is missed, this count drops.
    const armings = src.match(/needsTurnBreak\s*=\s*true/g) || []
    expect(armings.length).toBeGreaterThanOrEqual(5)
  })

  it('consumes the flag inside the delta branch and inserts \\n\\n', () => {
    const deltaIdx = src.indexOf("payload.type === 'delta'")
    expect(deltaIdx).toBeGreaterThan(-1)
    const branch = src.slice(deltaIdx, deltaIdx + 800)
    // The flag is read, a paragraph break is appended, then the flag is
    // reset so subsequent same-turn deltas don't stack extra breaks.
    expect(branch).toMatch(/needsTurnBreak/)
    expect(branch).toMatch(/assistantText\s*\+=\s*['"]\\n\\n['"]/)
    expect(branch).toMatch(/needsTurnBreak\s*=\s*false/)
  })

  it('guards against stacking extra breaks when either side already has one', () => {
    // Belt-and-suspenders: don't produce `\n\n\n\n` if the model already
    // ended the turn cleanly, and don't drop the delta's own leading
    // newline pattern. Both regex literals must be present in source.
    expect(src.includes('/\\n\\s*\\n\\s*$/')).toBe(true)
    expect(src.includes('/^\\s*\\n/')).toBe(true)
  })
})
