// @vitest-environment happy-dom

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import Carousel from './Carousel.vue';

const slides = [
  { conceptSlug: 'cap',  displayTitle: 'CAP',  missionsHtml: '<a>1</a>' },
  { conceptSlug: 'hana', displayTitle: 'HANA', missionsHtml: '<a>2</a>' },
];

function fakeRoot() {
  const el = document.createElement('section');
  document.body.appendChild(el);
  return el;
}

beforeEach(() => {
  document.body.innerHTML = '';
  // Clear any hash set by previous tests (jumpTo calls history.replaceState,
  // which sets location.hash; useDeepLink on the next mount would pick it up
  // and set active to the wrong slide).
  history.replaceState(null, '', '#');
  vi.stubGlobal('fetch', vi.fn(async () => ({ status: 304, ok: false, json: async () => ({}) })));
});

describe('Carousel', () => {
  it('renders SSR slides on mount', () => {
    const w = mount(Carousel, { props: { root: fakeRoot(), initialEtag: 'W/"abc"', initialSlides: slides } });
    expect(w.findAll('.hp-featured-carousel__slide')).toHaveLength(2);
    expect(w.find('.is-active .hp-featured-carousel__topic').text()).toBe('CAP');
  });

  it('advances after 30s of auto-advance', async () => {
    vi.useFakeTimers();
    const w = mount(Carousel, { props: { root: fakeRoot(), initialEtag: '', initialSlides: slides } });
    await vi.advanceTimersByTimeAsync(30_500);
    expect(w.find('.is-active .hp-featured-carousel__topic').text()).toBe('HANA');
    vi.useRealTimers();
  });

  it('manual next stops auto-advance', async () => {
    vi.useFakeTimers();
    const w = mount(Carousel, { props: { root: fakeRoot(), initialEtag: '', initialSlides: slides } });
    await w.find('button[aria-label="Next topic"]').trigger('click');
    expect(w.find('.is-active .hp-featured-carousel__topic').text()).toBe('HANA');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(w.find('.is-active .hp-featured-carousel__topic').text()).toBe('HANA'); // did not advance
    vi.useRealTimers();
  });

  it('respects prefers-reduced-motion by not auto-advancing', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
    vi.useFakeTimers();
    const w = mount(Carousel, { props: { root: fakeRoot(), initialEtag: '', initialSlides: slides } });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(w.find('.is-active .hp-featured-carousel__topic').text()).toBe('CAP');
    vi.useRealTimers();
  });

  it('dot click stops auto-advance', async () => {
    vi.useFakeTimers();
    const w = mount(Carousel, { props: { root: fakeRoot(), initialEtag: '', initialSlides: slides } });
    const dots = w.findAll('button[role="tab"]');
    await dots[dots.length - 1].trigger('click');
    expect(w.find('.is-active .hp-featured-carousel__topic').text()).toBe('HANA');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(w.find('.is-active .hp-featured-carousel__topic').text()).toBe('HANA'); // still HANA
    vi.useRealTimers();
  });

  it('ArrowRight key advances and stops auto-advance', async () => {
    vi.useFakeTimers();
    const w = mount(Carousel, { props: { root: fakeRoot(), initialEtag: '', initialSlides: slides } });
    await w.find('.hp-featured-carousel__viewport').trigger('keydown', { key: 'ArrowRight' });
    expect(w.find('.is-active .hp-featured-carousel__topic').text()).toBe('HANA');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(w.find('.is-active .hp-featured-carousel__topic').text()).toBe('HANA');
    vi.useRealTimers();
  });
});

const TOP_PAYLOAD = { windows: [
  { windowDays: 90,  items: [{ rank: 1, slug: 'x', completions: 3, card: { slug: 'x', title: 'X90', description: '', level: 'beginner', time: 10, primaryTag: 'T', href: '/tutorials/x', isNew: false } }] },
  { windowDays: 180, items: [{ rank: 1, slug: 'y', completions: 7, card: { slug: 'y', title: 'Y180', description: '', level: 'beginner', time: 10, primaryTag: 'T', href: '/tutorials/y', isNew: false } }] },
  { windowDays: 360, items: [{ rank: 1, slug: 'z', completions: 9, card: { slug: 'z', title: 'Z360', description: '', level: 'beginner', time: 10, primaryTag: 'T', href: '/tutorials/z', isNew: false } }] },
] };

function mountCarousel() {
  const root = document.createElement('section');
  return mount(Carousel, { props: {
    root, initialEtag: '',
    initialSlides: [{ conceptSlug: 'feat-1', displayTitle: 'Featured Topic', missionsHtml: '<a class="nav-card">F</a>' }],
  } });
}

describe('Carousel — Top Tutorials mode (#1782)', () => {
  beforeEach(() => {
    localStorage.clear();
    // Featured hydrate + top-tutorials both go through fetch; return the top payload
    // for the topTutorials() call and a 304-ish empty for featured hydrate.
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('topTutorials')) {
        return { ok: true, status: 200, json: async () => TOP_PAYLOAD } as any;
      }
      return { ok: false, status: 304, json: async () => ({}) } as any;
    }));
  });

  it('defaults to Featured mode showing the SSR slide', () => {
    const wrapper = mountCarousel();
    expect(wrapper.vm.mode).toBe('featured');
    expect(wrapper.text()).toContain('Featured Topic');
  });

  it('flips to Top Tutorials, fetches once, defaults to the 180-day window', async () => {
    const wrapper = mountCarousel();
    await wrapper.vm.switchMode('top');
    await flushPromises();
    expect(wrapper.vm.windowDays).toBe(180);
    expect(wrapper.text()).toContain('Top Tutorials · Last 180 days');
    expect(wrapper.text()).toContain('Y180');
  });

  it('switching windows re-renders from cached data with no refetch', async () => {
    const wrapper = mountCarousel();
    await wrapper.vm.switchMode('top');
    await flushPromises();
    const calls = (globalThis.fetch as any).mock.calls.filter((c: any[]) => String(c[0]).includes('topTutorials')).length;
    await wrapper.vm.setWindow(360);
    await flushPromises();
    expect(wrapper.text()).toContain('Z360');
    const after = (globalThis.fetch as any).mock.calls.filter((c: any[]) => String(c[0]).includes('topTutorials')).length;
    expect(after).toBe(calls); // no second topTutorials fetch
    expect(localStorage.getItem('sap-devs-homepage-top-tutorials-window')).toBe('360');
  });

  it('honors a persisted window on first flip', async () => {
    localStorage.setItem('sap-devs-homepage-top-tutorials-window', '90');
    const wrapper = mountCarousel();
    await wrapper.vm.switchMode('top');
    await flushPromises();
    expect(wrapper.vm.windowDays).toBe(90);
    expect(wrapper.text()).toContain('X90');
  });
});
