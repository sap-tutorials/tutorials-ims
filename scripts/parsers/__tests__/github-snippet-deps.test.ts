import { describe, it, expect } from 'vitest'
import { buildSnippetDeps } from '../github.js'

describe('buildSnippetDeps', () => {
  it('returns empty record for empty inputs', () => {
    expect(buildSnippetDeps(new Map(), [])).toEqual({})
  })

  it('maps snippet key to slugs that include it', () => {
    const snippetMap = new Map([['myrepo/_snippets/step.md', 'content']])
    const tutorials = [
      { slug: 'tut-a', rawMd: '::include[step.md]\nsome text' },
      { slug: 'tut-b', rawMd: 'no include here' },
      { slug: 'tut-c', rawMd: '::include[step.md]\nmore text' },
    ]
    const deps = buildSnippetDeps(snippetMap, tutorials)
    expect(deps['myrepo/_snippets/step.md']).toEqual(expect.arrayContaining(['tut-a', 'tut-c']))
    expect(deps['myrepo/_snippets/step.md']).toHaveLength(2)
  })

  it('resolves shared: prefix (key without .md, matching fetchSnippets output)', () => {
    // fetchSnippets strips .md from shared/ keys: 'shared/cf-cli.md' → 'shared/cf-cli'
    // ::include[shared:cf-cli] → resolveSnippetKey → 'shared/cf-cli' → found
    const snippetMap = new Map([['shared/cf-cli', 'content']])
    const tutorials = [{ slug: 'tut-a', rawMd: '::include[shared:cf-cli]' }]
    const deps = buildSnippetDeps(snippetMap, tutorials)
    expect(deps['shared/cf-cli']).toEqual(['tut-a'])
  })

  it('deduplicates slugs when tutorial includes snippet twice', () => {
    const snippetMap = new Map([['r/_snippets/s.md', 'content']])
    const tutorials = [{ slug: 'tut-a', rawMd: '::include[s.md]\n::include[s.md]' }]
    const deps = buildSnippetDeps(snippetMap, tutorials)
    expect(deps['r/_snippets/s.md']).toEqual(['tut-a'])
  })

  it('records unknown snippets (label not in map) as the label itself', () => {
    const snippetMap = new Map<string, string>()
    const tutorials = [{ slug: 'tut-a', rawMd: '::include[unknown-snippet]' }]
    const deps = buildSnippetDeps(snippetMap, tutorials)
    // Key is the raw label since no suffix match found
    expect(Object.keys(deps)).toHaveLength(1)
    expect(Object.values(deps)[0]).toContain('tut-a')
  })

  it('skips tutorials with empty rawMd', () => {
    const snippetMap = new Map([['r/_snippets/s.md', 'content']])
    const tutorials = [{ slug: 'tut-a', rawMd: '' }]
    const deps = buildSnippetDeps(snippetMap, tutorials)
    expect(Object.keys(deps)).toHaveLength(0)
  })

  it('does NOT match single-colon :include (only double-colon ::include)', () => {
    // :include[x] in e.g. a code example or text must not be treated as a directive
    const snippetMap = new Map([['r/_snippets/s.md', 'content']])
    const tutorials = [{ slug: 'tut-a', rawMd: 'some text :include[s.md] end' }]
    const deps = buildSnippetDeps(snippetMap, tutorials)
    expect(Object.keys(deps)).toHaveLength(0)
  })
})

