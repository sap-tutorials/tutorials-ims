// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest'

const removeBackgroundMock = vi.fn()
vi.mock('@imgly/background-removal', () => ({ removeBackground: removeBackgroundMock }))

import { removeBackground } from '../segment'

describe('segment.removeBackground', () => {
  it('returns the cutout with removed=true on success', async () => {
    const cut = new Blob(['cut'], { type: 'image/png' })
    removeBackgroundMock.mockResolvedValueOnce(cut)
    const input = new Blob(['in'], { type: 'image/png' })
    const out = await removeBackground(input)
    expect(out).toEqual({ blob: cut, removed: true })
  })

  it('FAIL-SOFT: returns the original blob with removed=false when the model throws', async () => {
    removeBackgroundMock.mockRejectedValueOnce(new Error('model load failed'))
    const input = new Blob(['in'], { type: 'image/png' })
    const out = await removeBackground(input)
    expect(out).toEqual({ blob: input, removed: false })
  })

  it('requests the vendored isnet_quint8 model (guards against CDN/wrong-model 404)', async () => {
    const cut = new Blob(['cut'], { type: 'image/png' })
    removeBackgroundMock.mockResolvedValueOnce(cut)
    await removeBackground(new Blob(['in'], { type: 'image/png' }))
    expect(removeBackgroundMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ model: 'isnet_quint8' }),
    )
  })
})
