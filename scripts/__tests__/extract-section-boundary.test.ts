// scripts/__tests__/extract-section-boundary.test.ts
//
// Regression for #2555 (task 2): extractSection / extractBulletList bounded a
// section only at the next `## `/`### ` heading, so a Prerequisites (or
// You-will-learn) block over-captured everything down to EOF when the content
// that followed was an `#### ` sub-heading, a `# H1`, or a bare `---`-separated
// intro paragraph with no h2/h3 after it. The boundary now stops at any ATX
// heading (`#`..`######`) or a thematic break. The change can only SHRINK an
// over-capturing section — sections correctly bounded by `## Steps` are
// unaffected (control case below).
import { describe, it, expect } from 'vitest'
import { extractFrontmatter } from '../parsers/frontmatter.js'

const withBody = (body: string) => `---\nparser: v2\n---\n\n# T\n\n${body}\n`

describe('extractSection boundary (#2555 task 2)', () => {
  it('stops at an #### sub-heading, not EOF', () => {
    const { prerequisites } = extractFrontmatter(
      withBody(
        `## Prerequisites\n- You have a trial account.\n\n#### Extra notes\nThis is not a prerequisite.`
      )
    )
    expect(prerequisites).toBe('- You have a trial account.')
    expect(prerequisites).not.toContain('Extra notes')
    expect(prerequisites).not.toContain('not a prerequisite')
  })

  it('stops at a bare `---` thematic break', () => {
    const { prerequisites } = extractFrontmatter(
      withBody(
        `## Prerequisites\n- You have Node.js installed.\n\n---\n\nIntro prose that follows the rule.`
      )
    )
    expect(prerequisites).toBe('- You have Node.js installed.')
    expect(prerequisites).not.toContain('Intro prose')
  })

  it('stops at a `# H1` heading', () => {
    const { prerequisites } = extractFrontmatter(
      withBody(`## Prerequisites\n- A BTP account.\n\n# Another Title\nBody.`)
    )
    expect(prerequisites).toBe('- A BTP account.')
    expect(prerequisites).not.toContain('Another Title')
  })

  it('control: a normal prereq bounded by `## Steps` still captures fully', () => {
    const { prerequisites } = extractFrontmatter(
      withBody(
        `## Prerequisites\n- You have a trial account.\n- You have Node.js installed.\n\n## Steps\n\n### Step 1\nDo the thing.`
      )
    )
    expect(prerequisites).toBe(
      '- You have a trial account.\n- You have Node.js installed.'
    )
  })

  it('extractBulletList (You will learn) honours the same tighter boundary', () => {
    const { youWillLearn } = extractFrontmatter(
      withBody(`## You will learn\n- The basics\n- The types\n\n#### Aside\n- not a learning item`)
    )
    expect(youWillLearn).toEqual(['The basics', 'The types'])
  })
})
