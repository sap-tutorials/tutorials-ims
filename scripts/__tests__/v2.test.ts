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

describe('parseV2Steps — tutorial-step-pacing heading attributes', () => {
  it('strips {time=…}/{optional} and sets timeSeconds/optional on the step', () => {
    const body = `### Deploy the app {time=5m optional}\n\nContent here.\n\n### Second step\n\nMore.\n`
    const steps = parseV2Steps(body)
    expect(steps).toHaveLength(2)
    expect(steps[0].title).toBe('Deploy the app')
    expect(steps[0].timeSeconds).toBe(300)
    expect(steps[0].optional).toBe(true)
    expect(steps[1].title).toBe('Second step')
    expect(steps[1].timeSeconds).toBeUndefined()
    expect(steps[1].optional).toBeUndefined()
  })

  it('produces the same title for a step with or without the attribute block (slug stability)', () => {
    const plain = parseV2Steps('### Deploy the app\n\nbody\n')
    const withAttrs = parseV2Steps('### Deploy the app {time=5m}\n\nbody\n')
    expect(withAttrs[0].title).toBe(plain[0].title)
  })

  it('collects step-attr/unknown warnings via the warningsOut out-param', () => {
    const warnings: string[] = []
    parseV2Steps('### Return {status: ok}\n\nbody\n', warnings)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/step-attr\/unknown/)
  })

  it('throws naming the step on an invalid duration', () => {
    expect(() => parseV2Steps('### Deploy the app {time=5x}\n\nbody\n')).toThrow(/Deploy the app/)
  })
})
