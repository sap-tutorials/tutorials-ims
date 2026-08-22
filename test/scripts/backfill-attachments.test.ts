import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectAttachmentUrls, isRawGithubHost } from '../../scripts/backfill-attachments.js'

describe('collectAttachmentUrls', () => {
  it('collects attachment source URLs from built tutorial HTML', () => {
    const root = mkdtempSync(join(tmpdir(), 'bf-'))
    const dir = join(root, 'tutorials', 'rap100'); mkdirSync(dir, { recursive: true })
    const raw = 'https://raw.githubusercontent.com/sap-tutorials/abap-core-development/main/tutorials/rap100/EX2.txt'
    writeFileSync(join(dir, 'index.html'), `<a href="/content/attachment-source?u=${encodeURIComponent(raw)}">d</a>`)
    const map = collectAttachmentUrls(root)
    expect(map.get(raw)).toBe('rap100')
  })
})

describe('isRawGithubHost', () => {
  it('returns true for a legitimate raw.githubusercontent.com URL', () => {
    expect(isRawGithubHost('https://raw.githubusercontent.com/o/r/main/f.txt')).toBe(true)
  })
  it('returns false for a lookalike subdomain attack', () => {
    expect(isRawGithubHost('https://raw.githubusercontent.com.evil.com/f.txt')).toBe(false)
  })
  it('returns false when hostname contains raw.githubusercontent.com as a query param', () => {
    expect(isRawGithubHost('https://evil.com/?q=raw.githubusercontent.com')).toBe(false)
  })
  it('returns false for a malformed URL', () => {
    expect(isRawGithubHost('not-a-url')).toBe(false)
  })
})
