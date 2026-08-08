// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Frame natural dimensions the mocked Konva.Image.fromURL reports. Tests set
// this before calling buildStage to exercise aspect-ratio handling.
let frameDims = { w: 1080, h: 1080 }

const addMock = vi.fn()
const layerAddMock = vi.fn()
// Records every Konva.Layer instance in construction order so tests can assert
// which layer is first (bottom-most) and inspect its per-instance add calls.
const layers: any[] = []
const toBlobMock = vi.fn((opts: any) => opts.callback(new Blob(['png'], { type: 'image/png' })))
const stageCtorArgs: any[] = []
const imageCtorArgs: any[] = []
// Records the frame image's listening() calls so we can assert it is made
// non-interactive (transparent overlay frames must not eat pointer events).
const imageListeningCalls: boolean[] = []
// Tracks all Konva.Transformer instances so we can assert both the cutout and
// overlay transformers are hidden during rasterization and restored afterwards.
const transformers: any[] = []
// The last Konva.Image constructed WITH a config — i.e. the draggable cutout
// node (the frame node comes in via fromURL with no config). Lets setImage
// tests assert the bitmap is swapped in place.
let lastCutoutNode: any = null

vi.mock('konva', () => {
  class Stage {
    _w: number; _h: number
    constructor(cfg: any) { stageCtorArgs.push(cfg); this._w = cfg.width; this._h = cfg.height }
    add = addMock; toBlob = toBlobMock; destroy = vi.fn(); on = vi.fn()
    // Returns a fake composite canvas whose toBlob yields a border-sized blob.
    toCanvas = vi.fn(() => ({
      width: this._w,
      height: this._h,
      toBlob: (cb: (b: Blob | null) => void) => cb(new Blob(['bordered-png-larger'], { type: 'image/png' })),
    }))
    width() { return this._w } height() { return this._h }
  }
  class Layer {
    _addCalls: any[] = []
    add = vi.fn((node: any) => { this._addCalls.push(node); layerAddMock(node) })
    draw = vi.fn(); batchDraw = vi.fn(); listening = vi.fn()
    constructor() { layers.push(this) }
  }
  class KImage {
    _listening = true
    _image: any = null
    _attrs: any = {}
    imageCalls: any[] = []
    constructor(cfg?: any) { if (cfg) { imageCtorArgs.push(cfg); this._image = cfg.image; lastCutoutNode = this } }
    setAttrs = vi.fn()
    on = vi.fn()
    setAttr(k: string, v: any) { this._attrs[k] = v }
    getAttr(k: string) { return this._attrs[k] }
    offsetX = vi.fn()
    offsetY = vi.fn()
    destroy = vi.fn()
    text = vi.fn()
    listening(v?: boolean) { if (v !== undefined) { this._listening = v; imageListeningCalls.push(v) } return this._listening }
    image(v?: any) { if (v !== undefined) { this._image = v; this.imageCalls.push(v) } return this._image }
    width() { return frameDims.w }
    height() { return frameDims.h }
  }
  ;(KImage as any).fromURL = (_u: string, cb: (n: any) => void) =>
    cb(new (KImage as any)())
  class KText {
    attrs: any = {}
    constructor(cfg?: any) { if (cfg) this.attrs = { ...cfg } }
    on = vi.fn()
    setAttr(k: string, v: any) { this.attrs[k] = v }
    getAttr(k: string) { return this.attrs[k] }
    offsetX = vi.fn()
    offsetY = vi.fn()
    destroy = vi.fn()
    text = vi.fn()
    width() { return 100 }
    height() { return 100 }
  }
  class Transformer {
    _visible = true
    events: string[] = []
    nodes = vi.fn()
    destroy = vi.fn()
    constructor() { transformers.push(this) }
    visible() { return this._visible }
    hide() { this._visible = false; this.events.push('hide') }
    show() { this._visible = true; this.events.push('show') }
  }
  return { default: { Stage, Layer, Image: KImage, Transformer, Text: KText }, Stage, Layer, Image: KImage, Transformer, Text: KText }
})

const paintPolaroidMock = vi.fn((composite: any) => ({
  width: composite.width + 100,
  height: composite.height + 270,
  toBlob: (cb: (b: Blob | null) => void) => cb(new Blob(['x'.repeat(5000)], { type: 'image/png' })),
}))
vi.mock('../polaroid', () => ({
  paintPolaroid: (c: any, o: any) => paintPolaroidMock(c, o),
  POLAROID_STYLES: {}, POLAROID_STYLE_IDS: ['classic', 'devtoberfest', 'joule'],
}))

const applyEffectMock = vi.fn((canvas: any) => canvas)
vi.mock('../effects', () => ({
  applyEffect: (c: any, id: any) => applyEffectMock(c, id),
}))

import { buildStage } from '../compose'
import { STAGE_WIDTH, STAGE_HEIGHT } from '../constants'

beforeEach(() => {
  frameDims = { w: 1080, h: 1080 }
  addMock.mockClear(); layerAddMock.mockClear()
  stageCtorArgs.length = 0; imageCtorArgs.length = 0
  imageListeningCalls.length = 0; transformers.length = 0
  layers.length = 0
  lastCutoutNode = null
  paintPolaroidMock.mockClear()
  applyEffectMock.mockClear()
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
    // Cutout transformer (transformers[0]) is visible before export.
    expect(transformers[0].visible()).toBe(true)
    let visibleAtRasterize: boolean | null = null
    toBlobMock.mockImplementationOnce((opts: any) => {
      // Capture visibility at the moment the PNG is rasterized.
      visibleAtRasterize = transformers[0].visible()
      opts.callback(new Blob(['png'], { type: 'image/png' }))
    })
    const out = await stage.exportPng()
    expect(out).toBeInstanceOf(Blob)
    // Hidden while the bitmap was produced (no selection box baked in)…
    expect(visibleAtRasterize).toBe(false)
    // …and restored so the user can keep editing.
    expect(transformers[0].visible()).toBe(true)
    expect(transformers[0].events).toEqual(['hide', 'show'])
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

  it('adds a sticker to the overlays layer and re-exports overlay methods', async () => {
    const stage = await buildStage(document.createElement('div'), '/f.png')
    expect(typeof stage.addSticker).toBe('function')
    expect(typeof stage.addCaption).toBe('function')
    stage.addCaption('#Devtoberfest')
    expect(stage.hasCaption()).toBe(true)
  })

  it('export hides BOTH the cutout and overlay transformers, then restores both', async () => {
    const stage = await buildStage(document.createElement('div'), '/f.png')
    stage.addCutout(fakeImg(1280, 720))
    stage.addEmoji('🎉')
    // both transformers visible before export
    expect(transformers.every((t) => t.visible())).toBe(true)
    let allHiddenAtRasterize = false
    toBlobMock.mockImplementationOnce((opts: any) => {
      allHiddenAtRasterize = transformers.every((t) => !t.visible())
      opts.callback(new Blob(['png'], { type: 'image/png' }))
    })
    await stage.exportPng()
    expect(allHiddenAtRasterize).toBe(true)      // no handles baked in
    expect(transformers.every((t) => t.visible())).toBe(true) // restored
  })

  it('exportPng() with no effect/border does NOT invoke applyEffect or paintPolaroid', async () => {
    const stage = await buildStage(document.createElement('div'), '/f.png')
    const out = await stage.exportPng()
    expect(out).toBeInstanceOf(Blob)
    expect(applyEffectMock).not.toHaveBeenCalled()
    expect(paintPolaroidMock).not.toHaveBeenCalled()
  })

  it('exportPng({ border }) routes the composite canvas through paintPolaroid', async () => {
    const stage = await buildStage(document.createElement('div'), '/f.png')
    const out = await stage.exportPng({ border: { style: 'joule', name: 'Tom' } })
    expect(out).toBeInstanceOf(Blob)
    expect(paintPolaroidMock).toHaveBeenCalledTimes(1)
    expect(paintPolaroidMock.mock.calls[0][1]).toEqual({ style: 'joule', name: 'Tom' })
  })

  it('border export still hides BOTH transformers during rasterization, then restores', async () => {
    const stage = await buildStage(document.createElement('div'), '/f.png')
    stage.addCutout(fakeImg(1280, 720))
    stage.addEmoji('🎉')
    expect(transformers.every((t) => t.visible())).toBe(true)
    let allHiddenAtBake = false
    paintPolaroidMock.mockImplementationOnce((composite: any) => {
      allHiddenAtBake = transformers.every((t) => !t.visible())
      return { width: composite.width, height: composite.height, toBlob: (cb: any) => cb(new Blob(['b'], { type: 'image/png' })) }
    })
    await stage.exportPng({ border: { style: 'classic', name: '' } })
    expect(allHiddenAtBake).toBe(true)
    expect(transformers.every((t) => t.visible())).toBe(true)
  })

  it('exportPng({ effect }) routes the composite through applyEffect once with the id (canvas path, no border)', async () => {
    const stage = await buildStage(document.createElement('div'), '/f.png')
    const out = await stage.exportPng({ effect: 'mono' })
    expect(out).toBeInstanceOf(Blob)
    expect(applyEffectMock).toHaveBeenCalledTimes(1)
    expect(applyEffectMock.mock.calls[0][1]).toBe('mono')
    expect(paintPolaroidMock).not.toHaveBeenCalled() // no border → effect-only canvas path
  })

  it('exportPng({ effect: "none" }) takes the fast toBlob path — no applyEffect, no paintPolaroid', async () => {
    const stage = await buildStage(document.createElement('div'), '/f.png')
    const out = await stage.exportPng({ effect: 'none' })
    expect(out).toBeInstanceOf(Blob)
    expect(applyEffectMock).not.toHaveBeenCalled()
    expect(paintPolaroidMock).not.toHaveBeenCalled()
  })

  it('bakes the effect BEFORE the polaroid border when both are set', async () => {
    const stage = await buildStage(document.createElement('div'), '/f.png')
    await stage.exportPng({ effect: 'duotone', border: { style: 'classic', name: '' } })
    expect(applyEffectMock).toHaveBeenCalledTimes(1)
    expect(paintPolaroidMock).toHaveBeenCalledTimes(1)
    // effect runs first: its invocation order precedes paintPolaroid's
    expect(applyEffectMock.mock.invocationCallOrder[0])
      .toBeLessThan(paintPolaroidMock.mock.invocationCallOrder[0])
  })
})

describe('setBackground', () => {
  it('adds a background layer to the stage BEFORE the cutout layer (bottom-most)', async () => {
    await buildStage(document.createElement('div'), '/f.png')
    // layers[] records every Konva.Layer in construction order.
    // The bgLayer must be added to the stage first — index 0 in addMock.calls.
    // addMock records each layer passed to stage.add() in call order.
    const layersAddedToStage = addMock.mock.calls.map((c) => c[0])
    // bgLayer is the first layer added to the stage (bottom-most).
    expect(layersAddedToStage[0]).toBe(layers[0])
  })

  it('setBackground(img) adds one Konva.Image sized to the full stage, listening(false)', async () => {
    frameDims = { w: 1080, h: 1080 }
    const stage = await buildStage(document.createElement('div'), '/f.png')
    const bgLayer = layers[0]
    const img = fakeImg(800, 600)
    stage.setBackground(img)
    // One image node added to bgLayer
    expect(bgLayer._addCalls).toHaveLength(1)
    // Node was constructed with the stage dimensions and listening:false
    const nodeCfg = imageCtorArgs.find((c) => c.image === img)
    expect(nodeCfg).toBeDefined()
    expect(nodeCfg.x).toBe(0)
    expect(nodeCfg.y).toBe(0)
    expect(nodeCfg.width).toBe(1080)
    expect(nodeCfg.height).toBe(1080)
    expect(nodeCfg.listening).toBe(false)
  })

  it('setBackground(img) called twice replaces the node, not stacks it', async () => {
    const stage = await buildStage(document.createElement('div'), '/f.png')
    const bgLayer = layers[0]
    const img1 = fakeImg(800, 600)
    const img2 = fakeImg(800, 600)
    stage.setBackground(img1)
    const firstNode = bgLayer._addCalls[0]
    stage.setBackground(img2)
    // First node was destroyed
    expect(firstNode.destroy).toHaveBeenCalled()
    // bg layer has exactly one image node (the replacement)
    expect(bgLayer._addCalls).toHaveLength(2)
    // The second node uses img2
    const secondNodeCfg = imageCtorArgs.find((c) => c.image === img2)
    expect(secondNodeCfg).toBeDefined()
  })

  it('setBackground(null) clears the background node', async () => {
    const stage = await buildStage(document.createElement('div'), '/f.png')
    const bgLayer = layers[0]
    const img = fakeImg(800, 600)
    stage.setBackground(img)
    const node = bgLayer._addCalls[0]
    stage.setBackground(null)
    // The node was destroyed
    expect(node.destroy).toHaveBeenCalled()
    // No further nodes added to bg layer after null
    expect(bgLayer._addCalls).toHaveLength(1)
  })
})
