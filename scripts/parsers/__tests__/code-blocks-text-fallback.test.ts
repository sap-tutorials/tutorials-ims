import { describe, it, expect } from 'vitest'
import { renderDirectivesAsText } from '../directives.js'
// The walkthrough directive is registered via side-effect import in directives.ts

describe('renderDirectivesAsText — walkthrough', () => {
  it('walkthrough: replaces :::walkthrough with code + (lines N) notes', () => {
    const md = [
      ':::walkthrough',
      '```js',
      'const x = 1',
      '```',
      '',
      '1. {1} Declares x',
      ':::',
    ].join('\n')

    const text = renderDirectivesAsText(md)

    // Code fence preserved verbatim
    expect(text).toContain('const x = 1')
    // Note transformed: {1} → (lines 1)
    expect(text).toContain('(lines 1)')
    // Declares x text preserved
    expect(text).toContain('Declares x')
    // The :::walkthrough container markers are gone
    expect(text).not.toContain(':::walkthrough')
    expect(text).not.toContain(':::')
  })

  it('walkthrough: range uses en-dash in (lines N–M) format', () => {
    const md = [
      ':::walkthrough',
      '```ts',
      'const a = 1',
      'const b = 2',
      '```',
      '',
      '1. {1-2} Two lines',
      ':::',
    ].join('\n')

    const text = renderDirectivesAsText(md)
    // Must use en-dash (U+2013) not hyphen (U+002D)
    expect(text).toContain('(lines 1–2)')
  })

  it('walkthrough: code fence preserved without modification', () => {
    const md = [
      ':::walkthrough',
      '```bash',
      'cf login',
      'cf push',
      '```',
      '',
      '1. {1} Login',
      '2. {2} Push',
      ':::',
    ].join('\n')

    const text = renderDirectivesAsText(md)
    // fence itself unchanged
    expect(text).toContain('```bash')
    expect(text).toContain('cf login')
    expect(text).toContain('cf push')
  })
})
