import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { extToMime, dispositionFor } = require('../../srv/lib/attachment-mime.cjs')

describe('extToMime', () => {
  it('maps known extensions', () => {
    expect(extToMime('a.txt')).toMatch(/text\/plain/)
    expect(extToMime('a.json')).toBe('application/json')
    expect(extToMime('a.csv')).toBe('text/csv')
    expect(extToMime('a.zip')).toBe('application/zip')
    expect(extToMime('a.pdf')).toBe('application/pdf')
  })
  it('falls back to octet-stream for unknown', () => {
    expect(extToMime('a.bin')).toBe('application/octet-stream')
  })
})

describe('dispositionFor', () => {
  it('text types serve inline', () => {
    expect(dispositionFor('text/plain; charset=utf-8', { filename: 'a.txt' }).disposition).toMatch(/^inline/)
  })
  it('binaries force attachment with filename', () => {
    const d = dispositionFor('application/zip', { filename: 'a.zip' })
    expect(d.disposition).toBe('attachment; filename="a.zip"')
  })
  it('text/html is neutered to text/plain inline', () => {
    const d = dispositionFor('text/html', { filename: 'a.html' })
    expect(d.contentType).toMatch(/text\/plain/)
    expect(d.disposition).toMatch(/^inline/)
  })
  it('download:true forces attachment for any type', () => {
    const d = dispositionFor('text/plain; charset=utf-8', { download: true, filename: 'a.txt' })
    expect(d.disposition).toBe('attachment; filename="a.txt"')
  })
})
