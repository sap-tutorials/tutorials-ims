// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import BackgroundPicker from '../BackgroundPicker.vue'
import { BACKGROUNDS } from '../backgrounds'

const base = { background: 'none', imgBase: '/images/devtoberfest/selfie' }

describe('BackgroundPicker.vue', () => {
  it('renders a None option and one control per scene', () => {
    const w = mount(BackgroundPicker, { props: base })
    expect(w.find('[data-testid="bg-none"]').exists()).toBe(true)
    for (const b of BACKGROUNDS) {
      expect(w.find(`[data-testid="bg-${b.id}"]`).exists()).toBe(true)
    }
  })

  it('marks the active background', () => {
    const w = mount(BackgroundPicker, { props: { ...base, background: 'terminal' } })
    expect(w.find('[data-testid="bg-terminal"]').classes()).toContain('is-active')
    expect(w.find('[data-testid="bg-none"]').classes()).not.toContain('is-active')
  })

  it('emits update:background with the scene id on click', async () => {
    const w = mount(BackgroundPicker, { props: base })
    await w.find('[data-testid="bg-key-visual-josh"]').trigger('click')
    expect(w.emitted('update:background')?.[0]?.[0]).toBe('key-visual-josh')
  })

  it('emits none when the None option is clicked', async () => {
    const w = mount(BackgroundPicker, { props: { ...base, background: 'terminal' } })
    await w.find('[data-testid="bg-none"]').trigger('click')
    expect(w.emitted('update:background')?.[0]?.[0]).toBe('none')
  })
})
