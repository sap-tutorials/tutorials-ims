// scripts/__tests__/intro.test.ts
import { describe, it, expect } from 'vitest'
import { extractIntro } from '../parsers/intro.js'

const V2 = `# Create a UI

<!-- description --> Do the thing.

## You will learn

- How to A
- How to B

## Prerequisites

- You did the previous tutorial

## Video Version

Video tutorial version:

<iframe width="560" height="315" src="https://www.youtube.com/embed/6WY70LyLS1c" allowfullscreen></iframe>

### Run the services

1. Do it.
`

describe('extractIntro (v2)', () => {
  it('keeps the Video Version section with its iframe', () => {
    const intro = extractIntro(V2, true)
    expect(intro).toContain('## Video Version')
    expect(intro).toContain('6WY70LyLS1c')
    expect(intro).toContain('<iframe')
  })
  it('removes title, description, You will learn, Prerequisites', () => {
    const intro = extractIntro(V2, true)
    expect(intro).not.toContain('# Create a UI')
    expect(intro).not.toContain('description')
    expect(intro).not.toContain('You will learn')
    expect(intro).not.toContain('Prerequisites')
    expect(intro).not.toContain('How to A')
  })
  it('stops at the first step and excludes step content', () => {
    expect(extractIntro(V2, true)).not.toContain('Run the services')
    expect(extractIntro(V2, true)).not.toContain('Do it.')
  })
  it('returns empty string when there is no pre-step content', () => {
    const noIntro = `# T\n\n## Prerequisites\n\n- x\n\n### Step one\n\n1. go\n`
    expect(extractIntro(noIntro, true)).toBe('')
  })
  it('does not treat a fenced ### as a step boundary', () => {
    const fenced = `# T\n\n## Notes\n\n\`\`\`md\n### not a step\n\`\`\`\n\nkeep me\n\n### Real step\n\n1. go\n`
    const intro = extractIntro(fenced, true)
    expect(intro).toContain('### not a step')
    expect(intro).toContain('keep me')
    expect(intro).not.toContain('Real step')
  })
})

describe('extractIntro (v1)', () => {
  it('captures content before the first ACCORDION step', () => {
    const v1 = `# T\n\n## Video Version\n\n<iframe src="https://youtu.be/abcdef12345"></iframe>\n\n[ACCORDION-BEGIN [Step 1: ](Do)]\nbody\n[ACCORDION-END]\n`
    const intro = extractIntro(v1, false)
    expect(intro).toContain('## Video Version')
    expect(intro).not.toContain('ACCORDION')
    expect(intro).not.toContain('body')
  })
})
