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

export async function buildStage(
  container: HTMLDivElement,
  frameUrl: string,
  opts?: { layering?: 'overlay' | 'background' },
): Promise<SelfieStage> {
  const layering = opts?.layering ?? FRAME_LAYERING
  const stage = new Konva.Stage({ container, width: STAGE_WIDTH, height: STAGE_HEIGHT })
  const frameLayer = new Konva.Layer()
  const cutoutLayer = new Konva.Layer()

  const frameNode = await loadKImage(frameUrl)
  frameNode.setAttrs({ x: 0, y: 0, width: STAGE_WIDTH, height: STAGE_HEIGHT })
  frameLayer.add(frameNode)

  // Layer order per Task 1 decision:
  //   background → frame behind, cutout on top; overlay → cutout behind, frame in front.
  if (layering === 'background') { stage.add(frameLayer); stage.add(cutoutLayer) }
  else { stage.add(cutoutLayer); stage.add(frameLayer) }

  const transformer = new Konva.Transformer()
  cutoutLayer.add(transformer)

  return {
    addCutout(img: HTMLImageElement) {
      const node = new Konva.Image({ image: img, draggable: true, x: STAGE_WIDTH / 4, y: STAGE_HEIGHT / 4 })
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
