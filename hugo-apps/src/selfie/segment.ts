import { IMGLY_PUBLIC_PATH } from './constants'

export async function removeBackground(
  input: Blob,
  onProgress?: (p: number) => void,
): Promise<{ blob: Blob; removed: boolean }> {
  try {
    // Lazy import: the ~76MB model + WASM (isnet_quint8 + onnxruntime-web) must never load on page load.
    const { removeBackground: imglyRemove } = await import('@imgly/background-removal')
    const blob = await imglyRemove(input, {
      publicPath: new URL(IMGLY_PUBLIC_PATH, window.location.origin).href,
      model: 'isnet_quint8',
      progress: (_key: string, current: number, total: number) => {
        if (onProgress && total > 0) onProgress(current / total)
      },
    })
    return { blob, removed: true }
  } catch (e) {
    // Fail-soft: segmentation failure must never block the flow.
    console.warn('[selfie] background removal failed; using original photo', e)
    return { blob: input, removed: false }
  }
}
