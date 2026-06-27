import { describe, it, expect } from 'vitest'
import { yamlEscape } from '../../../scripts/fetch-concepts.ts'

// #446 Track 3-A — yamlEscape unit tests.
//
// Covers control chars (\n, \r, \t), backslash and double-quote escaping,
// null/undefined/empty handling, and UTF-8 passthrough. Admin-edited
// Concepts.description values can include any of these; an unescaped newline
// inside a YAML double-quoted scalar breaks the Hugo build.

describe('yamlEscape', () => {
  it('wraps a plain string in double quotes', () => {
    expect(yamlEscape('hello')).toBe('"hello"')
  })

  it('escapes embedded double quotes', () => {
    expect(yamlEscape('say "hi"')).toBe('"say \\"hi\\""')
  })

  it('escapes embedded backslashes', () => {
    expect(yamlEscape('path\\to\\file')).toBe('"path\\\\to\\\\file"')
  })

  it('escapes newlines, carriage returns, tabs', () => {
    expect(yamlEscape('line1\nline2')).toBe('"line1\\nline2"')
    expect(yamlEscape('a\r\nb')).toBe('"a\\r\\nb"')
    expect(yamlEscape('col1\tcol2')).toBe('"col1\\tcol2"')
  })

  it('returns empty quoted string for null/undefined/empty', () => {
    expect(yamlEscape('')).toBe('""')
    // @ts-expect-error — runtime tolerates null
    expect(yamlEscape(null)).toBe('""')
    // @ts-expect-error — runtime tolerates undefined
    expect(yamlEscape(undefined)).toBe('""')
  })

  it('passes non-ASCII UTF-8 through unchanged', () => {
    expect(yamlEscape('café — 日本')).toBe('"café — 日本"')
  })
})
