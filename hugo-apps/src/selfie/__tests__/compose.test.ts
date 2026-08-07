// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Frame natural dimensions the mocked Konva.Image.fromURL reports. Tests set
// this before calling buildStage to exercise aspect-ratio handling.
let frameDims = { w: 1080, h: 1080 }

const addMock = vi.fn()
const layerAddMock = vi.fn()
const toBlobMock = vi.fn((opts: any) => opts.callback(new Blob(['png'], { type: 'image/png' })))
const stageCtorArgs: any[] = []
const imageCtorArgs: any[] = []

vi.mock('konva', () => {
  class Stage {
    _w: number; _h: number
    constructor(cfg: any) { stageCtorArgs.push(cfg); this._w = cfg.width; this._h = cfg.height }
    add = addMock; toBlob = toBlobMock; destroy = vi.fn()
    width() { return this._w } height() { return this._h }
  }
  class Layer { add = layerAddMock; draw = vi.fn(); batchDraw = vi.fn() }
  class KImage {
    constructor(cfg?: any) { if (cfg) imageCtorArgs.push(cfg) }
    setAttrs = vi.fn()
    width() { return frameDims.w }
    height() { return frameDims.h }
  }
  ;(KImage as any).fromURL = (_u: string, cb: (n: any) => void) =>
    cb(new (KImage as any)())
  class Transformer { nodes = vi.fn() }
  return { default: { Stage, Layer, Image: KImage, Transformer }, Stage, Layer, Image: KImage, Transformer }
})

import { buildStage } from '../compose'
import { STAGE_WIDTH, STAGE_HEIGHT } from '../constants'

beforeEach(() => {
  frameDims = { w: 1080, h: 1080 }
  addMock.mockClear(); layerAddMock.mockClear()
  stageCtorArgs.length = 0; imageCtorArgs.length = 0
})

function fakeImg(w: number, h: number): HTMLImageElement {
  return { naturalWidth: w, naturalHeight: h, width: w, height: h } as unknown as HTMLImageElement
}

describe('compose.buildStage', () => {
  it('builds a stage and exports a PNG blob', async () => {
    const stage = await buildStage(document.createElement('div'), '/images/devtoberfest/selfie/frames/Thomas.png')
    const out = await stage.exportPng()
    expect(out).toBeInstanceOf(Blob)
    expect(out.type).toBe('image/png')
    expect(addMock).toHaveBeenCalled() // layers added to stage
  })

  it('sizes the stage to the frame aspect ratio (no stretch) within the max box', async () => {
    frameDims = { w: 1929, h: 1000 } // wide frame (ratio ~1.929)
    await buildStage(document.createElement('div'), '/f.png')
    const { width, height } = stageCtorArgs[0]
    // longest side clamps to the max box; aspect preserved
    expect(width).toBe(STAGE_WIDTH)
    expect(height).toBe(Math.round((1000 / 1929) * STAGE_WIDTH))
    expect(width / height).toBeCloseTo(1929 / 1000, 2)
  })

  it('portrait frame keeps its aspect (height clamps to the box)', async () => {
    frameDims = { w: 767, h: 1000 } // portrait frame (ratio ~0.767)
    await buildStage(document.createElement('div'), '/f.png')
    const { width, height } = stageCtorArgs[0]
    expect(height).toBe(STAGE_HEIGHT)
    expect(width).toBe(Math.round((767 / 1000) * STAGE_HEIGHT))
  })

  it('fits the cutout inside the stage (contain) and centers it — never overflows', async () => {
    frameDims = { w: 1080, h: 1080 } // square stage 1080x1080
    const stage = await buildStage(document.createElement('div'), '/f.png')
    stage.addCutout(fakeImg(1280, 720)) // landscape camera capture
    const cfg = imageCtorArgs[0]
    // contain scale = min(1080/1280, 1080/720) = 0.84375 → w=1080, h=608
    expect(cfg.width).toBe(1080)
    expect(cfg.height).toBe(608)
    // fits within the stage on both axes
    expect(cfg.width).toBeLessThanOrEqual(1080)
    expect(cfg.height).toBeLessThanOrEqual(1080)
    // centered
    expect(cfg.x).toBe(Math.round((1080 - cfg.width) / 2))
    expect(cfg.y).toBe(Math.round((1080 - cfg.height) / 2))
    expect(cfg.draggable).toBe(true)
  })
})
