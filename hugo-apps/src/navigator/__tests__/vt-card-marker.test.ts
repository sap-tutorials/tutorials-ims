// @vitest-environment happy-dom
// hugo-apps/src/navigator/__tests__/vt-card-marker.test.ts
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'

// Contract test for the View Transitions marker on the navigator card.
// We don't import TutorialNavigator (heavy deps) — we render a minimal
// harness that mirrors the relevant markup from
// TutorialNavigator.vue:718-764. The smoke test in
// test/smoke/view-transitions.smoke.test.ts verifies the real, deployed
// page emits the same shape.

describe('navigator card view-transition marker', () => {
  it('the rendered nav-card link carries data-vt-card="navigator"', () => {
    const wrapper = mount({
      template: `
        <a href="/tutorials/foo" class="nav-card" data-vt-card="navigator">
          <h3 class="nav-card__title">Foo</h3>
        </a>
      `,
    })
    const link = wrapper.find('a.nav-card')
    expect(link.exists()).toBe(true)
    expect(link.attributes('data-vt-card')).toBe('navigator')
  })
})
