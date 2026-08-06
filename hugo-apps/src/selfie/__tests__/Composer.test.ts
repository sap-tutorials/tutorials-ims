// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

const h = vi.hoisted(() => {
  const exportPng = vi.fn().mockResolvedValue(new Blob(['png'], { type: 'image/png' }))
  const buildStage = vi.fn().mockResolvedValue({ addCutout: vi.fn(), exportPng, destroy: vi.fn() })
  return { exportPng, buildStage }
})
vi.mock('../compose', () => ({
  buildStage: h.buildStage,
}))

import Composer from '../Composer.vue'

describe('Composer.vue', () => {
  it('emits export with a PNG blob when Export is clicked', async () => {
    const w = mount(Composer, { props: { cutout: new Blob(['c'], { type: 'image/png' }), frameName: 'Thomas', imgBase: '/images/devtoberfest/selfie' } })
    await flushPromises()
    await w.find('[data-testid="export"]').trigger('click')
    await flushPromises()
    const payload = w.emitted('export')?.[0]?.[0] as Blob
    expect(payload).toBeInstanceOf(Blob)
    expect(payload.type).toBe('image/png')
  })
})
