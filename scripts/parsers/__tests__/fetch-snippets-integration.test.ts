// Integration test: verifies that with SNIPPETS_ENABLED_REPOS empty,
// composeTutorial output is byte-identical on two runs (backward-compat).
import { describe, it, expect, beforeEach } from 'vitest'
import { resetRegistry } from '../directive-registry.js'
import { registerAllDirectives } from '../directives/register-all.js'
import { composeTutorial } from '../compose.js'

const FIXTURE_MD = `---
title: Test Tutorial
description: A test tutorial
time: 5
author_name: Test Author
author_profile: https://github.com/testauthor
tags: [test]
primary_tag: test
---

## Intro
Hello world.

### Step 1
Some content without any includes.
`

describe('backward-compat: no snippets when SNIPPETS_ENABLED_REPOS unset', () => {
  beforeEach(() => {
    delete process.env.SNIPPETS_ENABLED_REPOS
    resetRegistry()
    registerAllDirectives()
  })

  it('composeTutorial with empty snippetMap is byte-identical on two runs', () => {
    const opts = { repo: 'test-repo', branch: 'main', slug: 'test-slug', target: 'hugo' as const, rewriteImages: false, snippetMap: new Map<string, string>() }
    const run1 = composeTutorial(FIXTURE_MD, opts)
    const run2 = composeTutorial(FIXTURE_MD, opts)
    expect(run1.body).toBe(run2.body)
    expect(run1.title).toBe(run2.title)
  })

  it('composeTutorial with non-empty snippetMap inlines included snippet content', () => {
    const snippetMap = new Map([['test-repo/_snippets/setup.md', 'Run `npm install`']])
    const md = FIXTURE_MD.replace('Some content without any includes.', '::include[setup.md]\nDone.')
    const opts = { repo: 'test-repo', branch: 'main', slug: 'test-slug', target: 'hugo' as const, rewriteImages: false, snippetMap }
    const result = composeTutorial(md, opts)
    expect(result.body).toContain('npm install')
    expect(result.body).not.toContain('::include')
  })
})
