// scripts/parsers/__tests__/callout-directives.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { resetRegistry, getRegistry } from '../directive-registry.js'
import { registerCalloutDirectives } from '../directives/callout-directives.js'

describe('callout-directives registration', () => {
  beforeEach(() => {
    resetRegistry()
    registerCalloutDirectives()
  })

  it('registers all six directives when imported', async () => {
    await import('../directives/callout-directives.js')
    const r = getRegistry()
    expect([...r.keys()].sort()).toContain('details')
    expect([...r.keys()].sort()).toContain('troubleshoot')
    expect([...r.keys()].sort()).toContain('result')
    expect([...r.keys()].sort()).toContain('hint')
    expect([...r.keys()].sort()).toContain('solution')
    expect([...r.keys()].sort()).toContain('spoiler')
  })

  it('details render returns tut-alert shortcode params with type=details and title', async () => {
    await import('../directives/callout-directives.js')
    const def = getRegistry().get('details')!
    const node = { kind: 'container', name: 'details', label: 'Why does this work?', attrs: {}, classes: [], body: 'body content', line: 1, column: 0 }
    const out = def.render(node, {})
    expect(out.params?.type).toBe('details')
    expect(out.params?.title).toBe('Why does this work?')
    expect(out.body).toBe('body content')
  })

  it('details toText includes bold label and body', async () => {
    await import('../directives/callout-directives.js')
    const def = getRegistry().get('details')!
    const node = { kind: 'container', label: 'Title', attrs: {}, body: 'body', line: 1, column: 0 }
    expect(def.toText(node, {})).toBe('**Details: Title**\n\nbody')
  })

  it('spoiler toText returns ||text||', async () => {
    await import('../directives/callout-directives.js')
    const def = getRegistry().get('spoiler')!
    const node = { kind: 'inline', label: 'secret', attrs: {}, classes: [], line: 1, column: 0 }
    expect(def.toText(node, {})).toBe('||secret||')
  })

  it('spoiler render returns tut-spoiler params with text', async () => {
    await import('../directives/callout-directives.js')
    const def = getRegistry().get('spoiler')!
    const node = { kind: 'inline', label: 'answer here', attrs: {}, classes: [], line: 1, column: 0 }
    const out = def.render(node, {})
    expect(out.params?.text).toBe('answer here')
  })

  it('result has default open=false and type=result', async () => {
    await import('../directives/callout-directives.js')
    const def = getRegistry().get('result')!
    expect(def.kinds).toContain('container')
    const node = { kind: 'container', label: '', attrs: {}, classes: [], body: 'b', line: 1, column: 0 }
    const out = def.render(node, {})
    expect(out.params?.type).toBe('result')
  })

  // No-JS HTML structure: consecutive hints all independently openable
  it('hint directive kind is container (no JS needed — <details> works natively)', async () => {
    await import('../directives/callout-directives.js')
    const def = getRegistry().get('hint')!
    expect(def.kinds).toContain('container')
  })
})
