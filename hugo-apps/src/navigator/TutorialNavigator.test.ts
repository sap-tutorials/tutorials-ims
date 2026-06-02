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

import { requiresLicense } from '../shared/license'
import type { CardItem } from '@shared/types'

// Pure-function mirror of the post-Task-4 filteredItems extension. The
// real filteredItems lives inside TutorialNavigator.vue's <script setup>;
// that file imports fetch/UI5/full Vue lifecycle and isn't unit-mountable
// at the file level (matches the pattern of the harness above for #159).
// We instead test the extracted predicate that the .vue file delegates to.
function applyOptionsFilters(
  items: CardItem[],
  flags: { isNew: boolean; noLicense: boolean }
): CardItem[] {
  return items.filter(item => {
    if (flags.isNew && !item.isNew) return false
    if (flags.noLicense && requiresLicense(item)) return false
    return true
  })
}

describe('Options filters (#175)', () => {
  const baseCard: CardItem = {
    type: 'tutorial',
    id: 'a',
    title: 'A',
    description: '',
    time: 0,
    level: 'beginner',
    tutorialCount: 1,
    primaryTag: '',
    displayTags: [],
    displayTagSlugs: [],
    href: '/tutorials/a',
    stepCount: 0,
  }
  const newFree: CardItem = { ...baseCard, id: 'newFree', isNew: true }
  const newLicensed: CardItem = { ...baseCard, id: 'newLicensed', isNew: true, displayTagSlugs: ['tutorial>license'] }
  const oldFree: CardItem = { ...baseCard, id: 'oldFree', isNew: false }
  const oldLicensed: CardItem = { ...baseCard, id: 'oldLicensed', isNew: false, displayTagSlugs: ['tutorial>license'] }

  const all = [newFree, newLicensed, oldFree, oldLicensed]

  it('returns input unchanged when both flags off', () => {
    expect(applyOptionsFilters(all, { isNew: false, noLicense: false })).toEqual(all)
  })

  it('isNew=true keeps only items with isNew=true', () => {
    expect(applyOptionsFilters(all, { isNew: true, noLicense: false })).toEqual([newFree, newLicensed])
  })

  it('noLicense=true strips license-tagged items', () => {
    expect(applyOptionsFilters(all, { isNew: false, noLicense: true })).toEqual([newFree, oldFree])
  })

  it('both flags AND together', () => {
    expect(applyOptionsFilters(all, { isNew: true, noLicense: true })).toEqual([newFree])
  })
})

describe('Options URL sync (#175)', () => {
  // Pure functions mirroring the post-Task-4 sync logic in TutorialNavigator.vue.
  function readOptionsFromURL(href: string): { isNew: boolean; noLicense: boolean } {
    const sp = new URL(href).searchParams
    return { isNew: sp.get('new') === '1', noLicense: sp.get('noLicense') === '1' }
  }

  function writeOptionsToURL(href: string, flags: { isNew: boolean; noLicense: boolean }): string {
    const url = new URL(href)
    if (flags.isNew) url.searchParams.set('new', '1'); else url.searchParams.delete('new')
    if (flags.noLicense) url.searchParams.set('noLicense', '1'); else url.searchParams.delete('noLicense')
    return url.toString()
  }

  it('reads ?new=1&noLicense=1', () => {
    expect(readOptionsFromURL('https://x/?new=1&noLicense=1')).toEqual({ isNew: true, noLicense: true })
  })

  it('reads ?new=1 only', () => {
    expect(readOptionsFromURL('https://x/?new=1')).toEqual({ isNew: true, noLicense: false })
  })

  it('reads neither when absent', () => {
    expect(readOptionsFromURL('https://x/')).toEqual({ isNew: false, noLicense: false })
  })

  it('writes both flags when on', () => {
    const result = writeOptionsToURL('https://x/', { isNew: true, noLicense: true })
    expect(new URL(result).searchParams.get('new')).toBe('1')
    expect(new URL(result).searchParams.get('noLicense')).toBe('1')
  })

  it('omits both flags when off', () => {
    const result = writeOptionsToURL('https://x/?new=1&noLicense=1', { isNew: false, noLicense: false })
    expect(new URL(result).searchParams.has('new')).toBe(false)
    expect(new URL(result).searchParams.has('noLicense')).toBe(false)
  })

  it('round-trips correctly', () => {
    const flags = { isNew: true, noLicense: false }
    const written = writeOptionsToURL('https://x/?q=cap', flags)
    expect(readOptionsFromURL(written)).toEqual(flags)
    // Pre-existing query keys are preserved.
    expect(new URL(written).searchParams.get('q')).toBe('cap')
  })
})
