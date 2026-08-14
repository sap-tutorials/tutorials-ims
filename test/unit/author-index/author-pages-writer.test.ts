import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeAuthorPages } from '../../../scripts/lib/author-pages-writer'

const row = (o = {}) => ({
  authorProfile: 'https://github.com/thomas-jung', displayName: 'Thomas Jung',
  slug: 'a', title: 'A', time: 10, level: 'Beginner', tags: [], isNew: false, ...o,
})

describe('writeAuthorPages', () => {
  let dir: string, dataFile: string, contentDir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'authors-'))
    dataFile = join(dir, 'data', 'author_index.json')
    contentDir = join(dir, 'content', 'authors')
  })
  it('writes the index json and a page per non-advocate login', () => {
    const res = writeAuthorPages({
      rows: [row(), row({ slug: 'b', authorProfile: 'https://github.com/jane', displayName: 'Jane' })],
      advocates: new Map([['jane', 'jane-doe']]),
      dataFile, contentDir,
    })
    const idx = JSON.parse(readFileSync(dataFile, 'utf-8'))
    expect(Object.keys(idx).sort()).toEqual(['jane', 'thomas-jung'])
    expect(idx['jane'].advocateSlug).toBe('jane-doe')
    expect(existsSync(join(contentDir, 'thomas-jung.md'))).toBe(true)
    expect(existsSync(join(contentDir, 'jane.md'))).toBe(false) // advocate → alias owns route
    expect(res.pagesWritten).toBe(1)
  })
  it('prunes stale author pages', () => {
    mkdirSync(contentDir, { recursive: true })
    writeFileSync(join(contentDir, 'ghost.md'), '---\n---\n')
    writeAuthorPages({ rows: [row()], advocates: new Map(), dataFile, contentDir })
    expect(existsSync(join(contentDir, 'ghost.md'))).toBe(false)
    expect(existsSync(join(contentDir, 'thomas-jung.md'))).toBe(true)
  })
})
