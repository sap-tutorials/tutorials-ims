import { ref, type Ref } from 'vue'

declare global {
  interface Window {
    BarcodeDetector?: new (opts?: { formats: string[] }) => {
      detect(source: ImageBitmapSource): Promise<Array<{ rawValue: string }>>
    }
  }
}

export function useBarcodeScanner(videoRef: Ref<HTMLVideoElement | null>) {
  const isSupported = ref('BarcodeDetector' in window)
  const isScanning = ref(false)
  const error = ref<string | null>(null)

  let stream: MediaStream | null = null
  let animFrameId = 0
  let resolvePromise: ((value: string | null) => void) | null = null

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

      const detector = new window.BarcodeDetector!({ formats: ['qr_code'] })

      return await new Promise<string | null>((resolve) => {
        resolvePromise = resolve

        const detectFrame = async () => {
          if (!isScanning.value) return
          try {
            const barcodes = await detector.detect(video)
            if (barcodes.length > 0) {
              stop()
              resolve(barcodes[0].rawValue)
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
