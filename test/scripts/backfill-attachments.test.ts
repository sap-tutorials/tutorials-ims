import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectAttachmentUrls } from '../../scripts/backfill-attachments.js'

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
