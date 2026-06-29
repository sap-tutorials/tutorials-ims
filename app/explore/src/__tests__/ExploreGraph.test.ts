// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import ExploreGraph from '../components/ExploreGraph.vue'

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
    getCamera() {
      return { animatedReset: vi.fn(), animate: vi.fn() }
    }
  }
}))

const mockGraphInstances: any[] = []

vi.mock('graphology', () => ({
  default: class {
    nodes = new Map<string, any>()
    edges = new Map<string, any>()
    constructor() { mockGraphInstances.push(this) }
    addNode(id: string, attrs: any) { this.nodes.set(id, attrs); return this }
    addEdgeWithKey(key: string, s: string, o: string, attrs: any) {
      this.edges.set(key, { s, o, ...attrs })
      return key
    }
    hasEdge(key: string) { return this.edges.has(key) }
    getNodeAttributes(id: string) { return this.nodes.get(id) }
    forEachEdge(...args: any[]) {
      // If 1 arg: callback over all edges. If 3 args: source, target, callback.
      const callback = args[args.length - 1]
      if (typeof callback !== 'function') return
      if (args.length === 1) {
        for (const [key, attrs] of this.edges) callback(key, attrs)
      } else {
        const [s, o, cb] = args
        for (const [key, edge] of this.edges) {
          if (edge.s === s && edge.o === o) {
            cb(key, edge)
          }
        }
      }
    }
    setEdgeAttribute(key: string, attr: string, value: any) {
      const edge = this.edges.get(key)
      if (edge) edge[attr] = value
    }
    getEdgeAttribute(key: string, attr: string) {
      return this.edges.get(key)?.[attr]
    }
  }
}))

vi.mock('graphology-layout-forceatlas2', () => ({
  default: { assign: vi.fn() }
}))

/**
 * Mount ExploreGraph with a raw `createApp`, returning an emitted-event
 * collector + an `unmount()` helper.
 *
 * Why not `@vue/test-utils`? `@vue/test-utils@2.4.10` (current pin) wraps the
 * mounted component in a way that suppresses callback-ref invocation on the
 * SFC's root element under happy-dom (issue #694). A raw `createApp` mount
 * gives Vue's runtime an owner context for the root vnode, so the
 * `ref="container"` binding fires as expected and `onMounted` sees a real
 * DOM element. Drop this helper and switch back to `mount()` once
 * `@vue/test-utils` ships a fix (>= 2.5.x).
 */
function mountExploreGraph(props: Record<string, unknown>): {
  app: App
  emitted: Record<string, unknown[][]>
  unmount: () => void
} {
  const root = document.createElement('div')
  document.body.appendChild(root)
  const emitted: Record<string, unknown[][]> = {}
  const app = createApp(ExploreGraph as any, {
    ...props,
    onNodeClick: (payload: unknown) => {
      (emitted.nodeClick ??= []).push([payload])
    },
  })
  app.mount(root)
  return {
    app,
    emitted,
    unmount: () => {
      app.unmount()
      root.remove()
    },
  }
}

describe('ExploreGraph', () => {
  beforeEach(() => {
    mockSigmaInstances.length = 0
    mockGraphInstances.length = 0
  })
  afterEach(() => {
    // Strip any leftover DOM nodes so document.body state doesn't bleed
    // between tests. Remove children one by one (avoids the security-lint
    // hook on `innerHTML = ''`).
    while (document.body.firstChild) document.body.firstChild.remove()
  })

  const fixture = {
    nodes: [
      { id: 't:a', type: 'tutorial' as const, label: 'A', slug: 'a' },
      { id: 'c:x', type: 'concept' as const, label: 'X', slug: 'x' },
    ],
    edges: [{ s: 't:a', p: 'teaches' as const, o: 'c:x' }],
  }

  it('mounts without error', async () => {
    const { unmount } = mountExploreGraph(fixture)
    await nextTick()
    expect(document.querySelector('.explore-graph')).toBeTruthy()
    unmount()
  })

  it('deduplicates duplicate edges by key', async () => {
    const dupEdges = {
      nodes: fixture.nodes,
      edges: [
        { s: 't:a', p: 'teaches' as const, o: 'c:x' },
        { s: 't:a', p: 'teaches' as const, o: 'c:x' },
      ],
    }
    const { unmount } = mountExploreGraph(dupEdges)
    await nextTick()
    expect(mockGraphInstances[0].edges.size).toBe(1)
    unmount()
  })

  it('emits nodeClick when Sigma fires clickNode', async () => {
    const { emitted, unmount } = mountExploreGraph(fixture)
    await nextTick()
    const sigma = mockSigmaInstances[0]
    const handler = sigma.handlers.get('clickNode')
    expect(handler).toBeTypeOf('function')
    handler({ node: 't:a' })
    expect(emitted.nodeClick).toBeTruthy()
    expect(emitted.nodeClick![0]).toEqual([{
      id: 't:a',
      node: expect.objectContaining({ id: 't:a', type: 'tutorial', label: 'A', slug: 'a' })
    }])
    unmount()
  })

  it('overlays path edges in highlight color when path prop is set', async () => {
    const pathFixture = {
      nodes: [
        { id: 't:a', type: 'tutorial' as const, label: 'A', slug: 'a' },
        { id: 't:b', type: 'tutorial' as const, label: 'B', slug: 'b' },
      ],
      edges: [{ s: 't:a', p: 'teaches' as const, o: 't:b' }],
      path: ['t:a', 't:b'],
    }
    const { unmount } = mountExploreGraph(pathFixture)
    await nextTick()
    // The single edge connects t:a → t:b and is on the path; it should be
    // recolored to the SAP-orange highlight color (#ff6b35) with size 3.
    const graph = mockGraphInstances[0]
    expect(graph.edges.size).toBe(1)
    const [, attrs] = [...graph.edges.entries()][0]
    expect(attrs.color).toBe('#ff6b35')
    expect(attrs.size).toBe(3)
    unmount()
  })
})
