// @vitest-environment happy-dom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import VideoBand from './VideoBand.vue';

// (#1007) The previous VideoBand.vue dispatch treated a null/missing `featured`
// as "no data at all" and wiped `recent`, so the band rendered empty even when
// the srv had delivered three videos through its ext.Videos fallback. These
// tests fail if anyone re-collapses those two branches.

describe('VideoBand.vue', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('renders the three recent cards even when featured is null (server-side fallback path)', async () => {
    const payload = {
      featured: null,
      recent: [
        { videoId: 'r1', title: 'Fallback newest',  thumbnail: 'https://yt/r1.jpg', publishedAt: '2026-07-01T00:00:00Z' },
        { videoId: 'r2', title: 'Fallback middle',  thumbnail: 'https://yt/r2.jpg', publishedAt: '2026-06-15T00:00:00Z' },
        { videoId: 'r3', title: 'Fallback oldest',  thumbnail: 'https://yt/r3.jpg', publishedAt: '2026-06-01T00:00:00Z' },
      ],
      error: 'YouTube API 400',
    };
    const mockFetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', mockFetch);

    const wrapper = mount(VideoBand, { attachTo: document.body });
    // Sequence to await: fetch microtask → .json() microtask → Vue re-render
    // scheduler. Six flushes + two nextTicks covers even the pessimistic case
    // where applyVideoFilter yields queued microtasks. Fewer than this leaves
    // the DOM stuck in the loading skeleton state.
    for (let i = 0; i < 6; i++) await flushPromises();
    await wrapper.vm.$nextTick();
    await wrapper.vm.$nextTick();

    const cards = wrapper.findAll('a.hb-video-band__recent-card');
    expect(cards).toHaveLength(3);
    expect(cards[0].text()).toContain('Fallback newest');
    expect(cards[1].text()).toContain('Fallback middle');
    expect(cards[2].text()).toContain('Fallback oldest');

    // Featured column falls back to the "Watch on @sapdevs" placeholder card
    // because featured is null (see VideoBand.vue's v-else).
    expect(wrapper.find('a.hb-video-band__error-card').exists()).toBe(true);
    // No skeleton and no top-level error branch — we DID get data, just no featured.
    expect(wrapper.find('.hb-video-band__skel').exists()).toBe(false);
    expect(wrapper.find('.hb-video-band__error').exists()).toBe(false);
    wrapper.unmount();
  });

  it('renders featured + recent when the shaped response supplies both', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify({
      featured: { videoId: 'feat', title: 'The featured one', thumbnail: 'https://yt/feat.jpg', publishedAt: '2026-07-02T00:00:00Z' },
      recent: [
        { videoId: 'r1', title: 'A', thumbnail: 'https://yt/a.jpg', publishedAt: '2026-06-15T00:00:00Z' },
      ],
      error: null,
    }), { status: 200, headers: { 'content-type': 'application/json' } })));

    const wrapper = mount(VideoBand, { attachTo: document.body });
    for (let i = 0; i < 6; i++) await flushPromises();
    await wrapper.vm.$nextTick();
    await wrapper.vm.$nextTick();

    expect(wrapper.find('a.hb-video-band__featured-link').exists()).toBe(true);
    expect(wrapper.text()).toContain('The featured one');
    expect(wrapper.findAll('a.hb-video-band__recent-card')).toHaveLength(1);
    wrapper.unmount();
  });

  it('shows the error state only when the fetch itself rejects', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));

    const wrapper = mount(VideoBand, { attachTo: document.body });
    for (let i = 0; i < 6; i++) await flushPromises();
    await wrapper.vm.$nextTick();
    await wrapper.vm.$nextTick();

    // hb-video-band__error is the top-level error rail (only rendered when
    // `error` ref is set — which happens on fetch rejection, not on a live
    // response with error:'…' as one of its fields).
    expect(wrapper.find('.hb-video-band__error').exists()).toBe(true);
    expect(wrapper.findAll('a.hb-video-band__recent-card')).toHaveLength(0);
    wrapper.unmount();
  });
});
