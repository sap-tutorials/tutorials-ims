// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest'

const addMock = vi.fn()
const layerAddMock = vi.fn()
const toBlobMock = vi.fn((opts: any) => opts.callback(new Blob(['png'], { type: 'image/png' })))

vi.mock('konva', () => {
  class Stage { add = addMock; toBlob = toBlobMock; destroy = vi.fn(); width() { return 1080 } height() { return 1080 } }
  class Layer { add = layerAddMock; draw = vi.fn(); batchDraw = vi.fn() }
  class KImage { constructor() {} }
  ;(KImage as any).fromURL = (_u: string, cb: (n: any) => void) => cb({ setAttrs: vi.fn(), width: () => 1080, height: () => 1080 })
  class Transformer { nodes = vi.fn() }
  return { default: { Stage, Layer, Image: KImage, Transformer }, Stage, Layer, Image: KImage, Transformer }
})

import { buildStage } from '../compose'

describe('compose.buildStage', () => {
  it('builds a stage and exports a PNG blob', async () => {
    const container = document.createElement('div')
    const stage = await buildStage(container, '/images/devtoberfest/selfie/frames/Thomas.png')
    const out = await stage.exportPng()
    expect(out).toBeInstanceOf(Blob)
    expect(out.type).toBe('image/png')
    expect(addMock).toHaveBeenCalled() // layers added to stage
  })
})
