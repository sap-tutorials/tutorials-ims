// Regression test for #432 — empty/whitespace-only upstream stubs (e.g.
// abap-environment-create-tile.md is literally 0 bytes in the source repo)
// got the cryptic "Missing required frontmatter field: type" reason. The
// new emptyContentCheck() short-circuits with an actionable message.

import { describe, it, expect } from 'vitest'
import { emptyContentCheck } from '../scripts/validate-tutorials.js'

describe('emptyContentCheck (#432)', () => {
  it('returns null for non-empty content', () => {
    expect(emptyContentCheck('---\ntype: tutorials\n---\nbody')).toBeNull()
  })

  it('returns the empty-stub reason for a 0-byte file', () => {
    expect(emptyContentCheck('')).toBe(
      'Tutorial source is empty or whitespace-only — likely an empty stub in the upstream repo'
    )
  })

  it('returns the empty-stub reason for whitespace-only content', () => {
    expect(emptyContentCheck('   \n\t\n  ')).toBe(
      'Tutorial source is empty or whitespace-only — likely an empty stub in the upstream repo'
    )
  })

  it('returns null for content with leading/trailing whitespace but real body', () => {
    expect(emptyContentCheck('\n\n  hello  \n\n')).toBeNull()
  })
})
