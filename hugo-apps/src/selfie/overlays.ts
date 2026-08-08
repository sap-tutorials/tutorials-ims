// hugo-apps/src/selfie/overlays.ts
import Konva from 'konva'

export type OverlayKind = 'none' | 'sticker' | 'caption'

export interface OverlayManager {
  addSticker(img: HTMLImageElement): void
  addEmoji(char: string): void
  addCaption(text: string): void
  updateCaption(text: string): void
  hasCaption(): boolean
  selectedIsCaption(): boolean
  deleteSelected(): void
  deselect(): void
  onSelectionChange(cb: (kind: OverlayKind) => void): void
  hideTransformer(): boolean
  showTransformer(): void
  destroy(): void
}

export function createOverlayManager(stage: Konva.Stage, layer: Konva.Layer): OverlayManager {
  const transformer = new Konva.Transformer()
  layer.add(transformer)

  let selected: Konva.Node | null = null
  let captionNode: Konva.Text | null = null
  let selectionCb: (kind: OverlayKind) => void = () => {}

  function kindOf(node: Konva.Node | null): OverlayKind {
    if (!node) return 'none'
    return (node.getAttr('data-kind') as OverlayKind) || 'sticker'
  }

  function select(node: Konva.Node) {
    selected = node
    transformer.nodes([node])
    layer.batchDraw()
    selectionCb(kindOf(node))
  }

  function deselect() {
    selected = null
    transformer.nodes([])
    layer.batchDraw()
    selectionCb('none')
  }

  // Deselect when the user taps empty canvas.
  stage.on('click tap', (e: any) => { if (e.target === stage) deselect() })

  function wire(node: Konva.Node, kind: OverlayKind) {
    node.setAttr('data-kind', kind)
    node.on('click tap', (e: any) => { e.cancelBubble = true; select(node) })
    layer.add(node as any)
    select(node)
  }

  function centerOf() { return { x: stage.width() / 2, y: stage.height() / 2 } }

  return {
    addSticker(img: HTMLImageElement) {
      const w = img.naturalWidth || img.width || 200
      const h = img.naturalHeight || img.height || 200
      const scale = Math.min((stage.width() * 0.4) / w, (stage.height() * 0.4) / h, 1)
      const dw = Math.round(w * scale)
      const dh = Math.round(h * scale)
      const c = centerOf()
      const node = new Konva.Image({
        image: img, draggable: true,
        width: dw, height: dh, offsetX: dw / 2, offsetY: dh / 2, x: c.x, y: c.y,
      })
      wire(node, 'sticker')
    },
    addEmoji(char: string) {
      const c = centerOf()
      const node = new Konva.Text({
        text: char, fontSize: Math.round(stage.height() * 0.15),
        draggable: true, x: c.x, y: c.y,
      })
      // Center the glyph on the placement point.
      node.offsetX((node.width?.() || 0) / 2)
      node.offsetY((node.height?.() || 0) / 2)
      wire(node, 'sticker')
    },
    addCaption(text: string) {
      if (captionNode) { select(captionNode); return }
      const c = centerOf()
      const node = new Konva.Text({
        text,
        fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
        fontStyle: 'bold', fontSize: Math.round(stage.height() * 0.07),
        fill: '#ffffff', stroke: '#1d2d3e', strokeWidth: 2, align: 'center',
        draggable: true, x: c.x, y: c.y,
      })
      node.offsetX((node.width?.() || 0) / 2)
      node.offsetY((node.height?.() || 0) / 2)
      captionNode = node
      wire(node, 'caption')
    },
    updateCaption(text: string) {
      if (!captionNode) return
      captionNode.text(text)
      layer.batchDraw()
    },
    hasCaption() { return captionNode !== null },
    selectedIsCaption() { return kindOf(selected) === 'caption' },
    deleteSelected() {
      if (!selected) return
      if (selected === captionNode) captionNode = null
      selected.destroy()
      deselect()
    },
    deselect,
    onSelectionChange(cb) { selectionCb = cb },
    hideTransformer() {
      const prior = transformer.visible()
      transformer.hide()
      return prior
    },
    showTransformer() { transformer.show() },
    destroy() { transformer.destroy() },
  }
}
