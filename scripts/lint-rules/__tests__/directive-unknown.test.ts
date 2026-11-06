import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { directiveUnknownRule } from '../directive-unknown'
import { registerDirective, resetRegistry } from '../../parsers/directive-registry'

function runRule(source: string, slug = 'fixture') {
  const lines = source.split('\n')
  return directiveUnknownRule.scan(slug, lines, lines)
}

describe('directive-unknown', () => {
  afterEach(() => {
    resetRegistry()
  })

  it('warns on unregistered inline directive with correct line + severity', () => {
    const src = [
      'Some prose.',
      '',
      'This has :foo[bar] in it.',
      '',
      'More prose.',
    ].join('\n')
    const findings = runRule(src)
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      rule: 'directive-unknown',
      line: 3,
      severity: 'warning',
      message: expect.stringContaining('foo'),
    })
  })

  it('does not warn on registered inline directive', () => {
    registerDirective({
      name: 'echo',
      kinds: ['inline'],
      summary: 'Test directive',
      attrs: {},
    })
    const src = 'This has :echo[hello] in it.'
    expect(runRule(src)).toHaveLength(0)
  })

  it('warns on unregistered leaf directive with correct line', () => {
    const src = [
      'Some prose.',
      '',
      '::unknown-leaf[label]',
      '',
      'More prose.',
    ].join('\n')
    const findings = runRule(src)
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      rule: 'directive-unknown',
      line: 3,
      severity: 'warning',
    })
  })

  it('warns on unregistered container directive with correct line', () => {
    const src = [
      'Some prose.',
      '',
      ':::unknown-container',
      'body content',
      ':::',
      '',
      'More prose.',
    ].join('\n')
    const findings = runRule(src)
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      rule: 'directive-unknown',
      line: 3,
      severity: 'warning',
    })
  })

  it('does not warn on directive inside fenced code block', () => {
    const src = [
      'Some prose.',
      '',
      '```',
      ':::details',
      'code here',
      ':::',
      '```',
      '',
      'More prose.',
    ].join('\n')
    const findings = runRule(src)
    expect(findings).toHaveLength(0)
  })

  it('warns on multiple unknown directives', () => {
    const src = [
      ':foo[one]',
      ':bar[two]',
      '::baz',
      ':::qux',
      'content',
      ':::',
    ].join('\n')
    const findings = runRule(src)
    expect(findings).toHaveLength(4)
  })

  it('does not warn on :smile: (no [ bracket)', () => {
    const src = 'This is a :smile: emoji reference'
    expect(runRule(src)).toHaveLength(0)
  })
})
