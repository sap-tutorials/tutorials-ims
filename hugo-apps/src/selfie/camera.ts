export class CameraUnavailableError extends Error {
  constructor(cause?: unknown) { super('Camera unavailable'); this.name = 'CameraUnavailableError'; (this as any).cause = cause }
}

const CONSTRAINTS: MediaStreamConstraints = {
  audio: false,
  video: { facingMode: 'user', width: 1280, height: 720 },
}

export async function startCamera(): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia(CONSTRAINTS)
  } catch (e) {
    throw new CameraUnavailableError(e)
  }
}

export function stopCamera(stream: MediaStream): void {
  stream.getTracks().forEach((t) => t.stop())
}

export async function captureFrame(video: HTMLVideoElement): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = video.videoWidth || 1280
  canvas.height = video.videoHeight || 720
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Could not get canvas context')
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('capture failed'))), 'image/png')
  })
}
