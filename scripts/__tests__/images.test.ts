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
})
