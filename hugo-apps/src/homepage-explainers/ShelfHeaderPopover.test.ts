// @vitest-environment happy-dom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import ShelfHeaderPopover from './ShelfHeaderPopover.vue';

const BASE_PROPS = {
  shelfKey: 'START_HERE',
  label: 'Start here',
  tagline: 'Marquee entry points for this verb',
  whyItMatters: 'A curated hand-off point for newcomers.',
};

describe('ShelfHeaderPopover', () => {
  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
  afterEach(() => { vi.useRealTimers(); });

  it('renders the label as <h2> and no reserved flip-card scaffold', () => {
    const wrapper = mount(ShelfHeaderPopover, { props: BASE_PROPS });
    // Header uses semantic <h2>, not a flip-card <div role="button">.
    const h2 = wrapper.find('h2.hp-shelf-header__label');
    expect(h2.exists()).toBe(true);
    expect(h2.text()).toBe('Start here');
    // The flip-card container class must NOT be present — that was the
    // ~96 px empty-space regression #1020 replaces.
    expect(wrapper.find('.hp-flip').exists()).toBe(false);
  });

  it('renders the ⓘ button when at least one explainer field is set', () => {
    const wrapper = mount(ShelfHeaderPopover, { props: BASE_PROPS });
    expect(wrapper.find('[aria-label*="More about"]').exists()).toBe(true);
  });

  it('does NOT render the ⓘ button when tagline and whyItMatters are both empty', () => {
    const wrapper = mount(ShelfHeaderPopover, {
      props: { shelfKey: 'START_HERE', label: 'Start here', tagline: '', whyItMatters: '' },
    });
    expect(wrapper.find('[aria-label*="More about"]').exists()).toBe(false);
    // But the header itself is still rendered — a shelf with no explainer
    // still needs its title.
    expect(wrapper.find('h2.hp-shelf-header__label').text()).toBe('Start here');
  });

  it('popover opens on ⓘ click and shows tagline + whyItMatters in order', async () => {
    const wrapper = mount(ShelfHeaderPopover, { props: BASE_PROPS });
    await wrapper.find('[aria-label*="More about"]').trigger('click');
    await nextTick();
    const popover = wrapper.find('[role="tooltip"]');
    expect(popover.exists()).toBe(true);
    const html = popover.html();
    const taglineIdx = html.indexOf(BASE_PROPS.tagline);
    const whyIdx = html.indexOf(BASE_PROPS.whyItMatters);
    expect(taglineIdx).toBeGreaterThan(-1);
    expect(whyIdx).toBeGreaterThan(-1);
    expect(taglineIdx).toBeLessThan(whyIdx);
  });

  it('Esc closes a click-opened popover', async () => {
    const wrapper = mount(ShelfHeaderPopover, { props: BASE_PROPS });
    await wrapper.find('[aria-label*="More about"]').trigger('click');
    expect(wrapper.find('[role="tooltip"]').exists()).toBe(true);
    await wrapper.find('[role="tooltip"]').trigger('keydown', { key: 'Escape' });
    await nextTick();
    expect(wrapper.find('[role="tooltip"]').exists()).toBe(false);
  });

  it('hover-intent opens the popover after 250 ms', async () => {
    const wrapper = mount(ShelfHeaderPopover, { props: BASE_PROPS });
    await wrapper.find('[aria-label*="More about"]').trigger('pointerenter');
    expect(wrapper.find('[role="tooltip"]').exists()).toBe(false);
    vi.advanceTimersByTime(250);
    await nextTick();
    expect(wrapper.find('[role="tooltip"]').exists()).toBe(true);
  });

  it('outside click closes a click-opened popover', async () => {
    const wrapper = mount(ShelfHeaderPopover, {
      props: BASE_PROPS,
      attachTo: document.body,
    });
    await wrapper.find('[aria-label*="More about"]').trigger('click');
    await nextTick();
    expect(wrapper.find('[role="tooltip"]').exists()).toBe(true);
    document.body.click();
    await nextTick();
    expect(wrapper.find('[role="tooltip"]').exists()).toBe(false);
    wrapper.unmount();
  });
});
