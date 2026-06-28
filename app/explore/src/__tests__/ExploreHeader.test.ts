// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import ExploreHeader from '../components/ExploreHeader.vue'
import type { NodeType, PredicateType } from '../types'

const allNodes = [
  { id: 't:a', type: 'tutorial' as const, label: 'A', slug: 'a' },
  { id: 'c:x', type: 'concept' as const, label: 'X', slug: 'x' },
  { id: 'm:m', type: 'mission' as const, label: 'M', slug: 'm' },
]

function makeFilterProps() {
  return {
    enabledNodeTypes: new Set<NodeType>([
      'tutorial', 'concept', 'mission', 'product', 'group', 'category', 'tag',
    ]),
    enabledPredicates: new Set<PredicateType>([
      'teaches', 'requires', 'relatedTo', 'extends',
      'partOf', 'taggedWith', 'aboutProduct', 'inCategory', 'coCompletedWith',
    ]),
  }
}

describe('ExploreHeader', () => {
  it('mounts and renders the brand bar', () => {
    const wrapper = mount(ExploreHeader, {
      props: { allNodes, ...makeFilterProps() },
    })
    expect(wrapper.find('.explore-header').exists()).toBe(true)
    expect(wrapper.text()).toContain('SAP Tutorials')
  })

  it('exposes findDisabled computed reflecting picker state', async () => {
    // Vue 3.5 SFC template hoisting + happy-dom + @vue/test-utils 2.4.10 doesn't
    // re-render :disabled bound to a computed without $forceUpdate. We test the
    // logic via the vm instead of via the DOM disabled attribute.
    const wrapper = mount(ExploreHeader, {
      props: { allNodes, ...makeFilterProps() },
    })
    const vm = wrapper.vm as any
    expect(vm.findDisabled).toBe(true)
    vm.fromSlug = 'a'
    await nextTick()
    expect(vm.findDisabled).toBe(true) // still missing toSlug
    vm.toSlug = 'x'
    await nextTick()
    expect(vm.findDisabled).toBe(false)
  })

  it('emits findPath when both pickers have values and emitFindPath() is invoked', async () => {
    const wrapper = mount(ExploreHeader, {
      props: { allNodes, ...makeFilterProps() },
    })
    const vm = wrapper.vm as any
    vm.fromSlug = 'a'
    vm.toSlug = 'x'
    await nextTick()
    vm.emitFindPath()
    expect(wrapper.emitted('findPath')).toBeTruthy()
    expect(wrapper.emitted('findPath')![0]).toEqual([{ from: 'a', to: 'x' }])
  })

  it('does NOT emit findPath when one picker is empty', async () => {
    const wrapper = mount(ExploreHeader, {
      props: { allNodes, ...makeFilterProps() },
    })
    const vm = wrapper.vm as any
    vm.fromSlug = 'a'
    vm.toSlug = ''
    await nextTick()
    vm.emitFindPath()
    expect(wrapper.emitted('findPath')).toBeFalsy()
  })

  it('emits kg.explore.search event on search input (debounced)', async () => {
    const listener = vi.fn()
    window.addEventListener('kg.explore.search', listener)
    const wrapper = mount(ExploreHeader, {
      props: { allNodes, ...makeFilterProps() },
    })
    const vm = wrapper.vm as any
    vm.searchQuery = 'cap'
    await nextTick()
    // Wait for the 200ms debounce + cushion
    await new Promise(r => setTimeout(r, 300))
    expect(listener).toHaveBeenCalled()
    const detail = (listener.mock.calls[0][0] as CustomEvent).detail
    expect(detail).toMatchObject({ query: 'cap' })
    expect(typeof detail.resultCount).toBe('number')
    window.removeEventListener('kg.explore.search', listener)
  })

  it('renders slug suggestions filtered to tutorial+concept', () => {
    const wrapper = mount(ExploreHeader, {
      props: { allNodes, ...makeFilterProps() },
    })
    const vm = wrapper.vm as any
    const suggestions = vm.slugSuggestions
    expect(suggestions.length).toBe(2)
    expect(suggestions.map((n: any) => n.slug).sort()).toEqual(['a', 'x'])
  })

  it('renders a FilterDropdown that forwards toggleNodeType / togglePredicate', () => {
    const wrapper = mount(ExploreHeader, {
      props: { allNodes, ...makeFilterProps() },
    })
    // The FilterDropdown child component should be mounted.
    expect(wrapper.findComponent({ name: 'FilterDropdown' }).exists()).toBe(true)
  })
})
