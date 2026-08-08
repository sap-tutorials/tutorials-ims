// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import EffectPicker from '../EffectPicker.vue'
import { EFFECT_IDS, EFFECTS } from '../effects'

describe('EffectPicker.vue', () => {
  it('renders one button per EFFECT_IDS with its label', () => {
    const w = mount(EffectPicker, { props: { effect: 'none' } })
    for (const id of EFFECT_IDS) {
      const btn = w.find(`[data-testid="effect-${id}"]`)
      expect(btn.exists()).toBe(true)
      expect(btn.text()).toBe(EFFECTS[id].label)
    }
  })

  it('marks the active effect button aria-pressed="true" and the rest false', () => {
    const w = mount(EffectPicker, { props: { effect: 'mono' } })
    expect(w.find('[data-testid="effect-mono"]').attributes('aria-pressed')).toBe('true')
    expect(w.find('[data-testid="effect-none"]').attributes('aria-pressed')).toBe('false')
  })

  it('emits update:effect with the id when a button is clicked', async () => {
    const w = mount(EffectPicker, { props: { effect: 'none' } })
    await w.find('[data-testid="effect-joule"]').trigger('click')
    expect(w.emitted('update:effect')?.[0]?.[0]).toBe('joule')
  })
})
