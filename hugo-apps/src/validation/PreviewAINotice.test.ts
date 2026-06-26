// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import PreviewAINotice from './PreviewAINotice.vue'

describe('PreviewAINotice', () => {
  it('renders the static notice text', () => {
    const w = mount(PreviewAINotice, { props: { rulesBlock: '[VALIDATE_1]\n###Rule\nai-graded\n' } })
    expect(w.text()).toMatch(/AI features can only be fully previewed/i)
  })

  it('renders rulesBlock in a <pre> element', () => {
    const w = mount(PreviewAINotice, { props: { rulesBlock: 'SAMPLE_BLOCK' } })
    expect(w.find('pre').text()).toContain('SAMPLE_BLOCK')
  })

  it('hides the <pre> by default; shows after tutorial-preview:reveal-ai-rules event', async () => {
    const w = mount(PreviewAINotice, { props: { rulesBlock: 'X' }, attachTo: document.body })
    expect(w.find('pre').isVisible()).toBe(false)
    window.dispatchEvent(new CustomEvent('tutorial-preview:reveal-ai-rules', { detail: { on: true } }))
    await w.vm.$nextTick()
    expect(w.find('pre').isVisible()).toBe(true)
    w.unmount()
  })
})
