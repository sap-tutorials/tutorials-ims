// test/unit/hugo/joule-open-with-prefill.test.ts
//
// #946: window.joule.openWithPrefill is a sibling of openWithMessage that
// pre-fills the composer WITHOUT submitting. hugo/static/js/joule.js is a
// plain IIFE that reads the panel DOM at load time — driving it end-to-end
// inside a unit harness would mean rebuilding the whole panel scaffold in
// happy-dom. Instead pin the API surface with a regex over the source: this
// catches accidental deletion or rename in a follow-up refactor, and pairs
// with test/smoke/joule-step-fab.test.js which asserts the API is present in
// the deployed bundle.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const src = readFileSync(
  path.resolve(import.meta.dirname, '../../../hugo/static/js/joule.js'),
  'utf8',
)

describe('joule.js — openWithPrefill (#946)', () => {
  it('exposes openWithPrefill on window.joule', () => {
    expect(src).toMatch(/openWithPrefill\s*\(\s*arg\s*\)/)
  })

  it('accepts a string OR { text } argument (same shape as openWithMessage)', () => {
    // The extract-text pattern should be identical to openWithMessage so
    // consumers can migrate without shape surprises.
    const extract =
      /const\s+text\s*=\s*typeof\s+arg\s*===\s*['"]string['"]\s*\?\s*arg\s*:\s*\(arg\s*&&\s*typeof\s+arg\.text\s*===\s*['"]string['"]\s*\?\s*arg\.text\s*:\s*['"]{2}\)/g
    const matches = src.match(extract) || []
    // Both openWithMessage and openWithPrefill use this exact pattern.
    expect(matches.length).toBeGreaterThanOrEqual(2)
  })

  it('honours a focus: "send" | "input" hint (defaults to "input")', () => {
    // Default is 'input'; only 'send' opts into focusing the send button.
    expect(src).toMatch(/arg\.focus\s*===\s*['"]send['"]/)
    expect(src).toMatch(/prefillFocus:\s*focus/)
  })

  it('routes prefill through the same _pendingOpen queue as other openers', () => {
    // Ensures the pre-ready case (callers dispatching before config loads)
    // is handled the same way as open()/openWithMessage()/openWithStepContext().
    // Look for the specific queueing block for the prefill opts.
    expect(src).toMatch(
      /prefillText:\s*text[\s\S]{0,80}prefillFocus:\s*focus[\s\S]{0,120}_pendingOpen\s*=\s*opts/,
    )
  })

  it('sets input.value and moves the caret to end in _openImpl', () => {
    expect(src).toMatch(/opts\.prefillText/)
    // Caret-to-end via setSelectionRange, wrapped in try/catch (some input
    // types throw on setSelectionRange in some engines).
    expect(src).toMatch(/setSelectionRange\(len,\s*len\)/)
  })

  it('runs the prefill branch AFTER the hero/chat swap so the input is visible', () => {
    // Regression guard: focus() only works on visible elements. The prefill
    // block must live below the messages.length ? showChat() : showHero()
    // fork inside _openImpl.
    const openImplIdx = src.indexOf('async function _openImpl')
    expect(openImplIdx).toBeGreaterThan(-1)
    const impl = src.slice(openImplIdx, openImplIdx + 2000)
    const showHeroIdx = impl.indexOf('showHero()')
    const prefillIdx = impl.indexOf('opts.prefillText')
    expect(showHeroIdx).toBeGreaterThan(-1)
    expect(prefillIdx).toBeGreaterThan(showHeroIdx)
  })
})
