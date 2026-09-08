import { describe, it, expect } from 'vitest'
import { authorNameWithoutProfileRule } from '../author-name-without-profile'

// Rule shape mirrors scripts/lint-tutorial-markdown.ts: scan(slug, lines, rawLines).
// This rule reads the raw source frontmatter (snake_case keys), so we pass the
// same array as both `lines` and `rawLines`.
function runRule(source: string, slug = 'fixture') {
  const lines = source.split('\n')
  return authorNameWithoutProfileRule.scan(slug, lines, lines)
}

const fm = (body: string) => `---\n${body}\n---\n\nSome tutorial prose.\n`

describe('author-name-without-profile', () => {
  it('warns when author_profile key is present but blank', () => {
    const src = fm('author_name: Rebecca Yang\nauthor_profile: \nprimary_tag: software-product>joule')
    const findings = runRule(src)
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      rule: 'author-name-without-profile',
      line: 3, // the blank author_profile line
      severity: 'warning',
    })
    expect(findings[0].message).toContain('Rebecca Yang')
    expect(findings[0].message).toContain('present but blank')
  })

  it('warns and anchors at author_name when the author_profile key is absent', () => {
    const src = fm('author_name: Jane Doe\nprimary_tag: tutorial')
    const findings = runRule(src)
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ line: 2, severity: 'warning' })
    expect(findings[0].message).toContain('key absent')
  })

  it('does not fire when a real author_profile is present', () => {
    const src = fm('author_name: Jane Doe\nauthor_profile: https://github.com/janedoe')
    expect(runRule(src)).toHaveLength(0)
  })

  it('does not fire when there is no author_name (contributor-only attribution is legitimate)', () => {
    const src = fm('author_profile: \nprimary_tag: tutorial')
    expect(runRule(src)).toHaveLength(0)
  })

  it('does not fire when author_name is blank', () => {
    const src = fm('author_name: \nauthor_profile: ')
    expect(runRule(src)).toHaveLength(0)
  })

  it('does not fire when there is no frontmatter block at all', () => {
    expect(runRule('# Just a heading\n\nProse.')).toHaveLength(0)
  })

  it('only inspects the frontmatter block, ignoring decoy keys in the body', () => {
    const src = fm('author_name: Real Author\nauthor_profile: ') +
      '\nauthor_profile: https://github.com/decoy\n'
    // The body author_profile must NOT satisfy the frontmatter check.
    const findings = runRule(src)
    expect(findings).toHaveLength(1)
    expect(findings[0].line).toBe(3) // blank author_profile inside frontmatter
    expect(findings[0].message).toContain('Real Author')
  })
})
