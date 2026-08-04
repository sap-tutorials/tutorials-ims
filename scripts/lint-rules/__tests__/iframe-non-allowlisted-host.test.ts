import { describe, it, expect } from 'vitest'
import { iframeNonAllowlistedHostRule } from '../iframe-non-allowlisted-host'

// Rule shape mirrors the existing pattern in scripts/lint-tutorial-markdown.ts:
//   scan(slug, lines, rawLines): LintFinding[]
// `lines` arrives with code fences redacted; rules generally use `lines`
// rather than rawLines for prose-pattern matching.

function runRule(source: string, slug = 'fixture') {
  const lines = source.split('\n')
  return iframeNonAllowlistedHostRule.scan(slug, lines, lines)
}

describe('iframe-non-allowlisted-host', () => {
  it('warns on non-allowlisted iframe with correct line + severity', () => {
    const src = [
      'Some prose.',
      '',
      '<iframe src="https://www.dailymotion.com/video/123"></iframe>',
      '',
      'More prose.',
    ].join('\n')
    const findings = runRule(src)
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      rule: 'iframe-non-allowlisted-host',
      line: 3,
      severity: 'warning',
    })
    expect(findings[0].message).toContain('www.dailymotion.com')
  })

  it('does not fire on YouTube iframe (allowlisted)', () => {
    const src = '<iframe src="https://www.youtube.com/embed/8obCwGEx1-Q"></iframe>'
    expect(runRule(src)).toHaveLength(0)
  })

  it('does not fire on microlearning.opensap.com iframe (allowlisted)', () => {
    const src = '<iframe src="https://microlearning.opensap.com/embed/secure/iframe/entryId/1_x"></iframe>'
    expect(runRule(src)).toHaveLength(0)
  })

  it('warns on malformed iframe src', () => {
    const src = '<iframe src="not a url"></iframe>'
    const findings = runRule(src)
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toContain('Malformed')
    expect(findings[0].severity).toBe('warning')
  })

  it('fires once per iframe when multiple iframes are on the same line', () => {
    const src = '<iframe src="https://twitch.tv/1"></iframe><iframe src="https://dailymotion.com/2"></iframe>'
    const findings = runRule(src)
    expect(findings).toHaveLength(2)
    expect(findings[0].message).toContain('twitch.tv')
    expect(findings[1].message).toContain('dailymotion.com')
  })

  it('does not fire on Vimeo iframes (allowlisted)', () => {
    expect(runRule('<iframe src="https://player.vimeo.com/video/123456"></iframe>')).toHaveLength(0)
    expect(runRule('<iframe src="https://vimeo.com/123456"></iframe>')).toHaveLength(0)
  })
})
