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
// Records the frame image's listening() calls so we can assert it is made
// non-interactive (transparent overlay frames must not eat pointer events).
const imageListeningCalls: boolean[] = []
// Tracks the transformer's visibility across the export so we can assert the
// selection UI is hidden during rasterization and restored afterwards.
const transformerEvents: string[] = []
let lastTransformer: any = null
// The last Konva.Image constructed WITH a config — i.e. the draggable cutout
// node (the frame node comes in via fromURL with no config). Lets setImage
// tests assert the bitmap is swapped in place.
let lastCutoutNode: any = null

vi.mock('konva', () => {
  class Stage {
    _w: number; _h: number
    constructor(cfg: any) { stageCtorArgs.push(cfg); this._w = cfg.width; this._h = cfg.height }
    add = addMock; toBlob = toBlobMock; destroy = vi.fn()
    width() { return this._w } height() { return this._h }
  }
  class Layer { add = layerAddMock; draw = vi.fn(); batchDraw = vi.fn(); listening = vi.fn() }
  class KImage {
    _listening = true
    _image: any = null
    imageCalls: any[] = []
    constructor(cfg?: any) { if (cfg) { imageCtorArgs.push(cfg); this._image = cfg.image; lastCutoutNode = this } }
    setAttrs = vi.fn()
    listening(v?: boolean) { if (v !== undefined) { this._listening = v; imageListeningCalls.push(v) } return this._listening }
    image(v?: any) { if (v !== undefined) { this._image = v; this.imageCalls.push(v) } return this._image }
    width() { return frameDims.w }
    height() { return frameDims.h }
  }
  ;(KImage as any).fromURL = (_u: string, cb: (n: any) => void) =>
    cb(new (KImage as any)())
  class Transformer {
    _visible = true
    nodes = vi.fn()
    constructor() { lastTransformer = this }
    visible() { return this._visible }
    hide() { this._visible = false; transformerEvents.push('hide') }
    show() { this._visible = true; transformerEvents.push('show') }
  }
  return { default: { Stage, Layer, Image: KImage, Transformer }, Stage, Layer, Image: KImage, Transformer }
})

import { buildStage } from '../compose'
import { STAGE_WIDTH, STAGE_HEIGHT } from '../constants'

beforeEach(() => {
  frameDims = { w: 1080, h: 1080 }
  addMock.mockClear(); layerAddMock.mockClear()
  stageCtorArgs.length = 0; imageCtorArgs.length = 0
  imageListeningCalls.length = 0; transformerEvents.length = 0
  lastTransformer = null
  lastCutoutNode = null
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

  it('makes the decorative frame non-interactive so it does not eat pointer events', async () => {
    // A transparent overlay frame drawn in front of the cutout must not swallow
    // drags/transforms — its whole bounding box is otherwise a hit region.
    await buildStage(document.createElement('div'), '/f.png')
    expect(imageListeningCalls).toContain(false)
  })

  it('hides the transformer during export and restores it afterwards', async () => {
    const stage = await buildStage(document.createElement('div'), '/f.png')
    stage.addCutout(fakeImg(1280, 720))
    // Transformer is visible before export.
    expect(lastTransformer.visible()).toBe(true)
    let visibleAtRasterize: boolean | null = null
    toBlobMock.mockImplementationOnce((opts: any) => {
      // Capture visibility at the moment the PNG is rasterized.
      visibleAtRasterize = lastTransformer.visible()
      opts.callback(new Blob(['png'], { type: 'image/png' }))
    })
    const out = await stage.exportPng()
    expect(out).toBeInstanceOf(Blob)
    // Hidden while the bitmap was produced (no selection box baked in)…
    expect(visibleAtRasterize).toBe(false)
    // …and restored so the user can keep editing.
    expect(lastTransformer.visible()).toBe(true)
    expect(transformerEvents).toEqual(['hide', 'show'])
  })

  it('setImage swaps the cutout bitmap in place without rebuilding', async () => {
    const stage = await buildStage(document.createElement('div'), '/f.png')
    const original = fakeImg(1280, 720)
    stage.addCutout(original)
    const node = lastCutoutNode
    expect(node.image()).toBe(original) // starts on the first cutout
    const swapped = fakeImg(1280, 720)
    stage.setImage(swapped)
    // Same node, new bitmap — no new Konva.Image was constructed for the swap.
    expect(node.image()).toBe(swapped)
    expect(node.imageCalls).toEqual([swapped])
    expect(lastCutoutNode).toBe(node)
  })

  it('setImage is a no-op before any cutout is added', async () => {
    const stage = await buildStage(document.createElement('div'), '/f.png')
    // No addCutout yet → nothing to swap, must not throw.
    expect(() => stage.setImage(fakeImg(100, 100))).not.toThrow()
  })
})
