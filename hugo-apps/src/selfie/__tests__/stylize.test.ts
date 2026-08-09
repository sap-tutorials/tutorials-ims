// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock onnxruntime-web so no real WASM/model loads in unit tests.
const runMock = vi.fn()
const createMock = vi.fn(async () => ({ run: runMock }))
vi.mock('onnxruntime-web', () => ({
  InferenceSession: { create: createMock },
  Tensor: class { constructor(public type: string, public data: unknown, public dims: number[]) {} },
  env: { wasm: {} },
}))

import { cartoonify } from '../stylize'

// A canvas stub whose 2D context yields predictable pixel data.
function fakeCanvas(w = 256, h = 256): HTMLCanvasElement {
  const ctx = {
    drawImage: vi.fn(),
    getImageData: vi.fn(() => ({ data: new Uint8ClampedArray(512 * 512 * 4).fill(128), width: 512, height: 512 })),
    putImageData: vi.fn(),
  }
  return { width: w, height: h, getContext: vi.fn(() => ctx) } as unknown as HTMLCanvasElement
}

// Reset between tests so each one exercises its own failure mode from a clean
// session state. stylize.ts clears sessionPromise on rejection, so a failed
// test 1 no longer poisons the singleton for tests 2 and 3.
beforeEach(() => { runMock.mockReset(); createMock.mockClear() })

describe('cartoonify fail-soft', () => {
  it('returns the INPUT canvas unchanged when session creation throws', async () => {
    createMock.mockRejectedValueOnce(new Error('no wasm'))
    const c = fakeCanvas()
    expect(await cartoonify(c)).toBe(c)
    // sessionPromise is now null (cleared by the catch in getSession)
    // so the next test starts with a fresh session slot.
  })

  it('returns the INPUT canvas unchanged when inference throws', async () => {
    // createMock resolves (default impl), so this genuinely reaches session.run()
    runMock.mockRejectedValueOnce(new Error('run failed'))
    const c = fakeCanvas()
    expect(await cartoonify(c)).toBe(c)
  })

  it('returns the INPUT canvas unchanged when the 2D context is null', async () => {
    // The internal work canvas's getContext('2d') returns null in happy-dom,
    // triggering the null-context guard inside cartoonify.
    const c = { width: 256, height: 256, getContext: vi.fn(() => null) } as unknown as HTMLCanvasElement
    expect(await cartoonify(c)).toBe(c)
  })
})
