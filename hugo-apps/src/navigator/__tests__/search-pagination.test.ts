import { describe, it, expect, vi, beforeEach } from 'vitest'
import { computeTotalPages } from '../../shared/composables/useNavigatorFilters'

describe('computeTotalPages', () => {
  it('uses searchTotalCount when in search mode', () => {
    // 100 server-side results, 5 client-filtered items, pageSize 48 → 3 pages
    expect(computeTotalPages(true, 100, 5, 48)).toBe(3)
  })

  it('uses filteredLen when not in search mode', () => {
    // 5 client-filtered items, pageSize 48 → 1 page
    expect(computeTotalPages(false, 100, 5, 48)).toBe(1)
  })

  it('returns 1 when search mode total count is 0', () => {
    expect(computeTotalPages(true, 0, 0, 48)).toBe(0)
  })

  it('handles exact page boundary in search mode', () => {
    // exactly 48 → 1 page
    expect(computeTotalPages(true, 48, 0, 48)).toBe(1)
  })

  it('handles just-over boundary in search mode', () => {
    // 49 → 2 pages
    expect(computeTotalPages(true, 49, 0, 48)).toBe(2)
  })

  it('handles client mode with partial last page', () => {
    // 97 items, pageSize 48 → 3 pages
    expect(computeTotalPages(false, 0, 97, 48)).toBe(3)
  })
})
