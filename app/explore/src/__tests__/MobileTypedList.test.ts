// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import MobileTypedList from '../components/MobileTypedList.vue'

describe('MobileTypedList', () => {
  const nodes = [
    { id: 't:a', type: 'tutorial' as const, label: 'Aardvark', slug: 'aardvark' },
    { id: 't:b', type: 'tutorial' as const, label: 'Beaver', slug: 'beaver' },
    { id: 'c:x', type: 'concept' as const, label: 'CAP', slug: 'cap' },
    { id: 'm:y', type: 'mission' as const, label: 'Mission Foo', slug: 'mission-foo' },
    { id: 'p:z', type: 'product' as const, label: 'HANA', slug: 'hana' },
  ]

  it('renders sections grouped by node type', () => {
    const wrapper = mount(MobileTypedList, { props: { nodes } })
    expect(wrapper.text()).toContain('Tutorials')
    expect(wrapper.text()).toContain('Concepts')
    expect(wrapper.text()).toContain('Missions')
  })

  it('renders tutorial anchors with /tutorials/<slug>/ href', () => {
    const wrapper = mount(MobileTypedList, { props: { nodes } })
    const a = wrapper.find('a[href="/tutorials/aardvark/"]')
    expect(a.exists()).toBe(true)
  })

  it('renders concept anchors with /concepts/<slug>/ href', () => {
    const wrapper = mount(MobileTypedList, { props: { nodes } })
    const a = wrapper.find('a[href="/concepts/cap/"]')
    expect(a.exists()).toBe(true)
  })

  it('orders nodes alphabetically within each section', () => {
    const wrapper = mount(MobileTypedList, { props: { nodes } })
    const tutorialAnchors = wrapper.findAll('a[href^="/tutorials/"]')
    expect(tutorialAnchors[0].text()).toBe('Aardvark')
    expect(tutorialAnchors[1].text()).toBe('Beaver')
  })

  it('renders empty state when no nodes', () => {
    const wrapper = mount(MobileTypedList, { props: { nodes: [] } })
    expect(wrapper.text()).toContain('No nodes')
  })
})
