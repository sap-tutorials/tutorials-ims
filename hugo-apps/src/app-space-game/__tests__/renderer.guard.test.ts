// @vitest-environment happy-dom
// Module-contract guard for renderer.ts — NO real WebGL.
// Three.js WebGLRenderer is mocked so this test runs in jsdom/node without a GPU.
// Only asserts the exported API shape and that stop() before start() is safe.
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock `three` before importing renderer so WebGLRenderer never hits the real WebGL path.
vi.mock('three', async () => {
  const actual = await vi.importActual<typeof import('three')>('three')
  const MockWebGLRenderer = vi.fn().mockImplementation(() => ({
    setPixelRatio: vi.fn(),
    setSize: vi.fn(),
    render: vi.fn(),
    shadowMap: { enabled: false, type: null },
    domElement: document.createElement('canvas'),
    dispose: vi.fn(),
  }))
  return { ...actual, WebGLRenderer: MockWebGLRenderer }
})

describe('renderer module contract', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('createGame is a function', async () => {
    const { createGame } = await import('../renderer')
    expect(typeof createGame).toBe('function')
  })

  it('createGame returns an object with start/stop/setPlayerControl methods', async () => {
    const { createGame } = await import('../renderer')
    const canvas = document.createElement('canvas')
    const model = { zones: [] }
    const game = createGame(canvas, model, { onPickTrack: () => {} })
    expect(typeof game.start).toBe('function')
    expect(typeof game.stop).toBe('function')
    expect(typeof game.setPlayerControl).toBe('function')
  })

  it('stop() before start() does not throw', async () => {
    const { createGame } = await import('../renderer')
    const canvas = document.createElement('canvas')
    const model = { zones: [] }
    const game = createGame(canvas, model, { onPickTrack: () => {} })
    expect(() => game.stop()).not.toThrow()
  })

  it('setPlayerControl() is callable without start()', async () => {
    const { createGame } = await import('../renderer')
    const canvas = document.createElement('canvas')
    const model = { zones: [] }
    const game = createGame(canvas, model, { onPickTrack: () => {} })
    expect(() => game.setPlayerControl(true)).not.toThrow()
    expect(() => game.setPlayerControl(false)).not.toThrow()
  })

  it('createGame is safe when WebGLRenderer throws (defensive gate)', async () => {
    const three = await import('three')
    vi.mocked(three.WebGLRenderer).mockImplementationOnce(() => {
      throw new Error('WebGL not supported')
    })
    const { createGame } = await import('../renderer')
    const canvas = document.createElement('canvas')
    const model = { zones: [] }
    // Should not throw - returns a safe no-op object
    expect(() => {
      const game = createGame(canvas, model, { onPickTrack: () => {} })
      game.stop()
    }).not.toThrow()
  })
})
