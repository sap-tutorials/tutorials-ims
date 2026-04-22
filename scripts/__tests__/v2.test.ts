import { describe, it, expect } from 'vitest'
import { parseV2Steps } from '../parsers/v2.js'

const BODY = `
# Title Here

<!-- description --> Some description.

## You will learn

- item 1
- item 2

## Prerequisites

Some prereqs.

### Step One Title

Step one content with **bold**.

Some more content.

### Step Two Title

Step two content.

\`\`\`js
console.log('hello')
\`\`\`

### Step Three Title

Step three.
`

describe('parseV2Steps', () => {
  it('splits content into steps at H3 boundaries', () => {
    const steps = parseV2Steps(BODY)
    expect(steps).toHaveLength(3)
  })

  it('extracts step titles', () => {
    const steps = parseV2Steps(BODY)
    expect(steps[0].title).toBe('Step One Title')
    expect(steps[1].title).toBe('Step Two Title')
    expect(steps[2].title).toBe('Step Three Title')
  })

  it('numbers steps sequentially from 1', () => {
    const steps = parseV2Steps(BODY)
    expect(steps[0].number).toBe(1)
    expect(steps[2].number).toBe(3)
  })

  it('preserves code blocks in step content', () => {
    const steps = parseV2Steps(BODY)
    expect(steps[1].content).toContain("console.log('hello')")
  })

  it('does not include preamble (H1, H2 sections) in steps', () => {
    const steps = parseV2Steps(BODY)
    expect(steps[0].content).not.toContain('You will learn')
    expect(steps[0].content).not.toContain('Prerequisites')
  })
})
