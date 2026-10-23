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

// #2889: a track with a NON-TERMINAL plain checkpoint (no prizeId) at a lower
// order than later tutorials — the latent shape the highest-order rule guards.
// `earlyUnlocked` toggles whether the mid-track checkpoint is unlocked while the
// downstream tutorial (and terminal checkpoint) remain incomplete. Only the
// TERMINAL checkpoint (order 40) should be able to complete the track.
const nonTerminalCheckpointPayload = (earlyUnlocked: boolean, terminalUnlocked: boolean) => ({
  eventId: 10000008,
  eventName: 'TechEd 2026',
  eventType: 'TECHED',
  authenticated: true,
  type: 'COMPLEX',
  paths: [{
    id: 3,
    title: 'Two-stage track with a mid checkpoint',
    description: 'Checkpoint before more work',
    items: [],
    segments: [
      {
        order: 10, kind: 'linear', items: [
          tutorial({ imsId: 20, title: 'Stage one tutorial', status: 'COMPLETED', unlocked: true }),
        ],
      },
      {
        // Non-terminal plain checkpoint: authored mid-track, no prizeId.
        order: 20, kind: 'linear', items: [
          {
            imsId: 21, title: 'Mid checkpoint', type: 'CHECKPOINT', status: '', progress: 0,
            experience: '', timeToComplete: 0, url: '', description: '',
            recordId: 0, temporarilyUnavailable: false, unlocked: earlyUnlocked,
          },
        ],
      },
      {
        order: 30, kind: 'linear', items: [
          tutorial({ imsId: 22, title: 'Stage two tutorial', status: terminalUnlocked ? 'COMPLETED' : '', unlocked: earlyUnlocked }),
        ],
      },
      {
        // Terminal plain checkpoint (highest order): the real completion gate.
        order: 40, kind: 'linear', items: [
          {
            imsId: 23, title: 'Final checkpoint', type: 'CHECKPOINT', status: '', progress: 0,
            experience: '', timeToComplete: 0, url: '', description: '',
            recordId: 0, temporarilyUnavailable: false, unlocked: terminalUnlocked,
          },
        ],
      },
    ],
  }],
})

// #2889: a fork track where the lane-prize checkpoint (prizeId) is unlocked
// because its lane finished, but the DOWNSTREAM join checkpoint is still locked.
// Discriminates the prize-aware rule: the unlocked lane prize alone completes
// the track even though the terminal (highest-order) plain checkpoint is locked.
const lanePrizeOnlyPayload = () => ({
  eventId: 10000009,
  eventName: 'TechEd 2026',
  eventType: 'TECHED',
  authenticated: true,
  type: 'COMPLEX',
  paths: [{
    id: 4,
    title: 'Lane prize earns the reward',
    description: 'One branch suffices',
    items: [],
    segments: [
      {
        order: 10, kind: 'fork', lanes: [
          {
            label: 'MCP',
            items: [
              tutorial({ imsId: 30, title: 'Finish the MCP lane', status: 'COMPLETED', unlocked: true }),
              {
                imsId: null, title: 'MCP prize', type: 'CHECKPOINT', status: '', progress: 0,
                experience: '', timeToComplete: 0, url: '', description: '',
                recordId: 0, temporarilyUnavailable: false, prizeId: 700,
                unlocked: true, // this lane is done → lane prize unlocked
              },
            ],
          },
          {
            label: 'Agents',
            items: [
              tutorial({ imsId: 31, title: 'Agents lane still going', status: '', unlocked: true }),
            ],
          },
        ],
      },
      {
        // Downstream join: needs ALL lanes → still locked while Agents is open.
        order: 20, kind: 'linear', items: [
          {
            imsId: 32, title: 'Grand finale checkpoint', type: 'CHECKPOINT', status: '', progress: 0,
            experience: '', timeToComplete: 0, url: '', description: '',
            recordId: 0, temporarilyUnavailable: false, unlocked: false,
          },
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

// #2889: isTrackComplete / progressPercent over segment payloads. These
// aggregates drive the overview grid (completion badge + progress ring); the
// functions aren't exported, so we assert through the rendered card.
describe('AppSpace track completion aggregate (#2889)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  function mountFor(eventId: number, body: unknown) {
    stubFetch((url) => {
      if (url.includes('getAppSpaceProgress')) return { ok: true, status: 200, body }
      return { ok: false, status: 404, body: {} }
    })
    window.history.replaceState({}, '', `/app-space/?eventId=${eventId}`)
    return mount(AppSpace)
  }

  it('does NOT complete the track when only a non-terminal plain checkpoint is unlocked', async () => {
    // Mid checkpoint (order 20) unlocked, but downstream tutorial + terminal
    // checkpoint (order 40) are not → track must read incomplete. This is the
    // exact latent bug the old `checkpoints.some(unlocked)` rule hit.
    const wrapper = mountFor(10000008, nonTerminalCheckpointPayload(true, false))
    await flushPromises()
    expect(wrapper.find('.track-card--complete').exists()).toBe(false)
    expect(wrapper.find('.track-card__badge').exists()).toBe(false)
    // 1 of 2 tutorials done → 50%.
    expect(wrapper.find('.progress-ring-text').text()).toBe('50%')
  })

  it('completes the track when the terminal (highest-order) checkpoint unlocks', async () => {
    const wrapper = mountFor(10000008, nonTerminalCheckpointPayload(true, true))
    await flushPromises()
    expect(wrapper.find('.track-card--complete').exists()).toBe(true)
    expect(wrapper.find('.track-card__badge').exists()).toBe(true)
    expect(wrapper.find('.progress-ring-text').text()).toBe('100%')
  })

  it('completes the track when a lane-prize checkpoint unlocks, even with a locked downstream checkpoint', async () => {
    // Lane prize (prizeId) unlocked because its lane finished; the downstream
    // join checkpoint is still LOCKED. Prize-aware rule → complete. Reverting to
    // the old `checkpoints.some(unlocked)` would also pass here, but reverting to
    // a naive highest-order-only rule would (wrongly) fail — this guards both.
    const wrapper = mountFor(10000009, lanePrizeOnlyPayload())
    await flushPromises()
    expect(wrapper.find('.track-card--complete').exists()).toBe(true)
    expect(wrapper.find('.track-card__badge').exists()).toBe(true)
    // MCP lane tutorial done, Agents lane not → 1 of 2 = 50%.
    expect(wrapper.find('.progress-ring-text').text()).toBe('50%')
  })

  it('does NOT complete the fork track while every checkpoint is locked', async () => {
    const wrapper = mountFor(10000006, forkPayload(true, false))
    await flushPromises()
    expect(wrapper.find('.track-card--complete').exists()).toBe(false)
    // Setup tutorial done, both lane tutorials incomplete → 1 of 3 = 33%.
    expect(wrapper.find('.progress-ring-text').text()).toBe('33%')
  })
})
