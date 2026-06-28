// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import NodeDetailPanel from '../components/NodeDetailPanel.vue'
import type { ExploreEdge, ExploreNode } from '../types'

describe('NodeDetailPanel', () => {
  const tutorialNode: ExploreNode = {
    id: 't:cap', type: 'tutorial', label: 'CAP handlers', slug: 'cap',
  }
  const conceptNode: ExploreNode = {
    id: 'c:x', type: 'concept', label: 'X', slug: 'x',
  }
  const missionNode: ExploreNode = {
    id: 'm:m', type: 'mission', label: 'Mission', slug: 'm',
  }
  const edges: ExploreEdge[] = [
    { s: 't:cap', p: 'teaches', o: 'c:x' },
    { s: 't:cap', p: 'teaches', o: 'c:y' },
    { s: 'c:foo', p: 'requires', o: 't:cap' },
  ]

  it('shows empty state when no node is selected', () => {
    const wrapper = mount(NodeDetailPanel, {
      props: { selectedNode: null, edges: [] },
    })
    expect(wrapper.text()).toContain('Select a node')
  })

  it('renders node name + tutorial link when a tutorial is selected', () => {
    const wrapper = mount(NodeDetailPanel, {
      props: { selectedNode: tutorialNode, edges },
    })
    expect(wrapper.text()).toContain('CAP handlers')
    expect(wrapper.find('a[href="/tutorials/cap/"]').exists()).toBe(true)
  })

  it('links concept nodes to /concepts/<slug>/', () => {
    const wrapper = mount(NodeDetailPanel, {
      props: { selectedNode: conceptNode, edges: [] },
    })
    expect(wrapper.find('a[href="/concepts/x/"]').exists()).toBe(true)
  })

  it('does NOT render a detail link for non-navigable node types (mission)', () => {
    const wrapper = mount(NodeDetailPanel, {
      props: { selectedNode: missionNode, edges: [] },
    })
    expect(wrapper.find('a').exists()).toBe(false)
  })

  it('groups incident edges by predicate (incoming + outgoing)', () => {
    const wrapper = mount(NodeDetailPanel, {
      props: { selectedNode: tutorialNode, edges },
    })
    const text = wrapper.text()
    expect(text).toContain('teaches')
    expect(text).toContain('requires')
  })

  it('exposes incidentEdges grouped by predicate', () => {
    const wrapper = mount(NodeDetailPanel, {
      props: { selectedNode: tutorialNode, edges },
    })
    const vm = wrapper.vm as any
    expect(vm.incidentEdges.teaches?.length).toBe(2)
    expect(vm.incidentEdges.requires?.length).toBe(1)
  })

  it('emits kg.explore.node_navigated when the detail link is clicked', async () => {
    const listener = vi.fn()
    window.addEventListener('kg.explore.node_navigated', listener)
    const wrapper = mount(NodeDetailPanel, {
      props: { selectedNode: tutorialNode, edges: [] },
    })
    const vm = wrapper.vm as any
    // Stub clickability since happy-dom's anchor navigation throws.
    vm.onNavigate(new Event('click'))
    expect(listener).toHaveBeenCalled()
    const detail = (listener.mock.calls[0][0] as CustomEvent).detail
    expect(detail).toMatchObject({
      nodeId: 't:cap',
      nodeType: 'tutorial',
      targetUrl: '/tutorials/cap/',
    })
    window.removeEventListener('kg.explore.node_navigated', listener)
  })
})
