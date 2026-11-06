// Task 1: Types, frontmatter parse, and ExpandDirectivesContext extension tests
// Tests for testedWith/requires frontmatter parsing and ExpandDirectivesContext shape.
// Task 2: ::include directive expand hook tests

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { extractFrontmatter } from '../frontmatter.js'
import { expandDirectives } from '../directives.js'
import type { ExpandDirectivesContext } from '../directives.js'
import type { SnippetDeps } from '../types.js'
import { resetRegistry, registerDirective, getRegistry } from '../directive-registry.js'
import { INCLUDE_DEF } from '../directives/include.js'

// Alias for use in tests that need to inspect the registry after registerAllDirectives
const registryRef = getRegistry()

describe('testedWith frontmatter parsing', () => {
  it('parses testedWith map from frontmatter', () => {
    const { frontmatter } = extractFrontmatter(`---
testedWith:
  "@sap/cds": "9.x"
  node: "22"
---
# Test Tutorial
`)
    expect(frontmatter.testedWith).toEqual({ '@sap/cds': '9.x', node: '22' })
  })

  it('caps testedWith at 10 entries and drops extras', () => {
    // Build a frontmatter YAML with 12 entries
    const entries = Array.from({ length: 12 }, (_, i) => `  key${i}: "val${i}"`).join('\n')
    const md = `---\ntestedWith:\n${entries}\n---\n# Test\n`
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { frontmatter } = extractFrontmatter(md)
    warnSpy.mockRestore()
    expect(frontmatter.testedWith).toBeDefined()
    expect(Object.keys(frontmatter.testedWith!).length).toBeLessThanOrEqual(10)
  })

  it('drops entries with empty string values and warns', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { frontmatter } = extractFrontmatter(`---
testedWith:
  good: "1.0"
  empty: ""
---
# Test Tutorial
`)
    warnSpy.mockRestore()
    expect(frontmatter.testedWith).toBeDefined()
    expect(frontmatter.testedWith!['good']).toBe('1.0')
    expect(frontmatter.testedWith!['empty']).toBeUndefined()
  })

  it('returns undefined testedWith when field is absent', () => {
    const { frontmatter } = extractFrontmatter(`---
time: 5
author_name: Test
author_profile: https://github.com/test
tags: []
primary_tag: test
---
# Test Tutorial
`)
    expect(frontmatter.testedWith).toBeUndefined()
  })

  it('returns undefined testedWith when field is not an object', () => {
    const { frontmatter } = extractFrontmatter(`---
testedWith: "not-an-object"
---
# Test Tutorial
`)
    expect(frontmatter.testedWith).toBeUndefined()
  })
})

describe('requires frontmatter parsing', () => {
  it('parses requires array', () => {
    const { frontmatter } = extractFrontmatter(`---
requires:
  - hana-cloud-tutorial-1
---
# Test Tutorial
`)
    expect(frontmatter.requires).toEqual(['hana-cloud-tutorial-1'])
  })

  it('parses multiple requires slugs', () => {
    const { frontmatter } = extractFrontmatter(`---
requires:
  - hana-cloud-tutorial-1
  - hana-cloud-tutorial-2
---
# Test Tutorial
`)
    expect(frontmatter.requires).toEqual(['hana-cloud-tutorial-1', 'hana-cloud-tutorial-2'])
  })

  it('filters out empty string entries from requires', () => {
    const { frontmatter } = extractFrontmatter(`---
requires:
  - hana-cloud-tutorial-1
  - ""
  - hana-cloud-tutorial-2
---
# Test Tutorial
`)
    expect(frontmatter.requires).toEqual(['hana-cloud-tutorial-1', 'hana-cloud-tutorial-2'])
  })

  it('returns undefined requires when field is absent', () => {
    const { frontmatter } = extractFrontmatter(`---
time: 5
---
# Test Tutorial
`)
    expect(frontmatter.requires).toBeUndefined()
  })

  it('returns undefined requires when array is empty after filtering', () => {
    const { frontmatter } = extractFrontmatter(`---
requires:
  - ""
  - "   "
---
# Test Tutorial
`)
    expect(frontmatter.requires).toBeUndefined()
  })
})

describe('ExpandDirectivesContext extended shape', () => {
  it('accepts catalogBySlug map', () => {
    const ctx: ExpandDirectivesContext = {
      slug: 'test-tutorial',
      catalogBySlug: new Map([
        ['other-tutorial', { title: 'Other Tutorial', time: 15, level: 'beginner' }],
      ]),
    }
    expect(ctx.catalogBySlug?.get('other-tutorial')?.title).toBe('Other Tutorial')
    expect(ctx.catalogBySlug?.get('other-tutorial')?.time).toBe(15)
    expect(ctx.catalogBySlug?.get('other-tutorial')?.level).toBe('beginner')
  })

  it('accepts catalogBySlug entry without level (level is optional)', () => {
    const ctx: ExpandDirectivesContext = {
      slug: 'test-tutorial',
      catalogBySlug: new Map([
        ['other-tutorial', { title: 'Other Tutorial', time: 10 }],
      ]),
    }
    const entry = ctx.catalogBySlug?.get('other-tutorial')
    expect(entry?.title).toBe('Other Tutorial')
    expect(entry?.level).toBeUndefined()
  })

  it('accepts snippetMap for include directive', () => {
    const ctx: ExpandDirectivesContext = {
      slug: 'test-tutorial',
      snippetMap: new Map([
        ['common/prereqs.md', '## Prerequisites\n- Have an account'],
      ]),
    }
    expect(ctx.snippetMap?.get('common/prereqs.md')).toContain('Prerequisites')
  })

  it('accepts includeChain for cycle detection', () => {
    const ctx: ExpandDirectivesContext = {
      slug: 'test-tutorial',
      includeChain: ['common/prereqs.md', 'common/shared-setup.md'],
    }
    expect(ctx.includeChain).toHaveLength(2)
    expect(ctx.includeChain![0]).toBe('common/prereqs.md')
  })

  it('accepts helpTitleCache for help directive', () => {
    const ctx: ExpandDirectivesContext = {
      slug: 'test-tutorial',
      helpTitleCache: new Map([
        ['hana-cloud', 'SAP HANA Cloud'],
      ]),
    }
    expect(ctx.helpTitleCache?.get('hana-cloud')).toBe('SAP HANA Cloud')
  })

  it('all new fields are optional (base context still valid)', () => {
    const ctx: ExpandDirectivesContext = { slug: 'test-tutorial' }
    expect(ctx.catalogBySlug).toBeUndefined()
    expect(ctx.snippetMap).toBeUndefined()
    expect(ctx.includeChain).toBeUndefined()
    expect(ctx.helpTitleCache).toBeUndefined()
  })
})

describe('SnippetDeps type', () => {
  it('is a Record<string, string[]>', () => {
    const deps: SnippetDeps = {
      'common/prereqs.md': ['hana-cloud-tutorial-1', 'hana-cloud-tutorial-2'],
      'common/setup.md': ['hana-cloud-tutorial-3'],
    }
    expect(deps['common/prereqs.md']).toHaveLength(2)
    expect(deps['common/setup.md']).toContain('hana-cloud-tutorial-3')
  })

  it('accepts empty deps map', () => {
    const deps: SnippetDeps = {}
    expect(Object.keys(deps)).toHaveLength(0)
  })
})

// ─── Task 2: ::include expand hook ───────────────────────────────────────────

describe('::include expand hook', () => {
  beforeEach(() => {
    resetRegistry()
    registerDirective(INCLUDE_DEF)
  })

  it('inlines snippet content (basic)', () => {
    const snippetMap = new Map([['myrepo/_snippets/step.md', 'hello **world**']])
    const ctx: ExpandDirectivesContext = {
      slug: 'test-tutorial',
      snippetMap,
    }
    const result = expandDirectives('Before\n::include[step.md]\nAfter', ctx)
    expect(result).toContain('hello **world**')
    expect(result).not.toContain('::include')
  })

  it('substitutes {{param:region}}', () => {
    const snippetMap = new Map([['r/_snippets/s.md', 'Region: {{param:region}}']])
    const ctx: ExpandDirectivesContext = {
      slug: 'test-tutorial',
      snippetMap,
    }
    const result = expandDirectives('::include[s.md]{region=eu10}', ctx)
    expect(result).toContain('Region: eu10')
  })

  it('rejects snippet with step heading (### Step 1)', () => {
    const snippetMap = new Map([['r/_snippets/s.md', '### Step 1\nfoo']])
    const ctx: ExpandDirectivesContext = {
      slug: 'test-tutorial',
      snippetMap,
    }
    expect(() => expandDirectives('::include[s.md]', ctx)).toThrow('directive/include-step-heading')
  })

  it('rejects missing snippet (snippetMap empty)', () => {
    const snippetMap = new Map<string, string>()
    const ctx: ExpandDirectivesContext = {
      slug: 'test-tutorial',
      snippetMap,
    }
    expect(() => expandDirectives('::include[missing]', ctx)).toThrow('directive/include-not-found')
  })

  it('rejects direct cycle: snippet includes itself', () => {
    // Snippet A contains ::include[A] — direct self-reference
    const snippetKey = 'myrepo/_snippets/self.md'
    const snippetMap = new Map([
      [snippetKey, '::include[self.md]'],
    ])
    const ctx: ExpandDirectivesContext = {
      slug: 'test-tutorial',
      snippetMap,
    }
    expect(() => expandDirectives('::include[self.md]', ctx)).toThrow('directive/include-cycle')
  })

  it('rejects indirect cycle: A includes B includes A', () => {
    const snippetMap = new Map([
      ['myrepo/_snippets/A.md', '::include[B.md]'],
      ['myrepo/_snippets/B.md', '::include[A.md]'],
    ])
    const ctx: ExpandDirectivesContext = {
      slug: 'test-tutorial',
      snippetMap,
    }
    expect(() => expandDirectives('::include[A.md]', ctx)).toThrow('directive/include-cycle')
  })

  it('respects max depth 3: A→B→C→D fails', () => {
    // 4-level chain exceeds MAX_INCLUDE_DEPTH=3
    const snippetMap = new Map([
      ['r/_snippets/A.md', '::include[B.md]'],
      ['r/_snippets/B.md', '::include[C.md]'],
      ['r/_snippets/C.md', '::include[D.md]'],
      ['r/_snippets/D.md', 'leaf content'],
    ])
    const ctx: ExpandDirectivesContext = {
      slug: 'test-tutorial',
      snippetMap,
    }
    // A→B→C→D requires depth 4 which exceeds MAX_INCLUDE_DEPTH=3
    expect(() => expandDirectives('::include[A.md]', ctx)).toThrow()
  })

  it('allows depth 3: A→B→C leaf succeeds', () => {
    // 3-level chain is exactly MAX_INCLUDE_DEPTH; should succeed
    const snippetMap = new Map([
      ['r/_snippets/A.md', '::include[B.md]'],
      ['r/_snippets/B.md', '::include[C.md]'],
      ['r/_snippets/C.md', 'leaf content'],
    ])
    const ctx: ExpandDirectivesContext = {
      slug: 'test-tutorial',
      snippetMap,
    }
    const result = expandDirectives('::include[A.md]', ctx)
    expect(result).toContain('leaf content')
  })

  it('resolves shared: prefix from shared/ namespace', () => {
    const snippetMap = new Map([['shared/install-cf-cli', 'Install: cf CLI']])
    const ctx: ExpandDirectivesContext = {
      slug: 'test-tutorial',
      snippetMap,
    }
    const result = expandDirectives('::include[shared:install-cf-cli]', ctx)
    expect(result).toContain('Install: cf CLI')
  })
})

// ─── Task 6: ::include integration via registerAllDirectives ─────────────────

import { registerAllDirectives } from '../directives/register-all.js'

describe('::include integration via registerAllDirectives', () => {
  beforeEach(() => {
    resetRegistry()
    registerAllDirectives()
  })

  it('inlines snippet content when snippetMap key is exact match', () => {
    const snippetMap = new Map([['setup', 'Run: npm install']])
    const ctx: ExpandDirectivesContext = {
      slug: 'test',
      snippetMap,
    }
    const result = expandDirectives('::include[setup]', ctx)
    expect(result).toContain('Run: npm install')
    expect(result).not.toContain('::include')
  })

  it('inlines snippet via suffix match (repo/_snippets/name)', () => {
    const snippetMap = new Map([['myrepo/_snippets/setup', 'Run: npm install']])
    const ctx: ExpandDirectivesContext = {
      slug: 'test',
      snippetMap,
    }
    const result = expandDirectives('::include[setup]', ctx)
    expect(result).toContain('Run: npm install')
  })

  it('all directive names are registered', () => {
    // After registerAllDirectives, all content-reuse directives should be in the registry
    const reg = getRegistry()
    expect(reg.has('include')).toBe(true)
    expect(reg.has('tutorial-ref')).toBe(true)
    expect(reg.has('note-ref')).toBe(true)
    expect(reg.has('help-ref')).toBe(true)
    expect(reg.has('api-ref')).toBe(true)
    expect(reg.has('since')).toBe(true)
    expect(reg.has('requires')).toBe(true)
  })

  it('registerAllDirectives is idempotent (no throw on double call)', () => {
    // First call happened in beforeEach. A second call must not throw.
    expect(() => registerAllDirectives()).not.toThrow()
  })
})
