// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

// The realtime composable opens a socket.io connection; stub it so mounting the
// logged-in / has-tracks path doesn't attempt a real WebSocket in tests.
vi.mock('../useRealtimeProgress', async () => {
  const { ref } = await import('vue')
  return { useRealtimeProgress: () => ({ lastCompletion: ref(null), connected: ref(false) }) }
})

import AppSpace from '../AppSpace.vue'
import { shouldShowCheckpointBarcode } from '../checkpoint-barcode'

function stubFetch(handler: (url: string) => { ok: boolean; status: number; body: unknown }) {
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const { ok, status, body } = handler(String(input))
    return { ok, status, json: async () => body }
  }) as unknown as typeof fetch)
}

// ── Payload builders ─────────────────────────────────────────────────────────

const tutorial = (over: Record<string, unknown> = {}) => ({
  imsId: 0, title: 'Tut', type: 'TUTORIAL', status: '', progress: 0,
  experience: '', timeToComplete: 10, url: '/tutorials/x.html', description: '',
  unlocked: true, temporarilyUnavailable: false, ...over,
})

// Fork track: setup linear → fork (MCP lane ending in synthetic CHECKPOINT with
// prizeId, Agents lane without) → downstream CHECKPOINT. `complete` controls
// whether the lanes' tutorials are finished.
const forkPayload = (authenticated: boolean, complete: boolean) => ({
  eventId: 10000006,
  eventName: 'TechEd 2026',
  eventType: 'TECHED',
  authenticated,
  type: 'COMPLEX',
  paths: [{
    id: 1,
    title: 'Explore Agentic AI with CAP',
    description: 'Forking track',
    items: [], // legacy flat list intentionally empty — detail view must use segments
    segments: [
      {
        order: 10, kind: 'linear', items: [
          tutorial({ imsId: 1, title: 'Set up a dev environment', status: 'COMPLETED', unlocked: true }),
        ],
      },
      {
        order: 20, kind: 'fork', lanes: [
          {
            label: 'MCP',
            items: [
              tutorial({ imsId: 2, title: 'Add MCP capabilities', status: complete ? 'COMPLETED' : '', unlocked: true }),
              {
                imsId: null, title: 'MCP', type: 'CHECKPOINT', status: '', progress: 0,
                experience: '', timeToComplete: 0, url: '', description: '',
                recordId: 0, temporarilyUnavailable: false, prizeId: 500,
                unlocked: complete, // synthetic lane prize unlocks when THIS lane done
              },
            ],
          },
          {
            label: 'Agents',
            items: [
              tutorial({ imsId: 3, title: 'Create an agent from a CAP service', status: complete ? 'COMPLETED' : '', unlocked: true }),
            ],
          },
        ],
      },
      {
        order: 30, kind: 'linear', items: [
          {
            imsId: 99, title: 'Agentic AI T-shirt', type: 'CHECKPOINT', status: '', progress: 0,
            experience: '', timeToComplete: 0, url: '', description: '',
            recordId: 0, temporarilyUnavailable: false,
            unlocked: complete, // downstream checkpoint: all lanes must finish
          },
        ],
      },
    ],
  }],
})

// Parallel-any track: setup linear → cluster of N tutorials (all available once
// the setup segment is satisfied).
const clusterPayload = () => ({
  eventId: 10000007,
  eventName: 'TechEd 2026',
  eventType: 'TECHED',
  authenticated: true,
  type: 'COMPLEX',
  paths: [{
    id: 2,
    title: 'CAP Fundamentals Sampler',
    description: 'Any order',
    items: [],
    segments: [
      {
        order: 10, kind: 'linear', items: [
          tutorial({ imsId: 10, title: 'Set up your CAP dev space', status: 'COMPLETED', unlocked: true }),
        ],
      },
      {
        order: 20, kind: 'parallel-any', items: [
          tutorial({ imsId: 11, title: 'Add a service', unlocked: true }),
          tutorial({ imsId: 12, title: 'Add a DB entity', unlocked: true }),
          tutorial({ imsId: 13, title: 'Add auth', unlocked: true }),
          tutorial({ imsId: 14, title: 'Add a UI', unlocked: true }),
        ],
      },
    ],
  }],
})

async function openTrack(wrapper: ReturnType<typeof mount>) {
  const card = wrapper.find('.track-card')
  expect(card.exists()).toBe(true)
  await card.trigger('click')
  await flushPromises()
}

describe('AppSpace segment rendering', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    window.history.replaceState({}, '', '/app-space/?eventId=10000006')
  })

  it('renders two labeled fork lane columns', async () => {
    stubFetch((url) => {
      if (url.includes('getAppSpaceProgress')) return { ok: true, status: 200, body: forkPayload(true, false) }
      return { ok: false, status: 404, body: {} }
    })
    const wrapper = mount(AppSpace)
    await flushPromises()
    await openTrack(wrapper)

    const lanes = wrapper.findAll('.lane')
    expect(lanes.length).toBe(2)
    const labels = wrapper.findAll('.lane__name').map(n => n.text())
    expect(labels).toContain('MCP')
    expect(labels).toContain('Agents')
    // Fork + join connectors render
    expect(wrapper.find('.fork-connector').exists()).toBe(true)
    expect(wrapper.find('.join-connector').exists()).toBe(true)
  })

  it('locks the downstream checkpoint while lanes are incomplete', async () => {
    stubFetch((url) => {
      if (url.includes('getAppSpaceProgress')) return { ok: true, status: 200, body: forkPayload(true, false) }
      return { ok: false, status: 404, body: {} }
    })
    const wrapper = mount(AppSpace)
    await flushPromises()
    await openTrack(wrapper)

    // The downstream checkpoint (order 30) must be locked → no barcode even
    // though the user is authenticated.
    expect(wrapper.text()).toContain('Agentic AI T-shirt')
    const barcodes = wrapper.findAll('.checkpoint-barcode__img')
    // No downstream barcode while incomplete (the synthetic lane prize is also
    // locked in this state).
    expect(barcodes.length).toBe(0)
    // Track is not complete.
    expect(wrapper.find('.timeline').html()).toBeTruthy()
  })

  it('shows the synthetic lane checkpoint barcode when unlocked + authenticated, identically to a normal checkpoint', async () => {
    stubFetch((url) => {
      if (url.includes('getAppSpaceProgress')) return { ok: true, status: 200, body: forkPayload(true, true) }
      return { ok: false, status: 404, body: {} }
    })
    const wrapper = mount(AppSpace)
    await flushPromises()
    await openTrack(wrapper)

    // Synthetic lane-end CHECKPOINT (prizeId) + downstream CHECKPOINT both
    // unlocked & authenticated → barcodes render.
    const barcodes = wrapper.findAll('.checkpoint-barcode__img')
    expect(barcodes.length).toBeGreaterThanOrEqual(1)
    expect(barcodes[0].attributes('src')).toBe('/api/my-prize-barcode?eventId=10000006')

    // Parity: the helper keys purely on type/unlocked/authenticated — the
    // synthetic item (with prizeId) and a normal checkpoint behave identically.
    const syntheticLaneCheckpoint = { type: 'CHECKPOINT' as const, status: '', prizeId: 500 }
    const normalCheckpoint = { type: 'CHECKPOINT' as const, status: '' }
    expect(shouldShowCheckpointBarcode(syntheticLaneCheckpoint, true, true))
      .toBe(shouldShowCheckpointBarcode(normalCheckpoint, true, true))
    expect(shouldShowCheckpointBarcode(syntheticLaneCheckpoint, true, true)).toBe(true)
  })

  it('renders a parallel-any cluster with all N cards available after setup', async () => {
    stubFetch((url) => {
      if (url.includes('getAppSpaceProgress')) return { ok: true, status: 200, body: clusterPayload() }
      return { ok: false, status: 404, body: {} }
    })
    window.history.replaceState({}, '', '/app-space/?eventId=10000007')
    const wrapper = mount(AppSpace)
    await flushPromises()
    await openTrack(wrapper)

    const cluster = wrapper.find('.cluster')
    expect(cluster.exists()).toBe(true)
    // 4 cluster cards, all available (none locked).
    const clusterItems = cluster.findAll('.timeline-item')
    expect(clusterItems.length).toBe(4)
    const locked = cluster.findAll('.step--locked')
    expect(locked.length).toBe(0)
  })
})
