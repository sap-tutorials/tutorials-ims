// @vitest-environment happy-dom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { nextTick } from 'vue';
import LinkExplainerPopover from './LinkExplainerPopover.vue';

const BASE_PROPS = {
  entryId: 'test-1',
  title: 'SAP Joule',
  tagline: 'AI copilot built into SAP',
  whyItMatters: 'Pairs with your SAP apps for AI-powered guidance.',
  description: 'Learn more about SAP Joule.',
  href: 'https://example.com/joule',
};

describe('LinkExplainerPopover', () => {
  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
  afterEach(() => { vi.useRealTimers(); });

  it('renders ⓘ icon when any content field is non-empty', () => {
    const wrapper = mount(LinkExplainerPopover, { props: BASE_PROPS,
      slots: { default: `<a href="${BASE_PROPS.href}">SAP Joule</a>` } });
    expect(wrapper.find('[aria-label*="More about"]').exists()).toBe(true);
  });

  it('does NOT render ⓘ icon when all three content fields are empty', () => {
    const wrapper = mount(LinkExplainerPopover, {
      props: { ...BASE_PROPS, tagline: '', whyItMatters: '', description: '' },
      slots: { default: `<a href="${BASE_PROPS.href}">Bare link</a>` },
    });
    expect(wrapper.find('[aria-label*="More about"]').exists()).toBe(false);
  });

  it('popover opens on ⓘ click and shows tagline + whyItMatters + description in order', async () => {
    const wrapper = mount(LinkExplainerPopover, { props: BASE_PROPS,
      slots: { default: `<a href="${BASE_PROPS.href}">SAP Joule</a>` } });
    await wrapper.find('[aria-label*="More about"]').trigger('click');
    await nextTick();
    const popover = wrapper.find('[role="tooltip"]');
    expect(popover.exists()).toBe(true);
    const html = popover.html();
    // Order: tagline first, then whyItMatters, then description
    const taglineIdx = html.indexOf(BASE_PROPS.tagline);
    const whyIdx = html.indexOf(BASE_PROPS.whyItMatters);
    const descIdx = html.indexOf(BASE_PROPS.description);
    expect(taglineIdx).toBeGreaterThan(-1);
    expect(taglineIdx).toBeLessThan(whyIdx);
    expect(whyIdx).toBeLessThan(descIdx);
  });

  it('Esc closes the popover after click-open', async () => {
    const wrapper = mount(LinkExplainerPopover, { props: BASE_PROPS,
      slots: { default: `<a href="${BASE_PROPS.href}">SAP Joule</a>` } });
    await wrapper.find('[aria-label*="More about"]').trigger('click');
    expect(wrapper.find('[role="tooltip"]').exists()).toBe(true);
    await wrapper.find('[role="tooltip"]').trigger('keydown', { key: 'Escape' });
    await nextTick();
    expect(wrapper.find('[role="tooltip"]').exists()).toBe(false);
  });

  it('hover-intent opens popover after 250 ms', async () => {
    const wrapper = mount(LinkExplainerPopover, { props: BASE_PROPS,
      slots: { default: `<a href="${BASE_PROPS.href}">SAP Joule</a>` } });
    await wrapper.find('[aria-label*="More about"]').trigger('pointerenter');
    expect(wrapper.find('[role="tooltip"]').exists()).toBe(false);
    vi.advanceTimersByTime(250);
    await nextTick();
    expect(wrapper.find('[role="tooltip"]').exists()).toBe(true);
  });

  it('renders only the non-empty fields', async () => {
    const wrapper = mount(LinkExplainerPopover, {
      props: { ...BASE_PROPS, whyItMatters: '', description: '' },
      slots: { default: `<a href="${BASE_PROPS.href}">SAP Joule</a>` },
    });
    await wrapper.find('[aria-label*="More about"]').trigger('click');
    await nextTick();
    const popover = wrapper.find('[role="tooltip"]');
    expect(popover.text()).toContain(BASE_PROPS.tagline);
    expect(popover.text()).not.toContain(BASE_PROPS.whyItMatters);
    expect(popover.text()).not.toContain(BASE_PROPS.description);
  });

  it('outside click closes click-opened popover', async () => {
    const wrapper = mount(LinkExplainerPopover, {
      props: BASE_PROPS,
      slots: { default: `<a href="${BASE_PROPS.href}">SAP Joule</a>` },
      attachTo: document.body,
    });
    await wrapper.find('[aria-label*="More about"]').trigger('click');
    await nextTick();
    expect(wrapper.find('[role="tooltip"]').exists()).toBe(true);
    // Simulate a click outside the popover anchor
    document.body.click();
    await nextTick();
    expect(wrapper.find('[role="tooltip"]').exists()).toBe(false);
    wrapper.unmount();
  });
});
