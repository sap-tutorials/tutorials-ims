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
})
