// Regression tests for fenceHealth false-positive discrimination (#2772 follow-up).
//
// fenceHealth must distinguish a GENUINE swallowed step heading (a `### ` absorbed
// by a drifted/unterminated/CRLF-broken fence) from a LEGITIMATE `#`-prefixed
// line inside a well-formed fenced code block (shell/Python comment, `.http`
// `### ` request separator, `.properties` comment). The original detector counted
// any ATX-looking line in a code region, producing ~54 corpus false positives.

import { describe, it, expect } from 'vitest'
import { fenceHealth } from '../md-grammar.js'

describe('fenceHealth — false-positive discrimination', () => {
  it('does NOT flag `#` comments inside a well-formed fenced code block', () => {
    const md = ['```properties', '# resource bundle', '# key=value', '```', '', '### Real Step', 'body'].join('\n')
    expect(fenceHealth(md).swallowedHeadings).toBe(0)
  })

  it('does NOT flag `.http` `### ` request separators inside a closed fence', () => {
    const md = ['```http', 'GET /a', '### separator', 'POST /b', '```', '', '### Real Step', 'x'].join('\n')
    expect(fenceHealth(md).swallowedHeadings).toBe(0)
  })

  it('does NOT flag a `#` comment inside a closed fence with no info-string', () => {
    const md = ['```', '# just a comment', '```', '', '### Step', 'y'].join('\n')
    expect(fenceHealth(md).swallowedHeadings).toBe(0)
  })

  it('FLAGS a `### ` heading swallowed by an unterminated fence', () => {
    const md = ['   ```SQL', 'select 1', '### Swallowed Step', 'more'].join('\n')
    expect(fenceHealth(md).swallowedHeadings).toBe(1)
  })

  it('FLAGS `### ` headings swallowed by indent-drift (normalizeFenceIndent would fix)', () => {
    // opener at 3 spaces inside a list item, body at col 0 → drift that swallows the heading
    const md = ['1. Run:', '', '   ```SQL', 'SELECT 1;', '```', '', '### Swallowed', 'body', '```SQL', 'x', '```'].join('\n')
    expect(fenceHealth(md).swallowedHeadings).toBeGreaterThan(0)
  })

  it('FLAGS a `### ` heading swallowed via stray-CR (mixed line endings)', () => {
    const md = ['```SQL\r', 'code\r', '### Swallowed\r', 'more'].join('\n')
    expect(fenceHealth(md).swallowedHeadings).toBe(1)
  })

  it('is clean on well-formed source with normal headings', () => {
    const md = ['# Title', '## Intro', '### Step 1', 'body', '```js', 'const x = 1', '```'].join('\n')
    expect(fenceHealth(md).swallowedHeadings).toBe(0)
  })
})
