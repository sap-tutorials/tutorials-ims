// Tests for dedentListContinuationProse — the #1931 follow-up that rescues
// list-continuation prose and images left rendering as literal text inside an
// indented code block after `normalizeListContinuationFences` de-indents the
// fences. See list-continuation-prose.ts for the full rationale.

import { describe, it, expect } from 'vitest'
import { dedentListContinuationProse } from '../list-continuation-prose.js'

describe('dedentListContinuationProse', () => {
  // ── core case: prose + image after a de-indented fence ───────────────────
  // Mirrors abap-environment-rap100-enhance-data-model after the fence
  // normalizer has run (fence already at 3 spaces). The de-indented fence
  // terminates the `  2. ` item, so the trailing prose (4 sp) and image (6 sp)
  // are a document-level indented code block. De-indent so the deepest line
  // (the 6-space image) lands at 3 spaces.
  it('de-indents prose and image orphaned after a de-indented fence', () => {
    const input = [
      '  2. Replace your code:',
      '',
      '   ```ABAP',
      '   association [0..1] to /DMO/I_Agency as _Agency',
      '   ```',
      '',
      '    Your source code should look like this:',
      '',
      '      ![association](association.png)',
    ].join('\n')
    const expected = [
      '  2. Replace your code:',
      '',
      '   ```ABAP',
      '   association [0..1] to /DMO/I_Agency as _Agency',
      '   ```',
      '',
      ' Your source code should look like this:',
      '',
      '   ![association](association.png)',
    ].join('\n')
    expect(dedentListContinuationProse(input)).toBe(expected)
  })

  // ── content sitting exactly at the content column is still orphaned ───────
  // The image here is at 5 spaces = the `  2. ` content column, but the
  // de-indented fence above (3 sp) already closed the item, so it is
  // document-level too (the association2.png regression that survived the
  // first narrowing pass).
  it('de-indents content at the content column when a fence orphaned it', () => {
    const input = [
      '  2. Expose the associations:',
      '',
      '   ```ABAP',
      '   _Customer,',
      '   ```',
      '',
      '     ![association](association2.png)',
    ].join('\n')
    const expected = [
      '  2. Expose the associations:',
      '',
      '   ```ABAP',
      '   _Customer,',
      '   ```',
      '',
      '   ![association](association2.png)',
    ].join('\n')
    expect(dedentListContinuationProse(input)).toBe(expected)
  })

  // ── image directly under a marker, no intervening fence ──────────────────
  it('de-indents an image directly under a `  N. ` marker', () => {
    const input = [
      '  2. Look at this:',
      '',
      '    ![shot](pic.png)',
    ].join('\n')
    const expected = [
      '  2. Look at this:',
      '',
      '   ![shot](pic.png)',
    ].join('\n')
    expect(dedentListContinuationProse(input)).toBe(expected)
  })

  // ── standalone indented code block is preserved ──────────────────────────
  // No governing list marker → this is a genuine indented code block, not
  // orphaned list continuation. Must be left byte-for-byte.
  it('leaves a standalone indented code block unchanged', () => {
    const input = [
      'Here is an indented code block:',
      '',
      '    const x = 1',
      '    const y = 2',
    ].join('\n')
    expect(dedentListContinuationProse(input)).toBe(input)
  })

  // ── validly nested list content is preserved ─────────────────────────────
  // 4-space content under a `1. ` item (content column 3) is at/above the
  // column and no fence orphaned it → valid list content, leave it.
  it('leaves validly nested list content unchanged', () => {
    const input = [
      '1. Parent item',
      '',
      '    - child alpha',
      '    - child beta',
    ].join('\n')
    expect(dedentListContinuationProse(input)).toBe(input)
  })

  // ── lazy paragraph continuation is preserved ─────────────────────────────
  // An indented line that continues a paragraph (no blank line above) is not
  // an indented code block; leave it.
  it('leaves a lazy paragraph continuation unchanged', () => {
    const input = [
      'This is a paragraph line',
      '    that continues lazily with four spaces.',
    ].join('\n')
    expect(dedentListContinuationProse(input)).toBe(input)
  })

  // ── fence content is never touched ───────────────────────────────────────
  it('does not touch 4-space-indented lines inside a fenced code block', () => {
    const input = [
      '```text',
      '    indented line inside a fence',
      '```',
    ].join('\n')
    expect(dedentListContinuationProse(input)).toBe(input)
  })

  // ── multiple orphaned runs in one document ───────────────────────────────
  it('de-indents multiple orphaned runs', () => {
    const input = [
      '  1. First:',
      '',
      '    ![a](a.png)',
      '',
      '  2. Second:',
      '',
      '    ![b](b.png)',
    ].join('\n')
    const expected = [
      '  1. First:',
      '',
      '   ![a](a.png)',
      '',
      '  2. Second:',
      '',
      '   ![b](b.png)',
    ].join('\n')
    expect(dedentListContinuationProse(input)).toBe(expected)
  })

  // ── idempotent ───────────────────────────────────────────────────────────
  it('is idempotent', () => {
    const input = [
      '  2. Look at this:',
      '',
      '      ![shot](pic.png)',
    ].join('\n')
    const once = dedentListContinuationProse(input)
    const twice = dedentListContinuationProse(once)
    expect(twice).toBe(once)
  })

  // ── no-op on clean input ─────────────────────────────────────────────────
  it('is a no-op on prose with no indented runs', () => {
    const input = [
      '## Title',
      '',
      'A normal paragraph.',
      '',
      '- a bullet',
      '- another bullet',
    ].join('\n')
    expect(dedentListContinuationProse(input)).toBe(input)
  })
})
