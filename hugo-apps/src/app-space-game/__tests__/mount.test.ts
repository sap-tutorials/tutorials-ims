// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'

describe('AppSpaceGame mount scaffold', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('mounts without throwing and renders data-app-space-game root', async () => {
    const AppSpaceGame = (await import('../AppSpaceGame.vue')).default

    const wrapper = mount(AppSpaceGame)

    // Component mounts successfully
    expect(wrapper.exists()).toBe(true)

    // Root element has the data attribute
    expect(wrapper.element.getAttribute('data-app-space-game')).toBe('')

    // No canvas or game-related content is rendered
    expect(wrapper.find('canvas').exists()).toBe(false)

    // The component is hidden/minimal
    expect(wrapper.text()).toBe('')
  })
})
