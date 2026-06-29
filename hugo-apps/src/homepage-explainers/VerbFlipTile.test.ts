// @vitest-environment happy-dom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { nextTick } from 'vue';
import VerbFlipTile from './VerbFlipTile.vue';

describe('VerbFlipTile', () => {
  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
  afterEach(() => { vi.useRealTimers(); });

  it('renders verb-tile mode with label, icon, and front-face preview slot', () => {
    const wrapper = mount(VerbFlipTile, {
      props: {
        verbKey: 'LEARN',
        label: 'Learn',
        iconName: 'learning-assistant',
        tagline: 'Pick up SAP for the first time',
        whyItMatters: 'Tutorials, learning journeys, and missions',
        href: '/learn/',
      },
      slots: {
        default: '<ul class="hp-verb__preview"><li>Tutorial 1</li></ul>',
      },
    });
    expect(wrapper.text()).toContain('Learn');
    expect(wrapper.find('.hp-verb__preview').exists()).toBe(true);
    expect(wrapper.find('[data-flipped="false"]').exists()).toBe(true);
  });

  it('renders shelf-header mode (no href) without preview', () => {
    const wrapper = mount(VerbFlipTile, {
      props: {
        shelfKey: 'START_HERE',
        label: 'Start here',
        tagline: 'Marquee entry points',
        whyItMatters: 'Curated highlights for newcomers',
      },
    });
    expect(wrapper.text()).toContain('Start here');
    expect(wrapper.find('.hp-verb__preview').exists()).toBe(false);
    // No <a href> in shelf-header mode
    expect(wrapper.find('a[href]').exists()).toBe(false);
  });

  it('flips on Space when focused', async () => {
    const wrapper = mount(VerbFlipTile, {
      props: { verbKey: 'LEARN', label: 'Learn', iconName: 'learning-assistant',
               tagline: 'T', whyItMatters: 'W', href: '/learn/' },
    });
    const tile = wrapper.find('.hp-flip');
    await tile.trigger('keydown', { key: ' ' });
    await nextTick();
    expect(wrapper.find('[data-flipped="true"]').exists()).toBe(true);
  });

  it('Esc unflips when flipped', async () => {
    const wrapper = mount(VerbFlipTile, {
      props: { verbKey: 'LEARN', label: 'Learn', iconName: 'learning-assistant',
               tagline: 'T', whyItMatters: 'W', href: '/learn/' },
    });
    const tile = wrapper.find('.hp-flip');
    await tile.trigger('keydown', { key: ' ' });
    expect(wrapper.find('[data-flipped="true"]').exists()).toBe(true);
    await tile.trigger('keydown', { key: 'Escape' });
    expect(wrapper.find('[data-flipped="false"]').exists()).toBe(true);
  });

  it('falls back gracefully when tagline + whyItMatters are empty', () => {
    const wrapper = mount(VerbFlipTile, {
      props: {
        verbKey: 'LEARN', label: 'Learn', iconName: 'learning-assistant',
        tagline: '', whyItMatters: '', href: '/learn/',
      },
    });
    // Component renders without error; flip toggling still works
    expect(wrapper.text()).toContain('Learn');
    expect(wrapper.find('.hp-flip').exists()).toBe(true);
  });

  it('hover-intent fires flip after 250 ms', async () => {
    const wrapper = mount(VerbFlipTile, {
      props: { verbKey: 'LEARN', label: 'Learn', iconName: 'learning-assistant',
               tagline: 'T', whyItMatters: 'W', href: '/learn/' },
    });
    const tile = wrapper.find('.hp-flip');
    await tile.trigger('pointerenter');
    expect(wrapper.find('[data-flipped="false"]').exists()).toBe(true);
    vi.advanceTimersByTime(250);
    await nextTick();
    expect(wrapper.find('[data-flipped="true"]').exists()).toBe(true);
  });

  it('Enter on verb tile does NOT preventDefault (allows <a> navigation)', async () => {
    const wrapper = mount(VerbFlipTile, {
      props: { verbKey: 'LEARN', label: 'Learn', iconName: 'learning-assistant',
               tagline: 'T', whyItMatters: 'W', href: '/learn/' },
    });
    // Manually construct + dispatch a KeyboardEvent to inspect preventDefault.
    const evt = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true, bubbles: true });
    wrapper.element.dispatchEvent(evt);
    expect(evt.defaultPrevented).toBe(false);
    // And: state is unchanged (no flip from Enter).
    expect(wrapper.find('[data-flipped="false"]').exists()).toBe(true);
  });

  it('verb tile renders as <a> with role NOT equal to button', () => {
    const wrapper = mount(VerbFlipTile, {
      props: { verbKey: 'LEARN', label: 'Learn', iconName: 'learning-assistant',
               tagline: 'T', whyItMatters: 'W', href: '/learn/' },
    });
    // Root is <a> — implicit link semantic; explicit role is undefined.
    const a = wrapper.find('a');
    expect(a.exists()).toBe(true);
    expect(a.attributes('role')).toBeUndefined();
    expect(a.attributes('tabindex')).toBeUndefined();
  });

  it('shelf-header mode keeps role="button" + tabindex=0', () => {
    const wrapper = mount(VerbFlipTile, {
      props: { shelfKey: 'START_HERE', label: 'Start here', tagline: 'T', whyItMatters: 'W' },
    });
    const root = wrapper.find('div.hp-flip');
    expect(root.exists()).toBe(true);
    expect(root.attributes('role')).toBe('button');
    expect(root.attributes('tabindex')).toBe('0');
  });
});
