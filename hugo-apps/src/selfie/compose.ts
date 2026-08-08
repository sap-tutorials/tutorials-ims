import Konva from 'konva'
import { STAGE_WIDTH, STAGE_HEIGHT, FRAME_LAYERING } from './constants'
import { createOverlayManager, type OverlayKind } from './overlays'
import { paintPolaroid, type PolaroidStyleId } from './polaroid'
import { applyEffect, type EffectId } from './effects'

export interface SelfieStage {
  addCutout(img: HTMLImageElement): void
  /**
   * Swap the current cutout's bitmap in place, keeping its position, scale,
   * rotation and the transformer selection. Used by the live "remove
   * background" toggle to flip between the raw photo and the segmented cutout
   * without rebuilding the stage (which would reset the user's placement).
   * No-op if addCutout was never called.
   */
  setImage(img: HTMLImageElement): void
  /**
   * Set (or clear) the themed background scene drawn on the bottom-most layer,
   * behind the cut-out person. Pass null to remove it. The node fills the stage
   * and is non-interactive. #1520.
   */
  setBackground(img: HTMLImageElement | null): void
  exportPng(opts?: { effect?: EffectId; border?: { style: PolaroidStyleId; name: string } }): Promise<Blob>
  destroy(): void
  addSticker(img: HTMLImageElement): void
  addEmoji(char: string): void
  addCaption(text: string): void
  updateCaption(text: string): void
  hasCaption(): boolean
  selectedIsCaption(): boolean
  deleteSelected(): void
  deselect(): void
  onSelectionChange(cb: (kind: OverlayKind) => void): void
}

function loadKImage(url: string): Promise<Konva.Image> {
  return new Promise((resolve, reject) =>
    Konva.Image.fromURL(url, (node: Konva.Image) => resolve(node), (e) => reject(e)),
  )
}

/**
 * Fit `src` (w×h) inside `box` (w×h) preserving aspect ratio ("contain").
 * Returns the scaled dimensions and the centered top-left offset. Never scales
 * up past 1× and never overflows the box.
 */
function containFit(
  srcW: number, srcH: number, boxW: number, boxH: number,
): { width: number; height: number; x: number; y: number } {
  const scale = Math.min(boxW / srcW, boxH / srcH) || 1
  const width = Math.round(srcW * scale)
  const height = Math.round(srcH * scale)
  return { width, height, x: Math.round((boxW - width) / 2), y: Math.round((boxH - height) / 2) }
}

export async function buildStage(
  container: HTMLDivElement,
  frameUrl: string,
  opts?: { layering?: 'overlay' | 'background' },
): Promise<SelfieStage> {
  const layering = opts?.layering ?? FRAME_LAYERING

  // Load the frame first so the stage can adopt the frame's aspect ratio —
  // forcing every frame into a square stretches non-square advocate frames.
  const frameNode = await loadKImage(frameUrl)
  const fw = frameNode.width() || STAGE_WIDTH
  const fh = frameNode.height() || STAGE_HEIGHT

  // Stage = frame aspect, clamped so the longest side fits the max export box.
  const stageBox = containFit(fw, fh, STAGE_WIDTH, STAGE_HEIGHT)
  const stageW = stageBox.width
  const stageH = stageBox.height

  const stage = new Konva.Stage({ container, width: stageW, height: stageH })

  // Themed background scene (#1520) — bottom-most, behind everything. Added first
  // so it renders under the frame, cutout and overlays regardless of FRAME_LAYERING.
  const bgLayer = new Konva.Layer()
  bgLayer.listening(false)
  stage.add(bgLayer)
  let bgNode: Konva.Image | null = null

  const frameLayer = new Konva.Layer()
  const cutoutLayer = new Konva.Layer()

  // Frame fills the (aspect-matched) stage exactly — no distortion.
  frameNode.setAttrs({ x: 0, y: 0, width: stageW, height: stageH })
  // The frame is purely decorative. A Konva.Image's hit region is its whole
  // bounding box (transparent pixels included), so an 'overlay' frame drawn IN
  // FRONT of the cutout would otherwise swallow every pointer event and the
  // draggable cutout + transformer handles beneath it would never respond.
  frameNode.listening(false)
  frameLayer.add(frameNode)
  // Belt-and-braces: the whole frame layer is non-interactive either way.
  frameLayer.listening(false)

  // Layer order per Task 1 decision:
  //   background → frame behind, cutout on top; overlay → cutout behind, frame in front.
  if (layering === 'background') { stage.add(frameLayer); stage.add(cutoutLayer) }
  else { stage.add(cutoutLayer); stage.add(frameLayer) }

  const transformer = new Konva.Transformer()
  cutoutLayer.add(transformer)

  // Overlays layer sits topmost so stickers/captions render above both cutout and frame.
  const overlaysLayer = new Konva.Layer()
  stage.add(overlaysLayer) // topmost — overlays sit above cutout and frame
  const overlay = createOverlayManager(stage, overlaysLayer)

  // The current cutout node, tracked so setImage can swap its bitmap in place.
  let cutoutNode: Konva.Image | null = null

  return {
    addCutout(img: HTMLImageElement) {
      // Fit the capture inside the stage (contain) and center it, so it is
      // never cut off and its aspect ratio is preserved. The user can still
      // drag / scale / rotate from this starting placement.
      const srcW = img.naturalWidth || img.width || stageW
      const srcH = img.naturalHeight || img.height || stageH
      const fit = containFit(srcW, srcH, stageW, stageH)
      const node = new Konva.Image({
        image: img,
        draggable: true,
        x: fit.x,
        y: fit.y,
        width: fit.width,
        height: fit.height,
      })
      cutoutNode = node
      cutoutLayer.add(node)
      transformer.nodes([node])
      cutoutLayer.batchDraw()
    },
    setImage(img: HTMLImageElement) {
      // Swap the bitmap only. The raw photo and its segmented cutout share the
      // same source dimensions, so the existing contain-fit box still applies —
      // keep the node's position/scale/rotation and the transformer intact.
      if (!cutoutNode) return
      cutoutNode.image(img)
      cutoutLayer.batchDraw()
    },
    setBackground(img: HTMLImageElement | null) {
      if (bgNode) { bgNode.destroy(); bgNode = null }
      if (img) {
        bgNode = new Konva.Image({
          image: img, x: 0, y: 0, width: stageW, height: stageH, listening: false,
        })
        bgLayer.add(bgNode)
      }
      bgLayer.batchDraw()
    },
    exportPng(opts?: { effect?: EffectId; border?: { style: PolaroidStyleId; name: string } }) {
      const effect = opts?.effect
      const border = opts?.border
      // The fast Konva path can only be skipped when we actually need a pixel
      // pass — an active effect (not 'none') or a polaroid border.
      const needsCanvas = (!!effect && effect !== 'none') || !!border
      return new Promise<Blob>((resolve, reject) => {
        overlay.deselect()
        const cutoutTVisible = transformer.visible()
        transformer.hide()
        const overlayTVisible = overlay.hideTransformer()
        cutoutLayer.batchDraw()
        overlaysLayer.batchDraw()
        const restore = () => {
          if (cutoutTVisible) transformer.show()
          if (overlayTVisible) overlay.showTransformer()
          cutoutLayer.batchDraw()
          overlaysLayer.batchDraw()
        }
        if (needsCanvas) {
          try {
            let composite = stage.toCanvas() as HTMLCanvasElement
            // Effect bakes BEFORE the border so the white matte stays untinted.
            if (effect && effect !== 'none') composite = applyEffect(composite, effect)
            const finalCanvas = border ? paintPolaroid(composite, border) : composite
            finalCanvas.toBlob((b: Blob | null) => {
              restore()
              b ? resolve(b) : reject(new Error('export failed'))
            }, 'image/png')
          } catch (e) {
            restore()
            reject(e as Error)
          }
          return
        }
        stage.toBlob({
          mimeType: 'image/png',
          callback: (b: Blob | null) => {
            restore()
            b ? resolve(b) : reject(new Error('export failed'))
          },
        })
      })
    },
    destroy() { overlay.destroy(); stage.destroy() },
    addSticker: (img) => overlay.addSticker(img),
    addEmoji: (char) => overlay.addEmoji(char),
    addCaption: (text) => overlay.addCaption(text),
    updateCaption: (text) => overlay.updateCaption(text),
    hasCaption: () => overlay.hasCaption(),
    selectedIsCaption: () => overlay.selectedIsCaption(),
    deleteSelected: () => overlay.deleteSelected(),
    deselect: () => overlay.deselect(),
    onSelectionChange: (cb) => overlay.onSelectionChange(cb),
  }
}
