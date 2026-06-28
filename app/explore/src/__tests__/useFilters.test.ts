// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useFilters, _resetFilters } from '../composables/useFilters'

describe('useFilters', () => {
  beforeEach(() => {
    _resetFilters()
  })

  it('starts with all node types and predicates enabled', () => {
    const { enabledNodeTypes, enabledPredicates } = useFilters()
    expect(enabledNodeTypes.value.size).toBeGreaterThan(0)
    expect(enabledPredicates.value.size).toBeGreaterThan(0)
  })

  it('toggleNodeType removes/adds the type from the enabled set', () => {
    const { enabledNodeTypes, toggleNodeType } = useFilters()
    const before = enabledNodeTypes.value.has('tutorial')
    toggleNodeType('tutorial')
    expect(enabledNodeTypes.value.has('tutorial')).toBe(!before)
  })

  it('togglePredicate removes/adds the predicate from the enabled set', () => {
    const { enabledPredicates, togglePredicate } = useFilters()
    const before = enabledPredicates.value.has('teaches')
    togglePredicate('teaches')
    expect(enabledPredicates.value.has('teaches')).toBe(!before)
  })

  it('emits kg.explore.filter on toggle', () => {
    const listener = vi.fn()
    window.addEventListener('kg.explore.filter', listener)
    const { toggleNodeType } = useFilters()
    toggleNodeType('mission')
    expect(listener).toHaveBeenCalled()
    const detail = (listener.mock.calls[0][0] as CustomEvent).detail
    expect(detail).toMatchObject({ filter: 'mission', kind: 'nodeType' })
    expect(typeof detail.enabled).toBe('boolean')
    window.removeEventListener('kg.explore.filter', listener)
  })

  it('emits kg.explore.filter on predicate toggle', () => {
    const listener = vi.fn()
    window.addEventListener('kg.explore.filter', listener)
    const { togglePredicate } = useFilters()
    togglePredicate('requires')
    expect(listener).toHaveBeenCalled()
    const detail = (listener.mock.calls[0][0] as CustomEvent).detail
    expect(detail).toMatchObject({ filter: 'requires', kind: 'predicate' })
    window.removeEventListener('kg.explore.filter', listener)
  })

  it('shares state across multiple consumers (singleton)', () => {
    const a = useFilters()
    const b = useFilters()
    a.toggleNodeType('tutorial')
    expect(a.enabledNodeTypes.value.has('tutorial')).toBe(false)
    expect(b.enabledNodeTypes.value.has('tutorial')).toBe(false)
  })
})
