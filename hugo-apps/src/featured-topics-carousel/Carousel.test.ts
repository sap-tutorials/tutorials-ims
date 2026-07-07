// @vitest-environment happy-dom

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
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
});
