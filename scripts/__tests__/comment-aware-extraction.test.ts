// scripts/__tests__/comment-aware-extraction.test.ts
//
// Regression for the codejam-events-process-1-bah rendering break: an author
// disabled the Prerequisites section by wrapping it in an HTML comment
// (`<!-- ## Prerequisites ... -->`). Because extractSection/extractIntro were
// not comment-aware, the commented `## Prerequisites` was lifted out as a real
// section (dragging its closing `-->` into the field) and the opening `<!--`
// was stranded in the intro — an unterminated comment that swallowed every
// step when Hugo rendered the page. See PR for full write-up.
import { describe, it, expect } from 'vitest'
import { extractFrontmatter } from '../parsers/frontmatter.js'
import { extractIntro } from '../parsers/intro.js'

const COMMENTED_PREREQ = `---
parser: v2
---

# 1 - Exploring Events

<!-- description --> Get familiar with events.

<!--
## Prerequisites
- You have completed the previous tutorial, [Prereqs](codejam-events-process-0-prerequisites).
-->

## You will learn
- The basics
- The types

## Intro
In the SAP Business Accelerator Hub, you can discover content.

### Tour events section
Explore the Events section.

### What is CloudEvents?
CloudEvents is a spec.
`

const balance = (s: string) =>
  (s.match(/<!--/g) || []).length - (s.match(/-->/g) || []).length

describe('comment-aware extraction (commented-out Prerequisites)', () => {
  it('does NOT extract a Prerequisites section that lives inside an HTML comment', () => {
    const { prerequisites } = extractFrontmatter(COMMENTED_PREREQ)
    expect(prerequisites).toBe('')
    // and never leaks the closing comment marker into the field
    expect(prerequisites).not.toContain('-->')
  })

  it('still extracts You will learn (a real, non-commented section)', () => {
    const { youWillLearn } = extractFrontmatter(COMMENTED_PREREQ)
    expect(youWillLearn).toEqual(['The basics', 'The types'])
  })

  it('does not strand an unterminated <!-- in the intro', () => {
    const { body } = extractFrontmatter(COMMENTED_PREREQ)
    const intro = extractIntro(body, true)
    expect(intro.trimStart().startsWith('<!--')).toBe(false)
    // whatever comment markers survive must be balanced (renders invisibly),
    // never a stray opener/closer that swallows following DOM.
    expect(balance(intro)).toBe(0)
    expect(intro).toContain('## Intro')
    expect(intro).toContain('you can discover content')
  })
})

describe('comment-aware extraction (guards: do not over-strip)', () => {
  it('preserves an inline image-directive comment before an image', () => {
    // images.ts relies on `<!-- border -->` / `<!-- size:... -->` prefixes.
    const md = `---
parser: v2
---

# T

<!-- description --> D.

## You will learn
- x

## Intro
Intro.

### Step
<!-- border --> ![alt](img.png)

Some text.
`
    const { body } = extractFrontmatter(md)
    const intro = extractIntro(body, true)
    // The image directive is inside a step, not the intro — but the body must
    // still carry it verbatim for images.ts downstream.
    expect(body).toContain('<!-- border --> ![alt](img.png)')
    expect(intro).not.toContain('<!-- border')
  })

  it('still resolves the description from its inline marker', () => {
    const { description } = extractFrontmatter(COMMENTED_PREREQ)
    expect(description).toBe('Get familiar with events.')
  })
})
