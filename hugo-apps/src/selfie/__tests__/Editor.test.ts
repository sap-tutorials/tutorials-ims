// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

// Mock cropperjs so the editor can be unit-tested without a real canvas/DOM engine.
// vi.mock is hoisted above imports, so the shared spies live in a hoisted block.
// The constructor is a real function (arrow fns are not `new`-able).
const h = vi.hoisted(() => {
  const rotate = vi.fn()
  const reset = vi.fn()
  const destroy = vi.fn()
  const toBlob = vi.fn((cb: (b: Blob) => void) => cb(new Blob(['x'], { type: 'image/png' })))
  const getCroppedCanvas = vi.fn(() => ({ toBlob }))
  const CropperMock = vi.fn(function (this: any) {
    this.rotate = rotate
    this.reset = reset
    this.destroy = destroy
    this.getCroppedCanvas = getCroppedCanvas
  })
  return { rotate, reset, destroy, toBlob, getCroppedCanvas, CropperMock }
})
vi.mock('cropperjs', () => ({ default: h.CropperMock }))
vi.mock('cropperjs/dist/cropper.css', () => ({}))

import Editor from '../Editor.vue'

const DATA_URL = 'data:image/png;base64,QUJD'

beforeEach(() => {
  h.rotate.mockClear(); h.reset.mockClear(); h.destroy.mockClear()
  h.toBlob.mockClear(); h.getCroppedCanvas.mockClear(); h.CropperMock.mockClear()
})

describe('Editor.vue', () => {
  it('instantiates a cropper over the data-URL image', async () => {
    const w = mount(Editor, { props: { dataUrl: DATA_URL } })
    await flushPromises()
    expect(w.find('img').attributes('src')).toBe(DATA_URL)
    expect(h.CropperMock).toHaveBeenCalledTimes(1)
  })

  it('Rotate buttons call the cropper rotate with ±90', async () => {
    const w = mount(Editor, { props: { dataUrl: DATA_URL } })
    await flushPromises()
    await w.find('[data-testid="rotate-left"]').trigger('click')
    expect(h.rotate).toHaveBeenCalledWith(-90)
    await w.find('[data-testid="rotate-right"]').trigger('click')
    expect(h.rotate).toHaveBeenCalledWith(90)
  })

  it('Download saves the cropped canvas as a PNG blob', async () => {
    const createSpy = vi.fn(() => 'blob:mock')
    const revokeSpy = vi.fn()
    ;(globalThis.URL as any).createObjectURL = createSpy
    ;(globalThis.URL as any).revokeObjectURL = revokeSpy
    const w = mount(Editor, { props: { dataUrl: DATA_URL } })
    await flushPromises()
    await w.find('[data-testid="download"]').trigger('click')
    await flushPromises()
    expect(h.getCroppedCanvas).toHaveBeenCalled()
    expect(h.toBlob).toHaveBeenCalled()
    expect(createSpy).toHaveBeenCalled()
  })

  it('does not throw when the image is empty', async () => {
    expect(() => mount(Editor, { props: { dataUrl: '' } })).not.toThrow()
  })
})
