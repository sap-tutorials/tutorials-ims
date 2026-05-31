// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'

vi.mock('../ResultsTab.vue', () => ({
  default: { name: 'ResultsTabStub', template: '<div data-test="results-stub" />' },
}))
vi.mock('../HistoryTab.vue', () => ({
  default: {
    name: 'HistoryTabStub',
    emits: ['load'],
    template: '<div data-test="history-stub" @click="$emit(\'load\', { ID: \'h1\' })" />',
  },
}))
vi.mock('../SavedTab.vue', () => ({
  default: {
    name: 'SavedTabStub',
    emits: ['load'],
    template: '<div data-test="saved-stub" @click="$emit(\'load\', { ID: \'s1\' })" />',
  },
}))

import BottomTabs from '../BottomTabs.vue'

const baseProps = {
  results: null,
  generatedSql: '',
  canDrillDown: () => false,
}

describe('BottomTabs', () => {
  it('renders the Results tab by default', () => {
    const w = mount(BottomTabs, { props: baseProps })
    expect(w.find('[data-test="results-stub"]').exists()).toBe(true)
    expect(w.find('[data-test="history-stub"]').exists()).toBe(false)
    expect(w.find('[data-test="saved-stub"]').exists()).toBe(false)
  })

  it('switches to History when the History tab is clicked', async () => {
    const w = mount(BottomTabs, { props: baseProps })
    await w.find('[data-test="bottom-tab-history"]').trigger('click')
    expect(w.find('[data-test="history-stub"]').exists()).toBe(true)
  })

  it('switches to Saved when the Saved tab is clicked', async () => {
    const w = mount(BottomTabs, { props: baseProps })
    await w.find('[data-test="bottom-tab-saved"]').trigger('click')
    expect(w.find('[data-test="saved-stub"]').exists()).toBe(true)
  })

  it('forwards History load event as load-row', async () => {
    const w = mount(BottomTabs, { props: baseProps })
    await w.find('[data-test="bottom-tab-history"]').trigger('click')
    await w.find('[data-test="history-stub"]').trigger('click')
    expect(w.emitted('load-row')).toBeTruthy()
    expect((w.emitted('load-row')![0][0] as any).source).toBe('history')
  })

  it('forwards Saved load event as load-row', async () => {
    const w = mount(BottomTabs, { props: baseProps })
    await w.find('[data-test="bottom-tab-saved"]').trigger('click')
    await w.find('[data-test="saved-stub"]').trigger('click')
    expect(w.emitted('load-row')).toBeTruthy()
    expect((w.emitted('load-row')![0][0] as any).source).toBe('saved')
  })
})
