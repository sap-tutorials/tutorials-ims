// test/unit/scripts/seed-authors-from-deployed.test.ts
//
// Guards scripts/seed-authors-from-deployed.ts — the fix for the "catalog-only
// rebuild wipes /authors/*" incident (analogue of the 2026-08-07 /browse/ wipe).
// That script re-hydrates author_index.json from the copy the approuter serves
// at /author_index.json, so a catalog-only rebuild (which skips fetch-tutorials
// → writeAuthorPages) doesn't ship a wiped /authors/* that the /admin/rebuild
// atomic STATIC_DIR swap would clobber the good pages with.

import { describe, it, expect } from 'vitest'
import { parseAuthorIndex } from '../../../scripts/seed-authors-from-deployed'

const index = {
  'thomas-jung': {
    login: 'thomas-jung',
    displayName: 'Thomas Jung',
    githubUrl: 'https://github.com/thomas-jung',
    tutorials: [{ slug: 'a', title: 'A', time: 10, level: 'Beginner', tags: [], isNew: false }],
  },
}

describe('parseAuthorIndex', () => {
  it('parses a populated author_index.json object', () => {
    const out = parseAuthorIndex(JSON.stringify(index))
    expect(Object.keys(out)).toEqual(['thomas-jung'])
    expect(out['thomas-jung'].tutorials).toHaveLength(1)
  })

  it('preserves an empty index as-is (empty-detection belongs to main, not the parser)', () => {
    expect(Object.keys(parseAuthorIndex('{}'))).toHaveLength(0)
  })

  it('throws on malformed JSON rather than returning junk', () => {
    expect(() => parseAuthorIndex('{ not: valid json, }')).toThrow(/not valid JSON/)
  })

  it('throws when the body parses to a bare array (not an index object)', () => {
    expect(() => parseAuthorIndex('[1,2,3]')).toThrow(/did not parse to an object/)
  })

  it('throws when the body parses to a bare number', () => {
    expect(() => parseAuthorIndex('42')).toThrow(/did not parse to an object/)
  })
})
