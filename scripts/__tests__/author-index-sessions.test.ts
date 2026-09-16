import { describe, it, expect } from 'vitest'
import { buildAuthorIndex, type AuthorTutorialRow, type AuthorSessions } from '../parsers/author-index'

const rows: AuthorTutorialRow[] = [
  {
    authorProfile: 'https://github.com/thomas-jung',
    displayName: 'Thomas Jung',
    slug: 'tut-a', title: 'Tut A', time: 20, level: 'Beginner', tags: ['cap'],
    createdAt: '2026-01-01', isNew: false,
  } as AuthorTutorialRow,
  {
    authorProfile: 'https://github.com/other-dev',
    displayName: 'Other Dev',
    slug: 'tut-b', title: 'Tut B', time: 15, level: 'Beginner', tags: ['btp'],
    createdAt: '2026-01-02', isNew: false,
  } as AuthorTutorialRow,
]

const sampleSessions: AuthorSessions = {
  teched: [{ event: 'teched', title: 'Keynote', sourceUrl: 'https://x', track: 'ABAP', venue: 'BERLIN', date: '2026-11-10' }],
  devtoberfest: [],
}

describe('buildAuthorIndex — sessions (issue #2354)', () => {
  it('attaches sessions for logins present in the map', () => {
    const idx = buildAuthorIndex(rows, new Map(), undefined, new Map([['thomas-jung', sampleSessions]]))
    expect(idx['thomas-jung'].sessions).toEqual(sampleSessions)
  })

  it('omits sessions for logins not in the map', () => {
    const idx = buildAuthorIndex(rows, new Map(), undefined, new Map([['thomas-jung', sampleSessions]]))
    expect(idx['other-dev']).not.toHaveProperty('sessions')
  })

  it('omits sessions when both arrays are empty', () => {
    const empty: AuthorSessions = { teched: [], devtoberfest: [] }
    const idx = buildAuthorIndex(rows, new Map(), undefined, new Map([['thomas-jung', empty]]))
    expect(idx['thomas-jung']).not.toHaveProperty('sessions')
  })

  it('fail-open: no map supplied → no sessions anywhere', () => {
    const idx = buildAuthorIndex(rows, new Map())
    expect(idx['thomas-jung']).not.toHaveProperty('sessions')
    expect(idx['other-dev']).not.toHaveProperty('sessions')
  })

  it('fail-open: empty map → no sessions', () => {
    const idx = buildAuthorIndex(rows, new Map(), undefined, new Map())
    expect(idx['thomas-jung']).not.toHaveProperty('sessions')
  })
})
