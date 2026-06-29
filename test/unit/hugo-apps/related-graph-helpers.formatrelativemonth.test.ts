// test/unit/hugo-apps/related-graph-helpers.formatrelativemonth.test.ts
//
// Phase 4.6 (#747 §5) — formatRelativeMonth helper.
//
// Renders the GitHub sample's `lastCommitAt` ISO timestamp as a compact
// "Mon YYYY" string for the sidebar's meta-row (e.g. "Jun 2026"). The
// concept-page section uses Hugo's `dateFormat "Jan 2006"` for the same
// purpose — the Vue helper exists so the sidebar can compute the same
// shape client-side without re-parsing markdown.
//
// Defensive defaults: returns '' for null / undefined / empty / invalid
// input so the v-else-if template guard `v-if="r.lastCommitAt"` keeps
// the meta-row clean instead of rendering "Invalid Date".

import { describe, it, expect } from 'vitest'
import { formatRelativeMonth } from '../../../hugo-apps/src/related-graph/related-graph-helpers'

describe('formatRelativeMonth', () => {
  it('formats a valid ISO timestamp as "Mon YYYY"', () => {
    expect(formatRelativeMonth('2026-06-15T14:32:11Z')).toBe('Jun 2026')
    expect(formatRelativeMonth('2025-11-05T16:48:00Z')).toBe('Nov 2025')
    expect(formatRelativeMonth('2026-03-20T09:15:22Z')).toBe('Mar 2026')
  })

  it('returns empty string for null/undefined/empty input', () => {
    expect(formatRelativeMonth(null)).toBe('')
    expect(formatRelativeMonth(undefined)).toBe('')
    expect(formatRelativeMonth('')).toBe('')
  })

  it('returns empty string for invalid date string', () => {
    expect(formatRelativeMonth('not a date')).toBe('')
    expect(formatRelativeMonth('garbage')).toBe('')
  })
})
