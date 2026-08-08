// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

const h = vi.hoisted(() => ({ canShare: false }))
vi.mock('../share', () => ({
  downloadBlob: vi.fn(),
  shareOrDownload: vi.fn(),
  copyImage: vi.fn().mockResolvedValue('copied'),
  openSocialShare: vi.fn(),
  canShareImage: () => h.canShare
}))

import ExportBar from '../ExportBar.vue'
import { downloadBlob, copyImage, openSocialShare } from '../share'

const img = () => new Blob(['x'], { type: 'image/png' })

describe('ExportBar.vue — desktop branch', () => {
  it('shows the desktop row (no native share) when canShareImage is false', () => {
    h.canShare = false
    const w = mount(ExportBar, { props: { image: img() } })
    expect(w.find('[data-testid="share"]').exists()).toBe(false)
    expect(w.find('[data-testid="download"]').exists()).toBe(true)
    expect(w.find('[data-testid="copy"]').exists()).toBe(true)
    expect(w.find('[data-testid="share-x"]').exists()).toBe(true)
    expect(w.find('[data-testid="share-linkedin"]').exists()).toBe(true)
  })

  it('downloads on click', async () => {
    h.canShare = false
    const w = mount(ExportBar, { props: { image: img() } })
    await w.find('[data-testid="download"]').trigger('click')
    expect(downloadBlob).toHaveBeenCalled()
  })

  it('Copy click flips the label to "Copied!"', async () => {
    h.canShare = false
    const w = mount(ExportBar, { props: { image: img() } })
    await w.find('[data-testid="copy"]').trigger('click')
    await flushPromises()
    expect(copyImage).toHaveBeenCalled()
    expect(w.find('[data-testid="copy"]').text()).toBe('Copied!')
  })

  it('X and LinkedIn buttons call openSocialShare with the right network', async () => {
    h.canShare = false
    const w = mount(ExportBar, { props: { image: img() } })
    await w.find('[data-testid="share-x"]').trigger('click')
    await w.find('[data-testid="share-linkedin"]').trigger('click')
    expect(openSocialShare).toHaveBeenCalledWith(expect.any(Blob), 'x')
    expect(openSocialShare).toHaveBeenCalledWith(expect.any(Blob), 'linkedin')
  })
})

describe('ExportBar.vue — mobile branch', () => {
  it('shows only the native Share button and hides the desktop row', () => {
    h.canShare = true
    const w = mount(ExportBar, { props: { image: img() } })
    expect(w.find('[data-testid="share"]').exists()).toBe(true)
    expect(w.find('[data-testid="download"]').exists()).toBe(false)
    expect(w.find('[data-testid="copy"]').exists()).toBe(false)
    expect(w.find('[data-testid="share-x"]').exists()).toBe(false)
  })
})
