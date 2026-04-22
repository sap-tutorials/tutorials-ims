import { describe, it, expect } from 'vitest'
import { parseV1Steps } from '../parsers/v1.js'

const BODY = `
# Title

Some preamble.

[ACCORDION-BEGIN [Step 1: ](First Step Title)]

First step content here.

[ACCORDION-END]

[ACCORDION-BEGIN [Step 2: ](Second Step Title)]

Second step content.

\`\`\`bash
echo "hello"
\`\`\`

[ACCORDION-END]
`

describe('parseV1Steps', () => {
  it('splits ACCORDION blocks into steps', () => {
    const steps = parseV1Steps(BODY)
    expect(steps).toHaveLength(2)
  })

  it('extracts step titles', () => {
    const steps = parseV1Steps(BODY)
    expect(steps[0].title).toBe('First Step Title')
    expect(steps[1].title).toBe('Second Step Title')
  })

  it('numbers steps from BEGIN markers', () => {
    const steps = parseV1Steps(BODY)
    expect(steps[0].number).toBe(1)
    expect(steps[1].number).toBe(2)
  })

  it('preserves content between BEGIN and END', () => {
    const steps = parseV1Steps(BODY)
    expect(steps[0].content).toContain('First step content here.')
    expect(steps[1].content).toContain('echo "hello"')
  })
})
