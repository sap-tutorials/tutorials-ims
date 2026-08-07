// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'

vi.mock('../share', () => ({
  downloadBlob: vi.fn(),
  shareOrDownload: vi.fn(),
  canShareImage: () => false
}))

import ExportBar from '../ExportBar.vue'
import { downloadBlob } from '../share'

describe('ExportBar.vue', () => {
  it('downloads on click and hides Share when unsupported', async () => {
    const w = mount(ExportBar, { props: { image: new Blob(['x'], { type: 'image/png' }) } })
    expect(w.find('[data-testid="share"]').exists()).toBe(false)
    await w.find('[data-testid="download"]').trigger('click')
    expect(downloadBlob).toHaveBeenCalled()
  })
})
