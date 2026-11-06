import { describe, it, expect } from 'vitest'
import { directiveSuggestKbdRule } from '../directive-suggest-kbd'

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
  return directiveSuggestKbdRule.scan(slug, lines, rawLines)
}

describe('directive-suggest-kbd', () => {
  it('fires on "Press Ctrl+S to save"', () => {
    const findings = runRule('Press Ctrl+S to save')
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      rule: 'directive-suggest-kbd',
      slug: 'fixture',
      file: 'fixture.md',
      line: 1,
      severity: 'notice',
    })
    expect(findings[0].message).toContain('Ctrl+S')
  })

  it('fires on "use Cmd+Shift+P"', () => {
    const findings = runRule('use Cmd+Shift+P to open command palette')
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toContain('Cmd+Shift+P')
  })

  it('fires on "Alt+F4"', () => {
    const findings = runRule('Press Alt+F4 to close the window')
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toContain('Alt+F4')
  })

  it('fires on "Command+C"', () => {
    const findings = runRule('Use Command+C to copy')
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toContain('Command+C')
  })

  it('fires on "Option+Delete"', () => {
    const findings = runRule('Use Option+Delete to delete the previous word')
    expect(findings).toHaveLength(1)
  })

  it('fires on "Shift+Enter"', () => {
    const findings = runRule('Press Shift+Enter to insert a line break')
    expect(findings).toHaveLength(1)
  })

  it('fires on "Win+D"', () => {
    const findings = runRule('Press Win+D to show the desktop')
    expect(findings).toHaveLength(1)
  })

  it('finding message format contains :kbd[...] suggestion and quoted match', () => {
    const findings = runRule('Press Ctrl+S to save')
    expect(findings[0].message).toContain(':kbd[')
    expect(findings[0].message).toContain('"Ctrl+S"')
    expect(findings[0].message).toContain('line 1')
    expect(findings[0].message).toContain('fixture')
  })

  it('does NOT fire when line already contains :kbd[', () => {
    const findings = runRule('Press :kbd[Ctrl+S] to save')
    expect(findings).toHaveLength(0)
  })

  it('does NOT fire when match is inside fenced code block', () => {
    const src = [
      'Some prose.',
      '```',
      'Press Ctrl+S to save',
      '```',
      'More prose.',
    ].join('\n')
    const findings = runRule(src)
    expect(findings).toHaveLength(0)
  })

  it('produces one finding per match when multiple matches on same line', () => {
    const findings = runRule('Press Ctrl+C to copy then Ctrl+V to paste')
    expect(findings).toHaveLength(2)
    const messages = findings.map(f => f.message)
    expect(messages.some(m => m.includes('Ctrl+C'))).toBe(true)
    expect(messages.some(m => m.includes('Ctrl+V'))).toBe(true)
  })

  it('includes correct line number in finding', () => {
    const src = [
      'First line',
      'Second line',
      'Press Ctrl+S to save',
      'Fourth line',
    ].join('\n')
    const findings = runRule(src)
    expect(findings).toHaveLength(1)
    expect(findings[0].line).toBe(3)
  })

  it('is case-insensitive for the modifier key name', () => {
    // ctrl (lowercase) should also fire
    const findings = runRule('Press ctrl+s to save')
    expect(findings).toHaveLength(1)
  })

  it('excerpt is the raw (un-redacted) matching line content', () => {
    const findings = runRule('Press Ctrl+S to save')
    expect(findings[0].excerpt).toBe('Press Ctrl+S to save')
  })

  it('slug and file are set correctly', () => {
    const findings = runRule('Press Ctrl+S to save', 'my-tutorial')
    expect(findings[0].slug).toBe('my-tutorial')
    expect(findings[0].file).toBe('my-tutorial.md')
  })
})
