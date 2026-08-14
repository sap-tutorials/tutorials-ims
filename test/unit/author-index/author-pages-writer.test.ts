import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeAuthorPages, writeAuthorPagesFromIndex } from '../../../scripts/lib/author-pages-writer'

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
  it('writes a served publishFile copy of the index when requested', () => {
    const publishFile = join(dir, 'static', 'author_index.json')
    writeAuthorPages({ rows: [row()], advocates: new Map(), dataFile, contentDir, publishFile })
    expect(existsSync(publishFile)).toBe(true)
    expect(readFileSync(publishFile, 'utf-8')).toBe(readFileSync(dataFile, 'utf-8'))
  })
})

describe('writeAuthorPagesFromIndex (catalog-only re-hydration path)', () => {
  let dir: string, dataFile: string, contentDir: string, publishFile: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'authors-idx-'))
    dataFile = join(dir, 'data', 'author_index.json')
    contentDir = join(dir, 'content', 'authors')
    publishFile = join(dir, 'static', 'author_index.json')
  })
  const idx = {
    'thomas-jung': { login: 'thomas-jung', displayName: 'Thomas Jung', githubUrl: 'https://github.com/thomas-jung', tutorials: [{ slug: 'a', title: 'A', time: 10, level: 'Beginner', tags: [], isNew: false }] },
    jane: { login: 'jane', displayName: 'Jane', githubUrl: 'https://github.com/jane', advocateSlug: 'jane-doe', tutorials: [] },
  }
  it('regenerates data + served copy + a stub per non-advocate login from a prebuilt index', () => {
    const res = writeAuthorPagesFromIndex({ index: idx, dataFile, contentDir, publishFile })
    expect(JSON.parse(readFileSync(dataFile, 'utf-8'))['thomas-jung'].displayName).toBe('Thomas Jung')
    expect(readFileSync(publishFile, 'utf-8')).toBe(readFileSync(dataFile, 'utf-8'))
    expect(existsSync(join(contentDir, 'thomas-jung.md'))).toBe(true)
    expect(existsSync(join(contentDir, 'jane.md'))).toBe(false) // advocate → alias owns route
    expect(res.pagesWritten).toBe(1)
  })
})
