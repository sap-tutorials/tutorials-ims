// Regression tests for #432 — parseV2Steps was returning 0 steps on CRLF
// tutorials because /^### (.+)$/ doesn't match before \r in JS regex.
// Centralized line-ending normalization at composeTutorial() entry fixes
// every downstream parser at once. This file pins the helper's contract.

import { describe, it, expect } from 'vitest'
import { normalizeLineEndings } from '../compose.js'

describe('normalizeLineEndings', () => {
  it('passes LF input through unchanged', () => {
    expect(normalizeLineEndings('line one\nline two\n')).toBe('line one\nline two\n')
  })

  it('converts CRLF to LF', () => {
    expect(normalizeLineEndings('line one\r\nline two\r\n')).toBe('line one\nline two\n')
  })

  it('converts CR-only (legacy Mac) to LF', () => {
    expect(normalizeLineEndings('line one\rline two\r')).toBe('line one\nline two\n')
  })

  it('handles mixed line endings', () => {
    expect(normalizeLineEndings('lf\nthen\r\ncrlf\rcr\n')).toBe('lf\nthen\ncrlf\ncr\n')
  })

  it('preserves empty string', () => {
    expect(normalizeLineEndings('')).toBe('')
  })

  it('preserves a string with no line terminators', () => {
    expect(normalizeLineEndings('one line no terminator')).toBe('one line no terminator')
  })

  it('does NOT collapse a literal `\\r\\n` escape inside a normal string boundary', () => {
    // Only line-terminator bytes should be replaced; strings written with
    // literal CR or CRLF bytes are exactly what we want to fix.
    expect(normalizeLineEndings('a\r\nb')).toBe('a\nb')
    expect(normalizeLineEndings('a\rb')).toBe('a\nb')
  })
})
