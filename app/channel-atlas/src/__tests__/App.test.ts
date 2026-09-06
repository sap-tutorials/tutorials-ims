// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick } from 'vue'
import AtlasApp from '../App.vue'
import type { AtlasPayload } from '../types.js'
import { _resetOwnerTypeFilter } from '../composables/useOwnerTypeFilter.js'

vi.mock('sigma', () => ({
  default: class {
    constructor(_g: unknown, _c: HTMLElement) {}
    on() { return this }
    kill() {}
  },
}))
vi.mock('graphology', () => ({
  MultiDirectedGraph: class {
    nodes = new Map(); edges = new Map()
    addNode(id: string, a: any) { this.nodes.set(id, a) }
    addEdgeWithKey() {}
    hasNode(id: string) { return this.nodes.has(id) }
    hasEdge() { return false }
    forEachNode() {}
    forEachEdge() {}
  },
}))
vi.mock('graphology-layout-forceatlas2', () => ({ default: { assign: vi.fn() } }))

const PAYLOAD: AtlasPayload = {
  channels: [
    {
      id: 'ch-1', name: 'SAP CAP', url: 'https://cap.cloud.sap', purpose: 'CAP stuff',
      ownerType: 'SAP_Official', subscribers: 1000, githubStars: null,
      focusAreas: ['CAP'], topicTags: [],
    },
  ],
  buildAt: '2026-09-05T00:00:00.000Z',
}

function injectPayload(data: AtlasPayload) {
  const el = document.createElement('script')
  el.id = 'atlas-payload'
  el.type = 'application/json'
  el.textContent = JSON.stringify(data)
  document.body.appendChild(el)
}

describe('App', () => {
  beforeEach(() => {
    document.getElementById('atlas-payload')?.remove()
    _resetOwnerTypeFilter()
  })
  afterEach(() => { while (document.body.firstChild) document.body.firstChild.remove() })

  it('renders loading state before payload resolves', async () => {
    // No inline payload → hasData=false immediately
    const root = document.createElement('div')
    document.body.appendChild(root)
    const app = createApp(AtlasApp)
    app.mount(root)
    await nextTick()
    expect(root.textContent).toMatch(/Loading Channel Atlas/)
    app.unmount()
  })

  it('renders graph + panel when inline payload is present', async () => {
    injectPayload(PAYLOAD)
    const root = document.createElement('div')
    document.body.appendChild(root)
    const app = createApp(AtlasApp)
    app.mount(root)
    await nextTick()
    // Toolbar + canvas + panel should all be present
    expect(root.querySelector('.atlas-page__toolbar')).toBeTruthy()
    expect(root.querySelector('.atlas-graph')).toBeTruthy()
    expect(root.querySelector('.channel-panel')).toBeTruthy()
    app.unmount()
  })

  it('renders empty-state when all owner types are filtered out', async () => {
    injectPayload(PAYLOAD)
    // Inject a payload where the single channel has a non-default ownerType
    // and reset to NO enabled types via the singleton.
    const { enabledTypes } = await import('../composables/useOwnerTypeFilter.js')
    enabledTypes.value = new Set() // filter everything out
    const root = document.createElement('div')
    document.body.appendChild(root)
    const app = createApp(AtlasApp)
    app.mount(root)
    await nextTick()
    expect(root.textContent).toMatch(/No channels to display/)
    app.unmount()
    // Restore
    _resetOwnerTypeFilter()
  })
})
