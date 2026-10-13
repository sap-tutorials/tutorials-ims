// Tests for normalizeListFenceColumnZero.
//
// Covers the column-0-body-line problem documented in issue #2720: a fenced
// code block inside a numbered list item is indented 1–3 spaces and its body
// contains lines at a column shallower than the list-item continuation column
// (typically column 0, e.g. Swift `#if` / `#else` / `#endif` preprocessor
// directives). Under CommonMark/Goldmark a line at column 0 breaks out of the
// list item, so the fenced block never closes cleanly — a <pre><code> runs to
// the end of the content and swallows everything after it (in the tutorial
// pipeline, that included the template-injected "Done" button).
//
// The fix re-indents the whole block (open fence, body, close fence) up to a
// 4-space minimum, preserving relative indentation, so the block stays inside
// the list item.

import { describe, it, expect } from 'vitest'
import { normalizeListFenceColumnZero } from '../list-fence-column-zero.js'

describe('normalizeListFenceColumnZero', () => {
  // ── core #2720 case ──────────────────────────────────────────────────────

  it('shifts a 3-space list-item fence with a column-0 body line to a 4-space min', () => {
    const input = [
      '6. Open the file:',
      '',
      '   ```Swift',
      '   #if targetEnvironment(macCatalyst)',
      '   #else',
      '   ```',
    ].join('\n')
    const expected = [
      '6. Open the file:',
      '',
      '    ```Swift',
      '    #if targetEnvironment(macCatalyst)',
      '    #else',
      '    ```',
    ].join('\n')
    expect(normalizeListFenceColumnZero(input)).toBe(expected)
  })

  it('preserves relative indentation across a mixed-indent body', () => {
    // Body minimum is column 0 (the `#if`/`#else`/`#endif` lines); the deeper
    // code keeps its extra indentation relative to those. Shift = 4 - 0 = 4.
    const input = [
      '6. Change the code:',
      '',
      '   ```Swift[12-25]',
      '   func show() {',
      '       let a = 1',
      '#if targetEnvironment(macCatalyst)',
      '       let b = 2',
      '#else',
      '       let b = 3',
      '#endif',
      '   }',
      '   ```',
    ].join('\n')
    const expected = [
      '6. Change the code:',
      '',
      '    ```Swift[12-25]',
      '       func show() {',
      '           let a = 1',
      '    #if targetEnvironment(macCatalyst)',
      '           let b = 2',
      '    #else',
      '           let b = 3',
      '    #endif',
      '       }',
      '    ```',
    ].join('\n')
    expect(normalizeListFenceColumnZero(input)).toBe(expected)
  })

  // ── no-ops ────────────────────────────────────────────────────────────────

  it('leaves a well-formed fence (body already >= 4 spaces) unchanged', () => {
    const input = [
      '6. Open the file:',
      '',
      '   ```Swift',
      '    let x = 1',
      '    let y = 2',
      '   ```',
    ].join('\n')
    expect(normalizeListFenceColumnZero(input)).toBe(input)
  })

  it('leaves a top-level (0-space) fence unchanged even with a column-0 body', () => {
    const input = [
      '```Swift',
      '#if targetEnvironment(macCatalyst)',
      '#endif',
      '```',
    ].join('\n')
    expect(normalizeListFenceColumnZero(input)).toBe(input)
  })

  // [#2720 regression / #1931 interaction] A 3-space fence that is NOT inside a
  // list item — e.g. produced by #1931's 4→3 de-indent of a fence under a
  // heading — must be left untouched. Earlier this pass fired on any 1–3-space
  // fence whose body min was < 4, which re-indented #1931's output back to 4 and
  // broke the chained scan golden-render gate. The fence here follows plain
  // prose under a heading (no `N.`/`-` marker), so there is no list continuation
  // column to satisfy and nothing to heal.
  it('leaves a non-list (heading-context) 3-space fence unchanged', () => {
    const input = [
      '## Step 1',
      'Enter the code:',
      '',
      '   ```ABAP',
      '   START-OF-SELECTION.',
      '   ```',
      '',
    ].join('\n')
    expect(normalizeListFenceColumnZero(input)).toBe(input)
  })

  it('leaves an unterminated fence verbatim', () => {
    const input = [
      '6. Open the file:',
      '',
      '   ```Swift',
      '   #if targetEnvironment(macCatalyst)',
      // no closing fence
    ].join('\n')
    expect(normalizeListFenceColumnZero(input)).toBe(input)
  })

  // ── invariants ──────────────────────────────────────────────────────────

  it('is idempotent', () => {
    const input = [
      '6. Open the file:',
      '',
      '   ```Swift',
      '   #if targetEnvironment(macCatalyst)',
      '   #endif',
      '   ```',
    ].join('\n')
    const once = normalizeListFenceColumnZero(input)
    expect(normalizeListFenceColumnZero(once)).toBe(once)
  })

  it('preserves the line count', () => {
    const input = [
      '6. Change the code:',
      '',
      '   ```Swift',
      '   func show() {',
      '#if targetEnvironment(macCatalyst)',
      '   }',
      '   ```',
      '',
      '7. Next step.',
    ].join('\n')
    const out = normalizeListFenceColumnZero(input)
    expect(out.split('\n').length).toBe(input.split('\n').length)
  })

  it('leaves blank body lines blank (no trailing whitespace introduced)', () => {
    const input = [
      '6. Open the file:',
      '',
      '   ```Swift',
      '   #if targetEnvironment(macCatalyst)',
      '',
      '   #endif',
      '   ```',
    ].join('\n')
    const out = normalizeListFenceColumnZero(input).split('\n')
    // the blank line between the directives stays empty, not "    "
    expect(out[4]).toBe('')
  })
})
