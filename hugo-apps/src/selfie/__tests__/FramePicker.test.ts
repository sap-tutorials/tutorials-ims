// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import FramePicker from '../FramePicker.vue'
describe('FramePicker', () => {
  it('renders a thumbnail per frame and emits the bare name on select', async () => {
    const frames = ['Thomas', 'DJ2', 'Kasmire']
    const w = mount(FramePicker, { props: { frames, imgBase: '/images/devtoberfest/selfie' } })
    expect(w.findAll('.frame-thumb')).toHaveLength(3)
    await w.findAll('.frame-thumb')[1].trigger('click')
    expect(w.emitted('select')![0]).toEqual(['DJ2'])
    // thumbnail src points at the thumbnails dir
    expect(w.findAll('img')[0].attributes('src')).toBe('/images/devtoberfest/selfie/thumbnails/Thomas.png')
  })

  it('marks the chosen frame aria-selected (and only that one)', async () => {
    const frames = ['Thomas', 'DJ2', 'Kasmire']
    const w = mount(FramePicker, { props: { frames, imgBase: '/images/devtoberfest/selfie' } })
    const opts = w.findAll('.frame-thumb')
    // Nothing selected initially.
    expect(opts.every((o) => o.attributes('aria-selected') === 'false')).toBe(true)
    await opts[1].trigger('click')
    expect(opts[1].attributes('aria-selected')).toBe('true')
    expect(opts[0].attributes('aria-selected')).toBe('false')
    expect(opts[2].attributes('aria-selected')).toBe('false')
    // Options are keyboard-focusable.
    expect(opts[1].attributes('tabindex')).toBe('0')
  })

  it('emits select on Enter key', async () => {
    const frames = ['Thomas', 'DJ2', 'Kasmire']
    const w = mount(FramePicker, { props: { frames, imgBase: '/images/devtoberfest/selfie' } })
    await w.findAll('.frame-thumb')[2].trigger('keydown', { key: 'Enter' })
    expect(w.emitted('select')![0]).toEqual(['Kasmire'])
    expect(w.findAll('.frame-thumb')[2].attributes('aria-selected')).toBe('true')
  })
})
