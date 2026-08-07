import Konva from 'konva'
import { STAGE_WIDTH, STAGE_HEIGHT, FRAME_LAYERING } from './constants'

export interface SelfieStage {
  addCutout(img: HTMLImageElement): void
  exportPng(): Promise<Blob>
  destroy(): void
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
  const frameLayer = new Konva.Layer()
  const cutoutLayer = new Konva.Layer()

  // Frame fills the (aspect-matched) stage exactly — no distortion.
  frameNode.setAttrs({ x: 0, y: 0, width: stageW, height: stageH })
  frameLayer.add(frameNode)

  // Layer order per Task 1 decision:
  //   background → frame behind, cutout on top; overlay → cutout behind, frame in front.
  if (layering === 'background') { stage.add(frameLayer); stage.add(cutoutLayer) }
  else { stage.add(cutoutLayer); stage.add(frameLayer) }

  const transformer = new Konva.Transformer()
  cutoutLayer.add(transformer)

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
      cutoutLayer.add(node)
      transformer.nodes([node])
      cutoutLayer.batchDraw()
    },
    exportPng() {
      return new Promise<Blob>((resolve, reject) => {
        stage.toBlob({ mimeType: 'image/png', callback: (b: Blob | null) => (b ? resolve(b) : reject(new Error('export failed'))) })
      })
    },
    destroy() { stage.destroy() },
  }
}
