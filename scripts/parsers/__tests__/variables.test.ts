// Tests for tutorial variables: frontmatter schema, validation, and token wrapping.
//
// Authors declare `variables:` in source frontmatter and reference them in body
// with `{{var:NAME}}` tokens. This module validates the declared schema and
// wraps tokens for prose/inline code (span) vs. fenced code (letters-only sentinel).

import { describe, it, expect } from 'vitest'
import {
  validateVariables,
  wrapTokens,
  VariablesValidationError,
  SENTINEL_RE,
  sentinelFor,
} from '../variables.js'
import type { TutorialVariable } from '../variables.js'
import { composeTutorial } from '../compose.js'

// ---------------------------------------------------------------------------
// Shared frontmatter for composeTutorial integration tests
// ---------------------------------------------------------------------------
const frontmatter = [
  '---',
  'parser: v2',
  'title: Test Tutorial',
  'time: 5',
  'tags: [tutorial>beginner]',
  'primary_tag: tutorial>beginner',
  'author_name: Tester',
  'author_profile: https://example.com',
  'variables:',
  '  - name: groupNumber',
  '    label: Your BTP Trial Group Number',
  '    type: string',
  '    maxLength: 6',
  '    placeholder: XXX',
  '  - name: seatNo',
  '    label: Seat Number',
  '    type: number',
  '---',
  '',
].join('\n')

// ---------------------------------------------------------------------------
// validateVariables
// ---------------------------------------------------------------------------
describe('validateVariables', () => {
  it('returns parsed array for a valid variable block', () => {
    const vars = [
      { name: 'groupNumber', label: 'Group Number', type: 'string', placeholder: 'XXX' },
      { name: 'seatNo', label: 'Seat No', type: 'number' },
    ]
    const body = 'Use group {{var:groupNumber}} and seat {{var:seatNo}}.'
    const result = validateVariables(vars, body)
    expect(result).toHaveLength(2)
    expect(result[0].name).toBe('groupNumber')
    expect(result[1].name).toBe('seatNo')
  })

  it('throws VariablesValidationError naming the duplicate on duplicate name', () => {
    const vars = [
      { name: 'groupNumber', label: 'First', type: 'string' },
      { name: 'groupNumber', label: 'Duplicate', type: 'string' },
    ]
    expect(() => validateVariables(vars, '')).toThrow(VariablesValidationError)
    expect(() => validateVariables(vars, '')).toThrow(/groupNumber/)
  })

  it('throws VariablesValidationError when body token {{var:seatNo}} has no matching declaration', () => {
    const vars = [
      { name: 'groupNumber', label: 'Group Number', type: 'string' },
    ]
    const body = 'Go to group {{var:groupNumber}} and seat {{var:seatNo}}.'
    expect(() => validateVariables(vars, body)).toThrow(VariablesValidationError)
    expect(() => validateVariables(vars, body)).toThrow(/seatNo/)
  })

  it('throws VariablesValidationError on an unparseable default.pattern (bad regex)', () => {
    const vars = [
      { name: 'groupNumber', label: 'Group', type: 'string', default: { from: 'email', pattern: '(' } },
    ]
    expect(() => validateVariables(vars, '')).toThrow(VariablesValidationError)
    expect(() => validateVariables(vars, '')).toThrow(/groupNumber/)
  })

  it('throws VariablesValidationError when default.from is off the allowlist', () => {
    const vars = [
      { name: 'groupNumber', label: 'Group', type: 'string', default: { from: 'username', pattern: '.*' } },
    ]
    expect(() => validateVariables(vars, '')).toThrow(VariablesValidationError)
    expect(() => validateVariables(vars, '')).toThrow(/groupNumber/)
  })

  it('does NOT throw on a declared-but-unused variable (soft warning, not error)', () => {
    const vars = [
      { name: 'groupNumber', label: 'Group Number', type: 'string' },
      { name: 'unusedVar', label: 'Unused', type: 'string' },
    ]
    const body = 'Use group {{var:groupNumber}} only.'
    expect(() => validateVariables(vars, body)).not.toThrow()
  })

  it('throws VariablesValidationError on invalid type (not string|number)', () => {
    const vars = [
      { name: 'myVar', label: 'My Var', type: 'boolean' },
    ]
    expect(() => validateVariables(vars, '')).toThrow(VariablesValidationError)
    expect(() => validateVariables(vars, '')).toThrow(/myVar/)
  })

  it('accepts all valid default.from values from the allowlist', () => {
    const allowlist = ['email', 'id', 'givenName', 'familyName'] as const
    for (const from of allowlist) {
      const vars = [
        { name: 'v', label: 'V', type: 'string', default: { from, pattern: '.*' } },
      ]
      expect(() => validateVariables(vars, '')).not.toThrow()
    }
  })

  it('throws when vars is not an array', () => {
    expect(() => validateVariables('not-an-array', '')).toThrow(VariablesValidationError)
  })

  it('throws when a variable entry is missing required name', () => {
    const vars = [
      { label: 'No name', type: 'string' },
    ]
    expect(() => validateVariables(vars, '')).toThrow(VariablesValidationError)
  })

  it('throws when NAME does not match [A-Za-z][A-Za-z0-9_]*', () => {
    const vars = [
      { name: '1invalid', label: 'Bad name', type: 'string' },
    ]
    expect(() => validateVariables(vars, '')).toThrow(VariablesValidationError)
  })

  // --- [#2852] author-fixed value + display flag -------------------------------

  it('accepts a variable with a literal value', () => {
    const vars = [
      { name: 'prod', label: 'Product', type: 'string', value: 'MyApp 2.0' },
    ]
    const result = validateVariables(vars, 'Use {{var:prod}} everywhere.')
    expect(result[0].value).toBe('MyApp 2.0')
  })

  it('accepts display:false and does not require a label', () => {
    const vars = [
      { name: 'prod', type: 'string', value: 'MyApp 2.0', display: false },
    ]
    const result = validateVariables(vars, 'Use {{var:prod}} everywhere.')
    expect(result[0].display).toBe(false)
    expect(result[0].value).toBe('MyApp 2.0')
  })

  it('throws when display is not a boolean', () => {
    const vars = [
      { name: 'prod', label: 'Product', type: 'string', display: 'false' },
    ]
    expect(() => validateVariables(vars, '')).toThrow(VariablesValidationError)
    expect(() => validateVariables(vars, '')).toThrow(/display/)
  })

  it('throws when value is not a string', () => {
    const vars = [
      { name: 'prod', label: 'Product', type: 'string', value: 123 },
    ]
    expect(() => validateVariables(vars, '')).toThrow(VariablesValidationError)
    expect(() => validateVariables(vars, '')).toThrow(/value/)
  })

  it('throws when label missing on a displayed variable', () => {
    const vars = [
      { name: 'prod', type: 'string' },
    ]
    expect(() => validateVariables(vars, '')).toThrow(VariablesValidationError)
    expect(() => validateVariables(vars, '')).toThrow(/label/)
  })

  it('leaves display undefined (shown) when the field is absent', () => {
    const vars = [
      { name: 'g', label: 'G', type: 'string' },
    ]
    const result = validateVariables(vars, 'Use {{var:g}}.')
    expect(result[0].display).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// wrapTokens
// ---------------------------------------------------------------------------
describe('wrapTokens', () => {
  const vars: TutorialVariable[] = [
    { name: 'groupNumber', label: 'Group Number', type: 'string', placeholder: 'XXX' },
    { name: 'seatNo', label: 'Seat Number', type: 'number' },
  ]

  it('wraps a prose occurrence as a tut-var span with placeholder', () => {
    const md = 'Go to group {{var:groupNumber}} now.'
    const result = wrapTokens(md, vars)
    expect(result).toContain('<span class="tut-var" data-tut-var="groupNumber">XXX</span>')
    expect(result).not.toContain('{{var:groupNumber}}')
  })

  it('wraps an inline-code occurrence as a SENTINEL (not a span)', () => {
    // Inline code (single backtick): Goldmark HTML-escapes <code> content, so
    // a raw <span> would render as escaped literal text and never become a real
    // DOM element. Tokens inside backtick runs must become sentinels so that
    // the client-side expandSentinels() helper can convert them after render.
    const md = 'Run `da164-{{var:groupNumber}}@x` to connect.'
    const result = wrapTokens(md, vars)
    expect(result).toContain('TUTVARxgroupNumberx')
    expect(result).not.toContain('{{var:groupNumber}}')
    // Must NOT produce a raw span inside backticks
    expect(result).not.toContain('<span class="tut-var"')
    // The backtick delimiters and surrounding prose must be preserved
    expect(result).toContain('`da164-TUTVARxgroupNumberx@x`')
  })

  it('wraps a prose occurrence (not in backticks) as a span even when the line has backtick content elsewhere', () => {
    // The backtick span covers only the backtick-delimited portion; prose outside it gets a real span.
    const md = 'Use `code` and then {{var:groupNumber}} here.'
    const result = wrapTokens(md, vars)
    expect(result).toContain('<span class="tut-var" data-tut-var="groupNumber">XXX</span>')
    expect(result).not.toContain('TUTVARx')
  })

  it('replaces a fenced-block occurrence with the sentinel (not a span)', () => {
    const md = [
      'Prose before fence.',
      '```bash',
      'cf login -u {{var:groupNumber}}',
      '```',
      'Prose after fence.',
    ].join('\n')
    const result = wrapTokens(md, vars)
    // Inside fence: sentinel, NOT a span
    expect(result).toContain('TUTVARxgroupNumberx')
    expect(result).not.toContain('{{var:groupNumber}}')
    // Prose lines are unchanged structure (no sentinel there)
    expect(result).toContain('Prose before fence.')
    expect(result).toContain('Prose after fence.')
  })

  it('handles a variable with no placeholder (empty placeholder in span)', () => {
    const md = 'Seat {{var:seatNo}} assigned.'
    const result = wrapTokens(md, vars)
    // seatNo has no placeholder — empty string in span
    expect(result).toContain('<span class="tut-var" data-tut-var="seatNo"></span>')
  })

  it('HTML-escapes placeholder characters in the span', () => {
    const varsWithHtml: TutorialVariable[] = [
      { name: 'region', label: 'Region', type: 'string', placeholder: '<us-east-1>' },
    ]
    const md = 'Region: {{var:region}}'
    const result = wrapTokens(md, varsWithHtml)
    expect(result).toContain('data-tut-var="region"')
    expect(result).toContain('&lt;us-east-1&gt;')
    expect(result).not.toContain('<us-east-1>')
  })

  it('returns markdown unchanged when vars is empty', () => {
    const md = 'No variables here.'
    expect(wrapTokens(md, [])).toBe(md)
  })

  it('sentinel does NOT appear in prose (sentinel is fenced-only)', () => {
    const md = 'Prose: {{var:groupNumber}}'
    const result = wrapTokens(md, vars)
    expect(result).not.toContain('TUTVARx')
  })
})

// ---------------------------------------------------------------------------
// SENTINEL_RE and sentinelFor helpers
// ---------------------------------------------------------------------------
describe('SENTINEL_RE and sentinelFor', () => {
  it('sentinelFor returns the correct sentinel string', () => {
    expect(sentinelFor('groupNumber')).toBe('TUTVARxgroupNumberx')
    expect(sentinelFor('seat_No')).toBe('TUTVARxseat_Nox')
  })

  it('SENTINEL_RE matches and extracts NAME from sentinel', () => {
    const sentinel = 'TUTVARxgroupNumberx'
    SENTINEL_RE.lastIndex = 0
    const m = SENTINEL_RE.exec(sentinel)
    expect(m).not.toBeNull()
    expect(m![1]).toBe('groupNumber')
  })

  it('SENTINEL_RE does not match a plain {{var:NAME}} token', () => {
    const token = '{{var:groupNumber}}'
    SENTINEL_RE.lastIndex = 0
    expect(SENTINEL_RE.exec(token)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// composeTutorial integration — variables wired end-to-end
// ---------------------------------------------------------------------------
describe('composeTutorial with variables', () => {
  it('parses variables from frontmatter and returns them in ComposeResult', () => {
    const body = [
      '### Step One',
      'Welcome to group {{var:groupNumber}}.',
    ].join('\n')
    const md = frontmatter + body
    const result = composeTutorial(md, {
      repo: 'r', branch: 'main', slug: 's', target: 'hugo', rewriteImages: false,
    })
    expect(result.variables).toBeDefined()
    expect(result.variables).toHaveLength(2)
    expect(result.variables![0].name).toBe('groupNumber')
  })

  it('wraps prose token in step content as a span', () => {
    const body = [
      '### Step One',
      'Welcome to group {{var:groupNumber}}.',
    ].join('\n')
    const md = frontmatter + body
    const result = composeTutorial(md, {
      repo: 'r', branch: 'main', slug: 's', target: 'hugo', rewriteImages: false,
    })
    expect(result.steps[0].content).toContain('data-tut-var="groupNumber"')
    expect(result.steps[0].content).not.toContain('{{var:groupNumber}}')
  })

  it('wraps fenced token in step content as sentinel', () => {
    const body = [
      '### Step One',
      'Connect:',
      '```bash',
      'cf login -u {{var:groupNumber}}',
      '```',
    ].join('\n')
    const md = frontmatter + body
    const result = composeTutorial(md, {
      repo: 'r', branch: 'main', slug: 's', target: 'hugo', rewriteImages: false,
    })
    expect(result.steps[0].content).toContain('TUTVARxgroupNumberx')
    expect(result.steps[0].content).not.toContain('{{var:groupNumber}}')
  })

  it('passes through unchanged when no variables declared', () => {
    const plainFm = [
      '---',
      'parser: v2',
      'title: Test Tutorial',
      'time: 5',
      'tags: [tutorial>beginner]',
      'primary_tag: tutorial>beginner',
      'author_name: Tester',
      'author_profile: https://example.com',
      '---',
      '',
    ].join('\n')
    const body = '### Step One\nNo tokens here.'
    const md = plainFm + body
    const result = composeTutorial(md, {
      repo: 'r', branch: 'main', slug: 's', target: 'hugo', rewriteImages: false,
    })
    expect(result.variables).toBeUndefined()
    expect(result.steps[0].content).toBe('No tokens here.')
  })

  it('throws (hard fail) when a body token references an undeclared variable', () => {
    const body = [
      '### Step One',
      'Token: {{var:undeclared}}.',
    ].join('\n')
    const md = frontmatter + body
    expect(() => composeTutorial(md, {
      repo: 'r', branch: 'main', slug: 's', target: 'hugo', rewriteImages: false,
    })).toThrow(VariablesValidationError)
  })
})
