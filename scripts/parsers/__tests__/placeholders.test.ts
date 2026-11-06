import { describe, it, expect } from 'vitest'
import { validatePlaceholders, wrapPlaceholders, type PlaceholderDef } from '../variables.js'

describe('validatePlaceholders', () => {
  it('auto: detects <YOUR_SUBACCOUNT> in a fence', () => {
    const result = validatePlaceholders('auto', '```\n$ cf target -s <YOUR_SUBACCOUNT>\n```')
    expect(result).toHaveLength(1)
    expect(result[0].token).toBe('<YOUR_SUBACCOUNT>')
  })

  it('auto: detects <MY-space-name> token', () => {
    const result = validatePlaceholders('auto', '```\ncf create-space <MY-space-name>\n```')
    expect(result).toHaveLength(1)
    expect(result[0].token).toBe('<MY-space-name>')
  })

  it('auto: does not match <String>, <div>, <T>', () => {
    const result = validatePlaceholders('auto', '```ts\nfunction f<T>(x: T): string {}\n```')
    expect(result).toHaveLength(0)
  })

  it('auto: does not match <AB> (only 2 uppercase chars)', () => {
    const result = validatePlaceholders('auto', '```\nsome <AB> text\n```')
    expect(result).toHaveLength(0)
  })

  it('auto: does not match <BTP_TRIAL> when preceded by a letter (generic context)', () => {
    // Regression test for F1: second branch of PLACEHOLDER_RE must have lookbehind
    const result = validatePlaceholders('auto', '```ts\ntype Foo = Array<BTP_TRIAL>\n```')
    expect(result).toHaveLength(0)
  })

  it('auto: matches <BTP_TRIAL> when standalone (not preceded by letter)', () => {
    const result = validatePlaceholders('auto', '```\nuse <BTP_TRIAL> here\n```')
    expect(result).toHaveLength(1)
  })

  it('explicit list: uses declared tokens', () => {
    const result = validatePlaceholders(
      [{ token: '<MY_KEY>', label: 'Your API Key' }],
      'use <MY_KEY> here'
    )
    expect(result).toHaveLength(1)
    expect(result[0].token).toBe('<MY_KEY>')
    expect(result[0].label).toBe('Your API Key')
  })

  it('explicit list: auto-generates label when absent', () => {
    const result = validatePlaceholders(
      [{ token: '<YOUR_SUBACCOUNT>' }],
      '```\n<YOUR_SUBACCOUNT>\n```'
    )
    expect(result).toHaveLength(1)
    expect(result[0].label).toBeTruthy()
  })

  it('auto: deduplicates tokens appearing multiple times', () => {
    const result = validatePlaceholders('auto', '```\n<YOUR_KEY>\n<YOUR_KEY>\n```')
    expect(result).toHaveLength(1)
  })
})

describe('wrapPlaceholders', () => {
  it('replaces token in fence with sentinel', () => {
    const md = '```\ncf target -s <YOUR_SUBACCOUNT>\n```'
    const result = wrapPlaceholders(md, [{ token: '<YOUR_SUBACCOUNT>', label: 'Subaccount' }])
    expect(result).toContain('TUTVARx')
    expect(result).not.toContain('<YOUR_SUBACCOUNT>')
  })

  it('replaces token in prose with tut-var span', () => {
    const md = 'Replace <YOUR_SUBACCOUNT> now.'
    const result = wrapPlaceholders(md, [{ token: '<YOUR_SUBACCOUNT>', label: 'Subaccount' }])
    expect(result).toContain('class="tut-var')
    expect(result).toContain('data-tut-var=')
  })

  it('does not replace tokens NOT in the placeholders list', () => {
    const md = '```\n<UNTOUCHED>\n```'
    const result = wrapPlaceholders(md, [{ token: '<YOUR_KEY>', label: 'Key' }])
    expect(result).toContain('<UNTOUCHED>')
  })

  it('sentinel name is NAME_RE safe (no special chars)', () => {
    // <MY-space-name> → MY_space_name
    const md = '```\ncf create-space <MY-space-name>\n```'
    const result = wrapPlaceholders(md, [{ token: '<MY-space-name>', label: 'Space' }])
    // Sentinel must be letters/digits/underscore only
    expect(result).toMatch(/TUTVARx[A-Za-z0-9_]+x/)
    // The sentinel itself (TUTVARx...x) must not contain hyphens
    // (Note: surrounding text like "create-space" may still contain hyphens)
    const sentinelMatch = result.match(/TUTVARx([A-Za-z0-9_-]+)x/)
    expect(sentinelMatch).toBeTruthy()
    expect(sentinelMatch![1]).not.toContain('-')
  })
})
