// Tests for normalizeListContinuationFences.
//
// Covers the 4-space-indented fence problem documented in issue #1931:
// ABAP tutorials (and others) indent fenced code blocks with 4 spaces inside
// numbered list items. CommonMark/Goldmark treats 4-space-indented lines as
// indented code blocks (literal text), so the render-codeblock hook is never
// invoked and the raw ``` delimiters appear in the output.

import { describe, it, expect } from 'vitest'
import { normalizeListContinuationFences } from '../list-continuation-fence.js'

describe('normalizeListContinuationFences', () => {
  // ── core case ────────────────────────────────────────────────────────────

  it('strips 1 space from a 4-space-indented ABAP fence and its content', () => {
    // The exact pattern from abap-environment-rap100-enhance-data-model step 1.
    const input = [
      '  2. Replace your code:',
      '',
      '    ```ABAP',
      '    @Search.searchable: true',
      '    ```',
    ].join('\n')
    const expected = [
      '  2. Replace your code:',
      '',
      '   ```ABAP',
      '   @Search.searchable: true',
      '   ```',
    ].join('\n')
    expect(normalizeListContinuationFences(input)).toBe(expected)
  })

  it('handles multi-line code content', () => {
    const input = [
      '  2. Insert the associations:',
      '',
      '    ```ABAP',
      '    association [0..1] to /DMO/I_Agency as _Agency',
      '    association [0..1] to /DMO/I_Customer as _Customer',
      '    ```',
    ].join('\n')
    const expected = [
      '  2. Insert the associations:',
      '',
      '   ```ABAP',
      '   association [0..1] to /DMO/I_Agency as _Agency',
      '   association [0..1] to /DMO/I_Customer as _Customer',
      '   ```',
    ].join('\n')
    expect(normalizeListContinuationFences(input)).toBe(expected)
  })

  // ── leave well-formed fences unchanged ───────────────────────────────────

  it('leaves a 0-space-indented fence unchanged', () => {
    const input = [
      '```ABAP',
      'some code',
      '```',
    ].join('\n')
    expect(normalizeListContinuationFences(input)).toBe(input)
  })

  it('leaves a 1-space-indented fence unchanged', () => {
    const input = [
      ' ```ABAP',
      ' code',
      ' ```',
    ].join('\n')
    expect(normalizeListContinuationFences(input)).toBe(input)
  })

  it('leaves a 2-space-indented fence unchanged', () => {
    const input = [
      '  ```ABAP',
      '  code',
      '  ```',
    ].join('\n')
    expect(normalizeListContinuationFences(input)).toBe(input)
  })

  it('leaves a 3-space-indented fence unchanged', () => {
    const input = [
      '   ```ABAP',
      '   code',
      '   ```',
    ].join('\n')
    expect(normalizeListContinuationFences(input)).toBe(input)
  })

  // ── unterminated fence left verbatim ─────────────────────────────────────

  it('leaves an unterminated 4-space fence verbatim', () => {
    const input = [
      '    ```ABAP',
      '    some code here',
      '',
      'Unrelated paragraph.',
    ].join('\n')
    expect(normalizeListContinuationFences(input)).toBe(input)
  })

  // ── multiple blocks in one document ──────────────────────────────────────

  it('normalizes multiple 4-space fence blocks in one document', () => {
    const input = [
      '  1. First step:',
      '',
      '    ```ABAP',
      '    code one',
      '    ```',
      '',
      '  2. Second step:',
      '',
      '    ```ABAP',
      '    code two',
      '    ```',
    ].join('\n')
    const expected = [
      '  1. First step:',
      '',
      '   ```ABAP',
      '   code one',
      '   ```',
      '',
      '  2. Second step:',
      '',
      '   ```ABAP',
      '   code two',
      '   ```',
    ].join('\n')
    expect(normalizeListContinuationFences(input)).toBe(expected)
  })

  // ── blank lines inside code block preserved ───────────────────────────────

  it('preserves blank lines inside the code block', () => {
    const input = [
      '    ```ABAP',
      '    line one',
      '',
      '    line two',
      '    ```',
    ].join('\n')
    const expected = [
      '   ```ABAP',
      '   line one',
      '',
      '   line two',
      '   ```',
    ].join('\n')
    expect(normalizeListContinuationFences(input)).toBe(expected)
  })

  // ── idempotent ────────────────────────────────────────────────────────────

  it('is idempotent: running twice produces the same result', () => {
    const input = [
      '    ```ABAP',
      '    code',
      '    ```',
    ].join('\n')
    const once = normalizeListContinuationFences(input)
    const twice = normalizeListContinuationFences(once)
    expect(twice).toBe(once)
  })

  // ── tilde fences ─────────────────────────────────────────────────────────

  it('normalizes 4-space tilde fences too', () => {
    const input = [
      '    ~~~ABAP',
      '    code',
      '    ~~~',
    ].join('\n')
    const expected = [
      '   ~~~ABAP',
      '   code',
      '   ~~~',
    ].join('\n')
    expect(normalizeListContinuationFences(input)).toBe(expected)
  })

  // ── mixed context: other elements around the fence ────────────────────────

  it('does not alter surrounding prose or list items', () => {
    const input = [
      '## Step title',
      '',
      '  1. Do this:',
      '',
      '    ```Shell',
      '    echo hello',
      '    ```',
      '',
      '  2. Then do that.',
      '',
      '> **Note:** Some blockquote text.',
    ].join('\n')
    const expected = [
      '## Step title',
      '',
      '  1. Do this:',
      '',
      '   ```Shell',
      '   echo hello',
      '   ```',
      '',
      '  2. Then do that.',
      '',
      '> **Note:** Some blockquote text.',
    ].join('\n')
    expect(normalizeListContinuationFences(input)).toBe(expected)
  })

  // ── longer fence run (4 backticks) ────────────────────────────────────────

  it('matches longer fence runs (4+ backticks)', () => {
    const input = [
      '    ````ABAP',
      '    ```nested```',
      '    ````',
    ].join('\n')
    const expected = [
      '   ````ABAP',
      '   ```nested```',
      '   ````',
    ].join('\n')
    expect(normalizeListContinuationFences(input)).toBe(expected)
  })
})
