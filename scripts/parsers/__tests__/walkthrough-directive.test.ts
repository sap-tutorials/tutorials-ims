import { describe, it, expect, beforeEach } from 'vitest'
import { resetRegistry, type DirectiveDef } from '../directive-registry.js'
import { DirectiveParseError } from '../directives.js'

// Import the walkthrough def directly from the module
import { walkthroughDef } from '../directives/tut-walkthrough.js'

const CTX = { slug: 'test-tutorial' }

describe('walkthrough directive', () => {
  beforeEach(() => {
    resetRegistry()
  })

  it('has name "walkthrough"', () => {
    expect(walkthroughDef.name).toBe('walkthrough')
  })

  it('render: valid body returns { params: { code, notes } }', () => {
    const node = {
      name: 'walkthrough', kind: 'container', line: 1, attrs: {},
      body: '```js\nconst x = 1\nconst y = 2\n```\n\n1. {1} Declare x\n2. {2} Declare y\n'
    }
    const out = walkthroughDef.render(node, CTX) as any
    expect(out.params).toBeDefined()
    expect(out.params.code).toContain('```js')
    expect(out.params.notes).toContain('{1}')
  })

  it('render: out-of-range line reference throws DirectiveParseError with code invalid-attr', () => {
    const node = {
      name: 'walkthrough', kind: 'container', line: 1, attrs: {},
      body: '```js\nconst x = 1\n```\n\n1. {40} Out of range\n'
    }
    try {
      walkthroughDef.render(node, CTX)
      expect.fail('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(DirectiveParseError)
      expect((e as DirectiveParseError).code).toBe('invalid-attr')
    }
  })

  it('render: range end out of bounds throws DirectiveParseError', () => {
    const node = {
      name: 'walkthrough', kind: 'container', line: 1, attrs: {},
      body: '```js\nconst x = 1\nconst y = 2\n```\n\n1. {1-5} Too large\n'
    }
    try {
      walkthroughDef.render(node, CTX)
      expect.fail('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(DirectiveParseError)
      expect((e as DirectiveParseError).code).toBe('invalid-attr')
    }
  })

  it('toText: returns code fence then (lines N) prefixed notes', () => {
    const node = {
      name: 'walkthrough', kind: 'container', line: 1, attrs: {},
      body: '```js\nconst x = 1\n```\n\n1. {1} Declares x\n'
    }
    const text = walkthroughDef.toText(node, CTX)
    expect(text).toContain('const x = 1')
    expect(text).toContain('(lines 1)')
  })

  it('toText: range uses en-dash (lines N–M)', () => {
    const node = {
      name: 'walkthrough', kind: 'container', line: 1, attrs: {},
      body: '```js\nconst x = 1\nconst y = 2\n```\n\n1. {1-2} Both lines\n'
    }
    const text = walkthroughDef.toText(node, CTX)
    expect(text).toContain('(lines 1–2)')  // en-dash
  })
})
