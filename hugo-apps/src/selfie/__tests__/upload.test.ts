import { describe, it, expect, vi } from 'vitest'
import { uploadSelfie } from '../upload'
describe('uploadSelfie', () => {
  it('POSTs multipart with the file + selectedPic and returns a data URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => 'QUJD' })
    globalThis.fetch = fetchMock as any
    const file = new File([new Uint8Array([1,2,3])], 'me.png', { type: 'image/png' })
    const out = await uploadSelfie('/community/upload_selfie', file, 'Thomas')
    expect(out).toBe('data:image/png;base64,QUJD')
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('/community/upload_selfie')
    expect(opts.method).toBe('POST')
    const fd = opts.body as FormData
    expect(fd.get('selectedPic')).toBe('Thomas')
    expect(fd.get('file')).toBeInstanceOf(File)
  })
  it('rejects a non-image file before uploading', async () => {
    const notImage = new File([new Uint8Array(1)], 'x.txt', { type: 'text/plain' })
    await expect(uploadSelfie('/x', notImage, 'Thomas')).rejects.toThrow(/image/i)
  })
  it('rejects an oversize image (> 20 MB) before uploading', async () => {
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock as any
    // A real image/* File whose reported size exceeds the 20 MB cap.
    const big = new File(['x'], 'huge.png', { type: 'image/png' })
    Object.defineProperty(big, 'size', { value: 20 * 1024 * 1024 + 1 })
    await expect(uploadSelfie('/x', big, 'Thomas')).rejects.toThrow(/too large/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('throws a friendly error on non-200', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => '' }) as any
    const file = new File([new Uint8Array([1])], 'me.png', { type: 'image/png' })
    await expect(uploadSelfie('/x', file, 'Thomas')).rejects.toThrow(/could not build your selfie/i)
  })
  it('surfaces a friendly message (not "Failed to fetch") when fetch rejects', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch')) as any
    const file = new File([new Uint8Array([1])], 'me.png', { type: 'image/png' })
    await expect(uploadSelfie('/x', file, 'Thomas')).rejects.toThrow(/could not reach the server/i)
    await expect(uploadSelfie('/x', file, 'Thomas')).rejects.not.toThrow(/failed to fetch/i)
  })
})
