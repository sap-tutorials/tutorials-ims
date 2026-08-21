import { describe, it, expect, vi } from 'vitest'
import { extractAttachmentUrls, warmAttachments } from '../../srv/lib/attachment-warm-utils.js'

describe('extractAttachmentUrls', () => {
  it('extracts and decodes u= from attachment-source hrefs (view + dl)', () => {
    const raw = 'https://raw.githubusercontent.com/o/r/main/tutorials/s/EX2.txt'
    const enc = encodeURIComponent(raw)
    const html = `<a href="/content/attachment-source?u=${enc}">d</a><a href="/content/attachment-source?u=${enc}&dl=1">↓</a>`
    expect(extractAttachmentUrls(html)).toEqual([raw]) // deduped
  })
  it('returns [] when there are no attachment links', () => {
    expect(extractAttachmentUrls('<p>no links</p>')).toEqual([])
  })
})

describe('warmAttachments', () => {
  it('calls ingestFn per url and never throws on failure', async () => {
    const ingestFn = vi.fn().mockRejectedValue(new Error('boom'))
    await expect(warmAttachments(['a', 'b'], { slug: 's', ingestFn })).resolves.toBeUndefined()
    expect(ingestFn).toHaveBeenCalledTimes(2)
  })
})
