import { describe, it, expect } from 'vitest'
import { resolveImageURLs } from '../parsers/images.js'

describe('resolveImageURLs', () => {
  const opts = { repo: 'Tutorials', branch: 'master', slug: 'hana-cloud-cap-create-project' }
  const base = 'https://raw.githubusercontent.com/sap-tutorials/Tutorials/master/tutorials/hana-cloud-cap-create-project'

  it('resolves bare filename', () => {
    const result = resolveImageURLs('![Run](27.png)', opts)
    expect(result).toBe(`![Run](${base}/27.png)`)
  })

  it('strips leading slash', () => {
    const result = resolveImageURLs('![alt](/27.png)', opts)
    expect(result).toBe(`![alt](${base}/27.png)`)
  })

  it('resolves subdirectory path', () => {
    const result = resolveImageURLs('![alt](images/foo.png)', opts)
    expect(result).toBe(`![alt](${base}/images/foo.png)`)
  })

  it('leaves absolute URLs unchanged', () => {
    const input = '![alt](https://example.com/x.png)'
    expect(resolveImageURLs(input, opts)).toBe(input)
  })

  it('leaves traversal paths unchanged', () => {
    const input = '![alt](../sibling/x.png)'
    expect(resolveImageURLs(input, opts)).toBe(input)
  })

  it('handles multiple images in one string', () => {
    const input = '![a](1.png) text ![b](2.png)'
    const result = resolveImageURLs(input, opts)
    expect(result).toContain(`${base}/1.png`)
    expect(result).toContain(`${base}/2.png`)
  })

  describe('strips border/size HTML-comment directives (#1137)', () => {
    // If the directive comment survives, goldmark treats `<!--` as the start of
    // an HTML block and swallows the trailing `![…]` as raw HTML text — the
    // image never renders. This affects the combined `border; size:Npx` form
    // used by ~1600 images in the corpus, which the original single-alternative
    // regex failed to strip.
    const forms: Array<[string, string]> = [
      ['border only', '<!-- border --> ![a](27.png)'],
      ['size only', '<!-- size:540px --> ![a](27.png)'],
      ['combined border; size', '<!-- border; size:540px --> ![a](27.png)'],
      ['combined, tight close', '<!-- border; size:300px--> ![a](27.png)'],
      ['combined, space-separated', '<!-- border size:540px --> ![a](27.png)'],
      ['reversed order', '<!-- size:540px; border --> ![a](27.png)'],
      ['no leading space', '<!--border --> ![a](27.png)'],
    ]
    for (const [name, input] of forms) {
      it(`strips ${name}`, () => {
        const result = resolveImageURLs(input, opts)
        expect(result).not.toContain('<!--')
        expect(result).toBe(`![a](${base}/27.png)`)
      })
    }

    it('leaves unrelated comments untouched', () => {
      const input = '<!-- TODO fix later --> ![a](27.png)'
      const result = resolveImageURLs(input, opts)
      expect(result).toContain('<!-- TODO fix later -->')
      expect(result).toContain(`${base}/27.png`)
    })
  })
})
