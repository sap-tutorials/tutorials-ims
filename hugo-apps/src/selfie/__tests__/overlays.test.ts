// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'

const transformerNodesCalls: any[][] = []
let lastTransformer: any = null
const textCtorArgs: any[] = []
let stageClickHandler: ((e: any) => void) | null = null

vi.mock('konva', () => {
  class Node {
    attrs: Record<string, any> = {}
    _handlers: Record<string, (e: any) => void> = {}
    _destroyed = false
    setAttr(k: string, v: any) { this.attrs[k] = v; return this }
    getAttr(k: string) { return this.attrs[k] }
    on(evt: string, cb: (e: any) => void) { evt.split(' ').forEach((e) => { this._handlers[e] = cb }); return this }
    offset() { return { x: 0, y: 0 } }
    width() { return 100 } height() { return 100 }
    text(v?: string) { if (v !== undefined) this.attrs.text = v; return this.attrs.text }
    offsetX(v?: number) { if (v !== undefined) this.attrs.offsetX = v; return this }
    offsetY(v?: number) { if (v !== undefined) this.attrs.offsetY = v; return this }
    destroy() { this._destroyed = true }
    fire(evt: string, e: any) { this._handlers[evt]?.(e) }
  }
  class KImage extends Node { constructor(cfg?: any) { super(); Object.assign(this.attrs, cfg) } }
  class KText extends Node { constructor(cfg?: any) { super(); textCtorArgs.push(cfg); Object.assign(this.attrs, cfg) } }
  class Layer { add = vi.fn(); draw = vi.fn(); batchDraw = vi.fn() }
  class Stage {
    _handlers: Record<string, (e: any) => void> = {}
    add = vi.fn()
    width() { return 1080 } height() { return 1080 }
    on(evt: string, cb: (e: any) => void) { evt.split(' ').forEach((e) => { this._handlers[e] = cb }); if (evt.includes('click')) stageClickHandler = cb }
    fire(evt: string, e: any) { this._handlers[evt]?.(e) }
  }
  class Transformer extends Node {
    _visible = true
    constructor() { super(); lastTransformer = this }
    nodes(v?: any[]) { if (v !== undefined) transformerNodesCalls.push(v); return v }
    visible() { return this._visible }
    hide() { this._visible = false } show() { this._visible = true }
  }
  const K = { Stage, Layer, Image: KImage, Text: KText, Transformer, Node }
  return { default: K, ...K }
})

import Konva from 'konva'
import { createOverlayManager } from '../overlays'

function fakeImg(): HTMLImageElement {
  return { naturalWidth: 200, naturalHeight: 200, width: 200, height: 200 } as unknown as HTMLImageElement
}
function build() {
  const stage = new (Konva as any).Stage()
  const layer = new (Konva as any).Layer()
  return { stage, layer, mgr: createOverlayManager(stage, layer) }
}

beforeEach(() => {
  transformerNodesCalls.length = 0
  textCtorArgs.length = 0
  lastTransformer = null
  stageClickHandler = null
})

describe('OverlayManager', () => {
  it('adds a sticker, adds it to the layer, and selects it', () => {
    const { layer, mgr } = build()
    mgr.addSticker(fakeImg())
    expect(layer.add).toHaveBeenCalled()
    // last transformer.nodes([]) call has exactly one node (the sticker)
    expect(transformerNodesCalls.at(-1)).toHaveLength(1)
  })

  it('adds an emoji as a Text glyph and selects it', () => {
    const { mgr } = build()
    mgr.addEmoji('🎃')
    expect(textCtorArgs.at(-1).text).toBe('🎃')
    expect(transformerNodesCalls.at(-1)).toHaveLength(1)
  })

  it('caption is a singleton — a second addCaption reselects, does not duplicate', () => {
    const { mgr } = build()
    mgr.addCaption('#Devtoberfest')
    const captionTextNodes = textCtorArgs.filter((c) => c.fontStyle === 'bold').length
    mgr.addCaption('#Devtoberfest')
    const after = textCtorArgs.filter((c) => c.fontStyle === 'bold').length
    expect(captionTextNodes).toBe(1)
    expect(after).toBe(1) // no new caption node constructed
    expect(mgr.hasCaption()).toBe(true)
  })

  it('updateCaption mutates the caption text; no-op when no caption', () => {
    const { mgr } = build()
    expect(() => mgr.updateCaption('later')).not.toThrow() // no caption yet
    mgr.addCaption('#Devtoberfest')
    const captionNode = transformerNodesCalls.at(-1)?.[0]
    mgr.updateCaption('I met an advocate!')
    expect(mgr.selectedIsCaption()).toBe(true)
    expect(captionNode.text()).toBe('I met an advocate!')
  })

  it('deleteSelected removes the node and clears hasCaption for a caption', () => {
    const { mgr } = build()
    mgr.addCaption('#Devtoberfest')
    expect(mgr.hasCaption()).toBe(true)
    mgr.deleteSelected()
    expect(mgr.hasCaption()).toBe(false)
    expect(transformerNodesCalls.at(-1)).toHaveLength(0) // deselected
  })

  it('clicking empty stage deselects', () => {
    const { stage, mgr } = build()
    mgr.addEmoji('🎉')
    expect(transformerNodesCalls.at(-1)).toHaveLength(1)
    stage.fire('click', { target: stage }) // click empty canvas
    expect(transformerNodesCalls.at(-1)).toHaveLength(0)
  })

  it('onSelectionChange reports the kind on add and deselect', () => {
    const { stage, mgr } = build()
    const kinds: string[] = []
    mgr.onSelectionChange((k) => kinds.push(k))
    mgr.addSticker(fakeImg())
    mgr.addCaption('#Devtoberfest')
    stage.fire('click', { target: stage })
    expect(kinds).toEqual(['sticker', 'caption', 'none'])
  })

  it('hideTransformer returns prior visibility and hides; showTransformer restores', () => {
    const { mgr } = build()
    expect(mgr.hideTransformer()).toBe(true)
    expect(lastTransformer.visible()).toBe(false)
    mgr.showTransformer()
    expect(lastTransformer.visible()).toBe(true)
  })
})
