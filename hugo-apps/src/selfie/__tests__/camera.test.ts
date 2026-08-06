// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { startCamera, captureFrame, CameraUnavailableError } from '../camera'

describe('camera', () => {
  beforeEach(() => { vi.restoreAllMocks() })

  it('startCamera resolves the getUserMedia stream', async () => {
    const fakeStream = { getTracks: () => [] } as unknown as MediaStream
    const gum = vi.fn().mockResolvedValue(fakeStream)
    ;(navigator as any).mediaDevices = { getUserMedia: gum }
    await expect(startCamera()).resolves.toBe(fakeStream)
    expect(gum).toHaveBeenCalledWith(expect.objectContaining({ audio: false }))
  })

  it('startCamera throws CameraUnavailableError when getUserMedia rejects', async () => {
    ;(navigator as any).mediaDevices = { getUserMedia: vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError')) }
    await expect(startCamera()).rejects.toBeInstanceOf(CameraUnavailableError)
  })

  it('captureFrame returns a PNG blob from the video frame', async () => {
    const blob = new Blob(['x'], { type: 'image/png' })
    const canvasProto = HTMLCanvasElement.prototype as any
    vi.spyOn(canvasProto, 'getContext').mockReturnValue({ drawImage: vi.fn() })
    vi.spyOn(canvasProto, 'toBlob').mockImplementation((cb: (b: Blob | null) => void) => cb(blob))
    const video = { videoWidth: 1280, videoHeight: 720 } as HTMLVideoElement
    await expect(captureFrame(video)).resolves.toBe(blob)
  })
})
