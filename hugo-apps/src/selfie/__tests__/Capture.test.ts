// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

vi.mock('../camera', () => ({
  startCamera: vi.fn().mockRejectedValue(Object.assign(new Error('denied'), { name: 'CameraUnavailableError' })),
  stopCamera: vi.fn(),
  captureFrame: vi.fn(),
  CameraUnavailableError: class extends Error {},
}))

import Capture from '../Capture.vue'

describe('Capture.vue', () => {
  it('falls back to a file input when the camera is unavailable', async () => {
    const w = mount(Capture)
    await flushPromises()
    expect(w.find('input[type="file"]').exists()).toBe(true)
  })

  it('emits error for a non-image file', async () => {
    const w = mount(Capture)
    await flushPromises()
    const input = w.find('input[type="file"]')
    const file = new File(['x'], 'x.txt', { type: 'text/plain' })
    Object.defineProperty(input.element, 'files', { value: [file] })
    await input.trigger('change')
    expect(w.emitted('error')?.[0]?.[0]).toMatch(/image/i)
  })
})
