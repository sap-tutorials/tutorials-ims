// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { defineComponent, h } from 'vue';
import App from './App.vue';

// Task 4 of docs/superpowers/plans/2026-07-08-concepts-scale.md (#1327).
// The island now reads the embedded #concepts-data JSON (emitted by the CAP
// list page, Task 2) and renders the visible slice via RecycleScroller,
// instead of DOM-toggling `hidden` on ~5k SSR <li>. These tests exercise the
// DATA path (JSON read → filter → count → items passed to the scroller), not
// RecycleScroller's own windowing.
//
// RecycleScroller is stubbed: the real component's pre-compiled internals
// (ResizeObserver, ItemView) don't render cleanly under vitest+happy-dom, and
// the plan says explicitly NOT to test its internals. The stub renders its
// `items` prop through the default slot so ConceptCard wiring is still covered.
const RecycleScrollerStub = defineComponent({
  name: 'RecycleScroller',
  props: { items: { type: Array, default: () => [] }, itemSize: Number, keyField: String, gridItems: Number, itemSecondarySize: Number },
  setup(props, { slots }) {
    return () => h('div', { class: 'rs-stub' },
      (props.items as any[]).map((item) => slots.default?.({ item })));
  },
});

const mountOpts = { global: { stubs: { RecycleScroller: RecycleScrollerStub } } };

const CARDS = [
  { slug: 'cap', name: 'CAP', description: 'SAP Cloud Application Programming Model.', firstLetter: 'C', tutorialCount: 12 },
  { slug: 'hana', name: 'HANA Cloud', description: 'In-memory database.', firstLetter: 'H', tutorialCount: 5 },
  { slug: 'abap', name: 'ABAP', description: 'The language.', firstLetter: 'A', tutorialCount: 3 },
  { slug: '3d', name: '3D printing', description: 'Numeric first char.', firstLetter: '#', tutorialCount: 0 },
];

function setupDom(cards = CARDS, { withData = true } = {}) {
  document.body.innerHTML = `
    <article class="concepts-index" id="concepts-filter-root">
      <div class="concepts-index__controls" id="concepts-filter-controls" hidden></div>
      <p class="concepts-index__count" id="concepts-filter-count">${cards.length} concepts</p>
      <ul class="concepts-index__list" id="concepts-filter-list"></ul>
      <p class="concepts-index__empty" id="concepts-filter-empty" hidden></p>
      <button id="concepts-filter-clear">Clear</button>
      ${withData ? `<script type="application/json" id="concepts-data">${JSON.stringify(cards).replace(/<\//g, '<\\/')}</script>` : ''}
    </article>`;
  return document.getElementById('concepts-filter-controls')!;
}

describe('concepts-filter App.vue — JSON read + virtualization', () => {
  beforeEach(() => { window.history.replaceState({}, '', '/concepts/'); });
  afterEach(() => { document.body.innerHTML = ''; });

  it('reads #concepts-data JSON into the card set (not the SSR <li>)', async () => {
    const mountEl = setupDom();
    const wrapper = mount(App, { attachTo: mountEl, ...mountOpts });
    await flushPromises();

    // The RecycleScroller receives all cards as items when no filter is set.
    const scroller = wrapper.findComponent({ name: 'RecycleScroller' });
    expect(scroller.exists()).toBe(true);
    expect(scroller.props('items')).toHaveLength(CARDS.length);
    wrapper.unmount();
  });

  it('updates the count element to reflect a search filter', async () => {
    const mountEl = setupDom();
    const wrapper = mount(App, { attachTo: mountEl, ...mountOpts });
    await flushPromises();

    const countEl = document.getElementById('concepts-filter-count')!;
    expect(countEl.textContent).toContain('4 concepts');

    // Type a query that matches only CAP.
    const input = wrapper.find('input[type="search"]');
    await input.setValue('Programming');
    // debounce is 100ms
    await new Promise(r => setTimeout(r, 150));
    await flushPromises();

    expect(countEl.textContent).toMatch(/1 of 4/);
    const scroller = wrapper.findComponent({ name: 'RecycleScroller' });
    expect(scroller.props('items')).toHaveLength(1);
    expect(scroller.props('items')[0].slug).toBe('cap');
    wrapper.unmount();
  });

  it('filters by first-letter via the A-Z strip', async () => {
    const mountEl = setupDom();
    const wrapper = mount(App, { attachTo: mountEl, ...mountOpts });
    await flushPromises();

    // Click the 'H' letter button.
    const hButton = wrapper.findAll('button').find(b => b.text() === 'H');
    expect(hButton).toBeTruthy();
    await hButton!.trigger('click');
    await flushPromises();

    const scroller = wrapper.findComponent({ name: 'RecycleScroller' });
    expect(scroller.props('items')).toHaveLength(1);
    expect(scroller.props('items')[0].slug).toBe('hana');
    wrapper.unmount();
  });

  it('sorts by coverage (tutorialCount desc) when selected', async () => {
    const mountEl = setupDom();
    const wrapper = mount(App, { attachTo: mountEl, ...mountOpts });
    await flushPromises();

    const select = wrapper.find('select');
    await select.setValue('coverage');
    await flushPromises();

    const scroller = wrapper.findComponent({ name: 'RecycleScroller' });
    const order = scroller.props('items').map((c: any) => c.slug);
    // cap(12) > hana(5) > abap(3) > 3d(0)
    expect(order).toEqual(['cap', 'hana', 'abap', '3d']);
    wrapper.unmount();
  });

  it('shows the empty-state banner when a filter matches nothing', async () => {
    const mountEl = setupDom();
    const wrapper = mount(App, { attachTo: mountEl, ...mountOpts });
    await flushPromises();

    const input = wrapper.find('input[type="search"]');
    await input.setValue('zzz-nonexistent');
    await new Promise(r => setTimeout(r, 150));
    await flushPromises();

    const emptyEl = document.getElementById('concepts-filter-empty')!;
    expect(emptyEl.hasAttribute('hidden')).toBe(false);
    wrapper.unmount();
  });

  it('bails gracefully when there is no #concepts-data and no SSR <li>', async () => {
    const mountEl = setupDom([], { withData: false });
    const wrapper = mount(App, { attachTo: mountEl, ...mountOpts });
    await flushPromises();
    // No crash; scroller may be absent or empty.
    const scroller = wrapper.findComponent({ name: 'RecycleScroller' });
    if (scroller.exists()) expect(scroller.props('items')).toHaveLength(0);
    wrapper.unmount();
  });
});
