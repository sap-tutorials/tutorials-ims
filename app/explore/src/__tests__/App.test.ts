// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref, nextTick, computed } from 'vue'
import { _resetFilters, useFilters } from '../composables/useFilters'

// ---------------------------------------------------------------------------
// Stub ThreeDGraph so mounting never touches WebGL
// ---------------------------------------------------------------------------
vi.mock('../components/ThreeDGraph.vue', () => ({
  default: { name: 'ThreeDGraph', render: () => null },
}))

// ---------------------------------------------------------------------------
// Stub ExploreGraph — the real one imports sigma/graphology which require DOM
// canvas methods unavailable in happy-dom.
// ---------------------------------------------------------------------------
vi.mock('../components/ExploreGraph.vue', () => ({
  default: { name: 'ExploreGraph', render: () => null },
}))

// ---------------------------------------------------------------------------
// Stub ExploreHeader
// ---------------------------------------------------------------------------
vi.mock('../components/ExploreHeader.vue', () => ({
  default: { name: 'ExploreHeader', render: () => null },
}))

// ---------------------------------------------------------------------------
// Stub NodeDetailPanel
// ---------------------------------------------------------------------------
vi.mock('../components/NodeDetailPanel.vue', () => ({
  default: { name: 'NodeDetailPanel', render: () => null },
}))

// ---------------------------------------------------------------------------
// Stub MobileTypedList
// ---------------------------------------------------------------------------
vi.mock('../components/MobileTypedList.vue', () => ({
  default: { name: 'MobileTypedList', render: () => null },
}))

// ---------------------------------------------------------------------------
// Stub fetchPath so no real HTTP requests are made
// ---------------------------------------------------------------------------
vi.mock('../api/path', () => ({
  fetchPath: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Mocks for composables — defined with module-level payloadRef / isMobileRef
// so individual tests can mutate the reactive values.
// ---------------------------------------------------------------------------
const payloadRef = ref<null | { nodes: any[]; edges: any[]; features?: { threeD: boolean } }>(null)
const isMobileRef = ref(false)

vi.mock('../composables/useGraphData', () => ({
  useGraphData: () => ({
    payload: payloadRef,
    hasData: computed(() => !!payloadRef.value),
    error: ref(null),
  }),
}))

vi.mock('../composables/useViewport', () => ({
  useViewport: () => ({ isMobile: isMobileRef }),
}))

vi.mock('../composables/useTelemetry', () => ({
  useTelemetry: vi.fn(),
  dispatchPathDrawn: vi.fn(),
}))

vi.mock('../composables/useSelectedNode', () => ({
  useSelectedNode: () => ({
    selectedNode: ref(null),
    selectNode: vi.fn(),
  }),
}))

// ---------------------------------------------------------------------------
// Helper to mount App with a given payload and isMobile setting
// ---------------------------------------------------------------------------
async function mountApp(opts: {
  threeD?: boolean
  mobile?: boolean
}) {
  const { default: App } = await import('../App.vue')

  // Set the mocked reactive values before mounting
  isMobileRef.value = opts.mobile ?? false
  payloadRef.value = {
    nodes: [],
    edges: [],
    features: { threeD: opts.threeD ?? false },
  }

  const wrapper = mount(App)
  await nextTick()
  return wrapper
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('App.vue — 2D/3D toggle visibility', () => {
  beforeEach(() => {
    _resetFilters()
  })

  it('case A: features.threeD=false, desktop → 0 toggle buttons', async () => {
    const wrapper = await mountApp({ threeD: false, mobile: false })
    expect(wrapper.findAll('.explore__viewbtn').length).toBe(0)
  })

  it('case B: features.threeD=true, desktop → 2 toggle buttons (2D and 3D)', async () => {
    const wrapper = await mountApp({ threeD: true, mobile: false })
    expect(wrapper.findAll('.explore__viewbtn').length).toBe(2)
  })

  it('case C: features.threeD=true, mobile → 0 toggle buttons (MobileTypedList only)', async () => {
    const wrapper = await mountApp({ threeD: true, mobile: true })
    expect(wrapper.findAll('.explore__viewbtn').length).toBe(0)
  })

  it('case D: clicking 3D button when filters are all-on narrows enabledNodeTypes to THREED_DEFAULT_TYPES (size 3)', async () => {
    _resetFilters()
    const { enabledNodeTypes } = useFilters()
    const wrapper = await mountApp({ threeD: true, mobile: false })

    // Filters should start at all-on
    const allOnSize = enabledNodeTypes.value.size
    expect(allOnSize).toBeGreaterThan(3)

    // Click the 3D button
    const btns = wrapper.findAll('.explore__viewbtn')
    expect(btns.length).toBe(2)
    // Second button is '3D'
    const btn3d = btns.find(b => b.text() === '3D')
    expect(btn3d).toBeDefined()
    await btn3d!.trigger('click')
    await nextTick()

    // Should have narrowed to tutorial, concept, mission = 3 types
    expect(enabledNodeTypes.value.size).toBe(3)
    expect(enabledNodeTypes.value.has('tutorial')).toBe(true)
    expect(enabledNodeTypes.value.has('concept')).toBe(true)
    expect(enabledNodeTypes.value.has('mission')).toBe(true)
  })

  it('case E: 2D→3D→2D round-trip clears pathNodeIds (stale overlay fix)', async () => {
    const wrapper = await mountApp({ threeD: true, mobile: false })
    const vm = wrapper.vm as any

    // Simulate a path having been drawn in 2D
    vm.pathNodeIds = ['t:foo', 't:bar']
    await nextTick()
    expect(vm.pathNodeIds).not.toBeNull()

    // Switch to 3D — watcher should clear the path
    vm.view3d = true
    await nextTick()
    expect(vm.pathNodeIds).toBeNull()

    // Simulate a path drawn in 3D (edge case: shouldn't survive the return trip)
    vm.pathNodeIds = ['t:baz', 't:qux']
    await nextTick()

    // Switch back to 2D — watcher should clear again
    vm.view3d = false
    await nextTick()
    expect(vm.pathNodeIds).toBeNull()
  })
})
