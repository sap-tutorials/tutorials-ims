import { ref, type Ref } from 'vue'
import jsQR from 'jsqr'
import { cameraSupported, readCameraEnv } from './camera-support'

declare global {
  interface Window {
    BarcodeDetector?: new (opts?: { formats: string[] }) => {
      detect(source: ImageBitmapSource): Promise<Array<{ rawValue: string }>>
    }
  }
}

export function useBarcodeScanner(videoRef: Ref<HTMLVideoElement | null>) {
  // Camera scanning works whenever getUserMedia is available in a secure
  // context; the native BarcodeDetector is optional (jsQR fallback covers its
  // absence). See camera-support.ts for the gating rationale.
  const isSupported = ref(cameraSupported(readCameraEnv()))
  const isScanning = ref(false)
  const error = ref<string | null>(null)

  let stream: MediaStream | null = null
  let animFrameId = 0
  let resolvePromise: ((value: string | null) => void) | null = null
  let canvas: HTMLCanvasElement | null = null

  // Decode one video frame. Prefers the native detector; falls back to jsQR
  // over a canvas snapshot. Returns the decoded text or null if no code found.
  async function decodeFrame(
    video: HTMLVideoElement,
    nativeDetector: InstanceType<NonNullable<Window['BarcodeDetector']>> | null,
  ): Promise<string | null> {
    if (nativeDetector) {
      const barcodes = await nativeDetector.detect(video)
      return barcodes.length > 0 ? barcodes[0].rawValue : null
    }
    // jsQR software path.
    const w = video.videoWidth
    const h = video.videoHeight
    if (!w || !h) return null
    if (!canvas) canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return null
    ctx.drawImage(video, 0, 0, w, h)
    const imageData = ctx.getImageData(0, 0, w, h)
    const result = jsQR(imageData.data, w, h, { inversionAttempts: 'dontInvert' })
    return result ? result.data : null
  }

  async function scan(): Promise<string | null> {
    if (!isSupported.value) return null

    isScanning.value = true
    error.value = null

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }
      })

      const video = videoRef.value
      if (!video) throw new Error('Video element not available')
      video.srcObject = stream
      await video.play()

      const nativeDetector = 'BarcodeDetector' in window
        ? new window.BarcodeDetector!({ formats: ['qr_code'] })
        : null

      return await new Promise<string | null>((resolve) => {
        resolvePromise = resolve

        const detectFrame = async () => {
          if (!isScanning.value) return
          try {
            const text = await decodeFrame(video, nativeDetector)
            if (text) {
              stop()
              resolve(text)
              return
            }
          } catch { /* frame detection can fail intermittently */ }
          animFrameId = requestAnimationFrame(detectFrame)
        }
        animFrameId = requestAnimationFrame(detectFrame)
      })
    } catch (e) {
      error.value = (e as Error).message
      stop()
      return null
    }
  }

  function stop() {
    cancelAnimationFrame(animFrameId)
    if (stream) {
      stream.getTracks().forEach(t => t.stop())
      stream = null
    }
    if (videoRef.value) {
      videoRef.value.srcObject = null
    }
    isScanning.value = false
  }

  function cancel() {
    stop()
    if (resolvePromise) {
      resolvePromise(null)
      resolvePromise = null
    }
  }

  return { scan, cancel, stop, isSupported, isScanning, error }
}
