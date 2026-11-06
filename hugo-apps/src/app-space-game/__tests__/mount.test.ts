// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'

describe('AppSpaceGame mount scaffold', () => {
  it('mounts without throwing and renders data-app-space-game root', async () => {
    const AppSpaceGame = (await import('../AppSpaceGame.vue')).default

    const wrapper = mount(AppSpaceGame)

    // Component mounts successfully
    expect(wrapper.exists()).toBe(true)

    // Root element has the data attribute
    expect(wrapper.element.getAttribute('data-app-space-game')).toBe('')

    // Task 4: canvas is present in the template (renderer mounts into it when gate passes)
    expect(wrapper.find('canvas').exists()).toBe(true)

    // No text content - the game canvas has no visible text nodes
    expect(wrapper.text()).toBe('')
  })
})
