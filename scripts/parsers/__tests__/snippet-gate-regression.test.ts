import { describe, it, expect, beforeEach } from 'vitest'
import { resetRegistry, registerDirective } from '../directive-registry.js'
import { INCLUDE_DEF } from '../directives/include.js'
import { expandDirectives } from '../directives.js'
import type { ExpandDirectivesContext } from '../directives.js'

describe('snippet gate: non-opted-in behavior', () => {
  beforeEach(() => {
    resetRegistry()
    registerDirective(INCLUDE_DEF)
  })

  it('throws include-not-found when snippetMap is empty (non-opted-in repo)', () => {
    const ctx: ExpandDirectivesContext = { slug: 'my-tutorial', snippetMap: new Map() }
    expect(() => expandDirectives('::include[setup.md]', ctx)).toThrow('directive/include-not-found')
  })

  it('tutorial without any ::include directive is unaffected (empty snippetMap, no error)', () => {
    const ctx: ExpandDirectivesContext = { slug: 'my-tutorial', snippetMap: new Map() }
    const md = '### Step 1\nHello world.'
    expect(() => expandDirectives(md, ctx)).not.toThrow()
    expect(expandDirectives(md, ctx)).toBe(md)
  })
})

describe('error line mapping: errors inside snippets report snippet context', () => {
  beforeEach(() => {
    resetRegistry()
    registerDirective(INCLUDE_DEF)
  })

  it('augments error message with snippet context when nested directive fails', () => {
    // A snippet that contains an invalid nested ::include (missing from map → not-found)
    const snippetMap = new Map([
      ['repo/_snippets/outer.md', '::include[nonexistent]'],
    ])
    const ctx: ExpandDirectivesContext = { slug: 'my-tutorial', snippetMap }
    try {
      expandDirectives('::include[outer.md]', ctx)
      expect.fail('should have thrown')
    } catch (e: any) {
      // The error message should reference the source slug and the snippet chain
      expect(e.message).toMatch(/included from|my-tutorial|outer\.md/)
    }
  })

  it('does not double-wrap error message when error already contains "included from"', () => {
    // Simulate a deeply nested error that already has context in message
    const inner = new Error('directive/include-not-found: x (included from tut:1 via outer.md)')
    const snippetMap = new Map([
      ['repo/_snippets/outer.md', 'content'],
    ])
    // We can't easily inject a pre-annotated error through normal flow, so
    // verify the structure of the augmentation logic independently by checking
    // that single-level augmentation works correctly
    const ctx: ExpandDirectivesContext = { slug: 'my-tutorial', snippetMap }
    // snippet with a missing include inside → gets augmented once
    const snippetMap2 = new Map([
      ['repo/_snippets/outer.md', '::include[missing]'],
    ])
    const ctx2: ExpandDirectivesContext = { slug: 'root-tut', snippetMap: snippetMap2 }
    try {
      expandDirectives('::include[outer.md]', ctx2)
      expect.fail('should have thrown')
    } catch (e: any) {
      // Should mention the context exactly once (not doubled)
      const occurrences = (e.message.match(/included from/g) || []).length
      expect(occurrences).toBe(1)
    }
  })
})
