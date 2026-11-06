import { describe, it, expect } from 'vitest'
import { directiveSuggestUiRule } from '../directive-suggest-ui'

/**
 * Simulate how lint-tutorial-markdown redacts fenced code blocks:
 * fence delimiter lines and lines inside fences are replaced with empty strings,
 * so the rule receives blank lines in those positions.
 */
function redactFences(source: string): string[] {
  const raw = source.split('\n')
  const result: string[] = []
  let inFence = false
  for (const line of raw) {
    const fenceMatch = line.match(/^[ \t]{0,3}(```|~~~)/)
    if (fenceMatch) {
      inFence = !inFence
      result.push('')
    } else if (inFence) {
      result.push('')
    } else {
      result.push(line)
    }
  }
  return result
}

function runRule(source: string, slug = 'fixture') {
  const rawLines = source.split('\n')
  const lines = redactFences(source)
  return directiveSuggestUiRule.scan(slug, lines, rawLines)
}

describe('directive-suggest-ui', () => {
  it('fires on "Click **Save** to continue"', () => {
    const findings = runRule('Click **Save** to continue')
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      rule: 'directive-suggest-ui',
      slug: 'fixture',
      file: 'fixture.md',
      line: 1,
      severity: 'notice',
    })
    expect(findings[0].message).toContain('Save')
  })

  it('finding message has correct format including :ui[X]{type=button}, **X**, line N, and slug', () => {
    const findings = runRule('Click **Save** to continue')
    expect(findings[0].message).toMatch(/:ui\[Save\]\{type=button\}/)
    expect(findings[0].message).toContain('**Save**')
    expect(findings[0].message).toContain('line 1')
    expect(findings[0].message).toContain('fixture')
  })

  it('does NOT fire when line already uses :ui[', () => {
    const findings = runRule('Click :ui[Save]{type=button} to continue')
    expect(findings).toHaveLength(0)
  })

  it('does NOT fire when match is inside fenced code block', () => {
    const src = [
      'Some prose.',
      '```',
      'Click **Save** to continue',
      '```',
      'More prose.',
    ].join('\n')
    const findings = runRule(src)
    expect(findings).toHaveLength(0)
  })

  it('does NOT fire when there is no "click" word before the bold text', () => {
    const findings = runRule('The **Save** button is important')
    expect(findings).toHaveLength(0)
  })

  it('produces one finding per match when multiple matches on same line', () => {
    const findings = runRule('Click **Save** and then click **Cancel** to finish')
    expect(findings).toHaveLength(2)
    const messages = findings.map(f => f.message)
    expect(messages.some(m => m.includes('Save'))).toBe(true)
    expect(messages.some(m => m.includes('Cancel'))).toBe(true)
  })

  it('includes correct line number in finding', () => {
    const src = [
      'First line',
      'Second line',
      'Click **Apply** to confirm',
      'Fourth line',
    ].join('\n')
    const findings = runRule(src)
    expect(findings).toHaveLength(1)
    expect(findings[0].line).toBe(3)
  })

  it('is case-insensitive for the click keyword', () => {
    const findings = runRule('CLICK **Save** to continue')
    expect(findings).toHaveLength(1)
  })

  it('excerpt is the raw (un-redacted) matching line content', () => {
    const findings = runRule('Click **Save** to continue')
    expect(findings[0].excerpt).toBe('Click **Save** to continue')
  })

  it('fires on multi-word button label', () => {
    const findings = runRule('Click **Save Draft** to continue')
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toContain('Save Draft')
  })
})
