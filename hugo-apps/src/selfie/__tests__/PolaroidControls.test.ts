// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import PolaroidControls from '../PolaroidControls.vue'

const base = { enabled: false, style: 'classic' as const, name: '' }

describe('PolaroidControls.vue', () => {
  it('toggling the border checkbox emits update:enabled', async () => {
    const w = mount(PolaroidControls, { props: base })
    const cb = w.find('[data-testid="border-toggle"]')
    ;(cb.element as HTMLInputElement).checked = true
    await cb.trigger('change')
    expect(w.emitted('update:enabled')?.[0]?.[0]).toBe(true)
  })

  it('hides the style picker and name field until enabled', async () => {
    const w = mount(PolaroidControls, { props: base })
    expect(w.find('[data-testid="border-style-joule"]').exists()).toBe(false)
    expect(w.find('[data-testid="border-name"]').exists()).toBe(false)
    await w.setProps({ enabled: true })
    expect(w.find('[data-testid="border-style-joule"]').exists()).toBe(true)
    expect(w.find('[data-testid="border-name"]').exists()).toBe(true)
  })

  it('shows all three styles and emits update:style on pick', async () => {
    const w = mount(PolaroidControls, { props: { ...base, enabled: true } })
    for (const id of ['classic', 'devtoberfest', 'joule']) {
      expect(w.find(`[data-testid="border-style-${id}"]`).exists()).toBe(true)
    }
    await w.find('[data-testid="border-style-devtoberfest"]').trigger('click')
    expect(w.emitted('update:style')?.[0]?.[0]).toBe('devtoberfest')
  })

  it('typing in the name field emits update:name', async () => {
    const w = mount(PolaroidControls, { props: { ...base, enabled: true } })
    const field = w.find('[data-testid="border-name"]')
    ;(field.element as HTMLInputElement).value = 'Tom'
    await field.trigger('input')
    expect(w.emitted('update:name')?.[0]?.[0]).toBe('Tom')
  })
})
