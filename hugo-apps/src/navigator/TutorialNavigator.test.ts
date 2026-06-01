// @vitest-environment happy-dom
// hugo-apps/src/navigator/TutorialNavigator.test.ts
//
// Contract test for issue #159: typing into the search box when the query
// has no matches must NOT unmount/remount the empty-state component on
// every keystroke. We don't import TutorialNavigator (heavy deps: fetch,
// UI5 web components, full vue lifecycle) — we render a minimal harness
// that mirrors the post-fix structure of TutorialNavigator.vue's
// `.navigator-result-area` block. The smoke test in
// test/smoke/navigator-no-results.smoke.test.ts verifies the deployed
// page emits the same shape.

import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, ref, nextTick } from 'vue'

// Mirrors TutorialNavigator.vue post-fix `.navigator-result-area` block.
// Persistent siblings gated by v-show; aria-busy on the wrapper; busy
// indicator does not displace the empty-state.
const ResultRegionHarness = defineComponent({
  setup() {
    const loading = ref(false)
    const isSubThreshold = ref(false)
    const isSearching = ref(false)
    const displayedItems = ref<{ id: string }[]>([])
    return { loading, isSubThreshold, isSearching, displayedItems }
  },
  template: `
    <div class="navigator-result-area" :aria-busy="isSearching">
      <section v-if="loading" class="navigator-grid navigator-grid--loading"></section>
      <div data-region-busy></div>
      <div v-show="!loading && isSubThreshold" class="navigator-hint">
        <ui5-illustrated-message name="BeforeSearch"></ui5-illustrated-message>
      </div>
      <section v-show="!loading && !isSubThreshold && displayedItems.length > 0" class="navigator-grid">
        <a v-for="item in displayedItems" :key="item.id" class="nav-card"></a>
      </section>
      <div v-show="!loading && !isSubThreshold && displayedItems.length === 0" class="navigator-empty">
        <ui5-illustrated-message name="NoFilterResults"></ui5-illustrated-message>
      </div>
    </div>
  `,
})

describe('TutorialNavigator result-region stability (#159)', () => {
  it('keeps the empty-state DOM node mounted across consecutive empty searches', async () => {
    const wrapper = mount(ResultRegionHarness)
    const vm = wrapper.vm as any

    // First empty result settles.
    vm.isSearching = false
    vm.displayedItems = []
    await nextTick()
    const emptyBefore = wrapper.find('.navigator-empty').element
    const illustrationBefore = wrapper.find('.navigator-empty ui5-illustrated-message').element
    expect(emptyBefore).toBeTruthy()

    // Simulate the user typing one more character: a debounced search fires,
    // isSearching flips on, then the response comes back empty again.
    vm.isSearching = true
    await nextTick()
    vm.isSearching = false
    vm.displayedItems = [] // still empty
    await nextTick()

    const emptyAfter = wrapper.find('.navigator-empty').element
    const illustrationAfter = wrapper.find('.navigator-empty ui5-illustrated-message').element

    // Same node reference: never unmounted between keystrokes.
    expect(emptyAfter).toBe(emptyBefore)
    expect(illustrationAfter).toBe(illustrationBefore)
  })

  it('marks the result region aria-busy while a search is in flight', async () => {
    const wrapper = mount(ResultRegionHarness)
    const vm = wrapper.vm as any
    const region = wrapper.get('.navigator-result-area')

    expect(region.attributes('aria-busy')).toBe('false')

    vm.isSearching = true
    await nextTick()
    expect(region.attributes('aria-busy')).toBe('true')

    vm.isSearching = false
    await nextTick()
    expect(region.attributes('aria-busy')).toBe('false')
  })

  it('keeps the empty-state node mounted while the busy indicator overlays', async () => {
    // Mid-flight: isSearching=true and displayedItems still empty from the
    // previous round. The empty-state should remain in the DOM (just
    // visually overlayed by the busy indicator), not be replaced by a
    // spinner that unmounts it.
    const wrapper = mount(ResultRegionHarness)
    const vm = wrapper.vm as any

    vm.displayedItems = []
    vm.isSearching = false
    await nextTick()
    const emptyBefore = wrapper.find('.navigator-empty').element

    vm.isSearching = true
    await nextTick()
    const emptyDuring = wrapper.find('.navigator-empty').element

    expect(emptyDuring).toBe(emptyBefore)
  })
})
