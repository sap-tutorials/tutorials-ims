// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import AtlasGraph from '../components/AtlasGraph.vue'
import { FLOOR_SIZE } from '../graph.js'
import type { AtlasNode } from '../types.js'

// ── Mock sigma ────────────────────────────────────────────────────────────────
const mockSigmaInstances: any[] = []

vi.mock('sigma', () => ({
  default: class {
    handlers = new Map<string, (e: any) => void>()
    constructor(_g: unknown, _container: HTMLElement) {
      mockSigmaInstances.push(this)
    }
    on(event: string, handler: (e: any) => void) {
      this.handlers.set(event, handler)
      return this
    }
    kill() {}
    refresh() {}
    getCamera() { return { animate: vi.fn(), animatedReset: vi.fn() } }
  },
}))

// ── Mock graphology ───────────────────────────────────────────────────────────
const mockGraphInstances: any[] = []

vi.mock('graphology', () => {
  class MockMultiDirectedGraph {
    nodes = new Map<string, any>()
    edges = new Map<string, any>()
    constructor() { mockGraphInstances.push(this) }
    addNode(id: string, attrs: any) { this.nodes.set(id, attrs) }
    addEdgeWithKey(key: string, s: string, t: string, attrs: any) {
      if (this.edges.has(key)) throw new Error(`duplicate key "${key}"`)
      this.edges.set(key, { s, t, ...attrs })
    }
    hasNode(id: string) { return this.nodes.has(id) }
    hasEdge(key: string) { return this.edges.has(key) }
    getNodeAttributes(id: string) { return this.nodes.get(id) }
    forEachNode(cb: (id: string, a: any) => void) {
      for (const [id, a] of this.nodes) cb(id, a)
    }
    forEachEdge(cb: (key: string, a: any) => void) {
      for (const [k, a] of this.edges) cb(k, a)
    }
  }
  return { MultiDirectedGraph: MockMultiDirectedGraph }
})

vi.mock('graphology-layout-forceatlas2', () => ({
  default: { assign: vi.fn() },
}))

// ── Helpers ───────────────────────────────────────────────────────────────────
function makeNode(id: string, ownerType: AtlasNode['ownerType'] = 'SAP_Official'): AtlasNode {
  return {
    id, name: `Channel ${id}`, url: `https://example.com/${id}`,
    purpose: null, ownerType, subscribers: 1000, githubStars: null,
    focusAreas: ['CAP'], topicTags: [],
    size: FLOOR_SIZE + 5, color: '#0a6ed1',
  }
}

function mountAtlasGraph(props: Record<string, unknown>): {
  app: App
  emitted: Record<string, unknown[][]>
  unmount: () => void
} {
  const root = document.createElement('div')
  document.body.appendChild(root)
  const emitted: Record<string, unknown[][]> = {}
  const app = createApp(AtlasGraph as any, {
    ...props,
    onNodeClick: (payload: unknown) => { (emitted.nodeClick ??= []).push([payload]) },
  })
  app.mount(root)
  return { app, emitted, unmount: () => { app.unmount(); root.remove() } }
}

describe('AtlasGraph', () => {
  beforeEach(() => {
    mockSigmaInstances.length = 0
    mockGraphInstances.length = 0
  })
  afterEach(() => {
    while (document.body.firstChild) document.body.firstChild.remove()
  })

  const fixture = {
    nodes: [makeNode('ch-1'), makeNode('ch-2', 'Community_Member')],
    edges: [{ source: 'ch-1', target: 'ch-2', weight: 1, kind: 'focus' as const }],
  }

  it('mounts without throwing and renders the atlas-graph container', async () => {
    const { unmount } = mountAtlasGraph(fixture)
    await nextTick()
    expect(document.querySelector('.atlas-graph')).toBeTruthy()
    unmount()
  })

  it('adds all input nodes to the graphology graph', async () => {
    const { unmount } = mountAtlasGraph(fixture)
    await nextTick()
    const g = mockGraphInstances[0]
    expect(g.nodes.size).toBe(2)
    expect(g.nodes.has('ch-1')).toBe(true)
    expect(g.nodes.has('ch-2')).toBe(true)
    unmount()
  })

  it('adds input edges to the graphology graph (skipping duplicates)', async () => {
    const dupFixture = {
      nodes: [makeNode('ch-1'), makeNode('ch-2')],
      edges: [
        { source: 'ch-1', target: 'ch-2', weight: 1, kind: 'focus' as const },
        { source: 'ch-1', target: 'ch-2', weight: 1, kind: 'focus' as const }, // dup
      ],
    }
    const { unmount } = mountAtlasGraph(dupFixture)
    await nextTick()
    expect(mockGraphInstances[0].edges.size).toBe(1)
    unmount()
  })

  it('emits nodeClick with the full AtlasNode when Sigma fires clickNode', async () => {
    const { emitted, unmount } = mountAtlasGraph(fixture)
    await nextTick()
    const sigma = mockSigmaInstances[0]
    sigma.handlers.get('clickNode')?.({ node: 'ch-1' })
    expect(emitted.nodeClick).toBeTruthy()
    expect(emitted.nodeClick![0][0]).toMatchObject({
      id: 'ch-1',
      node: expect.objectContaining({ id: 'ch-1', name: 'Channel ch-1' }),
    })
    unmount()
  })

  it('rebuilds the graph when nodes prop changes (filter toggle regression)', async () => {
    const { app, unmount } = mountAtlasGraph(fixture)
    await nextTick()
    expect(mockSigmaInstances.length).toBe(1)
    app._instance!.props.nodes = [makeNode('ch-1')]
    await nextTick()
    expect(mockSigmaInstances.length).toBe(2)
    expect(mockGraphInstances[1].nodes.size).toBe(1)
    unmount()
  })
})
