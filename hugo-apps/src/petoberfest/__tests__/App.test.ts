// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { nextTick } from 'vue';
import { mount, flushPromises } from '@vue/test-utils';

vi.mock('../lib/server', () => ({
  fetchSlideshow: vi.fn().mockResolvedValue([
    { id: 'a', petName: 'Rex', uploaderName: 'Tom', uploadedAt: '' },
    { id: 'b', petName: 'Milo', uploaderName: 'Sam', uploadedAt: '' },
    { id: 'c', petName: 'Kit', uploaderName: 'Lee', uploadedAt: '' },
  ]),
  fetchMyUploads: vi.fn().mockResolvedValue([]),
  uploadPet: vi.fn(),
  probeAuth: vi.fn().mockResolvedValue(false),
  photoUrl: (id: string) => `/petoberfest-api/photo/${id}?size=display`,
}));

import App from '../App.vue';
import { probeAuth } from '../lib/server';

describe('petoberfest login gate', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('shows the sign-in prompt and hides the upload form when not logged in', async () => {
    vi.mocked(probeAuth).mockResolvedValueOnce(false);
    const w = mount(App, { props: { slug: 'petoberfest-2026' } });
    await flushPromises();
    expect(w.text()).toContain('Sign in to add your pet');
    expect(w.find('input[type="file"]').exists()).toBe(false);
    expect(w.findAll('button').some((b) => b.text() === 'Upload')).toBe(false);
  });

  it('shows the upload form and hides the sign-in prompt when logged in', async () => {
    vi.mocked(probeAuth).mockResolvedValueOnce(true);
    const w = mount(App, { props: { slug: 'petoberfest-2026' } });
    await flushPromises();
    expect(w.text()).not.toContain('Sign in to add your pet');
    expect(w.find('input[type="file"]').exists()).toBe(true);
    expect(w.findAll('button').some((b) => b.text() === 'Upload')).toBe(true);
  });
});

describe('petoberfest slideshow controls', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('advances automatically when playing, stops when paused', async () => {
    const w = mount(App, { props: { slug: 'petoberfest-2026' } });
    await flushPromises();               // resolve fetchSlideshow
    expect(w.vm.idx).toBe(0);
    vi.advanceTimersByTime(5000);
    expect(w.vm.idx).toBe(1);            // auto-advanced
    w.vm.togglePlay();                    // pause
    vi.advanceTimersByTime(5000);
    expect(w.vm.idx).toBe(1);            // stayed put while paused
  });

  it('prev/next/goTo change the slide regardless of pause', async () => {
    const w = mount(App, { props: { slug: 'petoberfest-2026' } });
    await flushPromises();
    w.vm.togglePlay();                    // pause first
    w.vm.next(); expect(w.vm.idx).toBe(1);
    w.vm.next(); expect(w.vm.idx).toBe(2);
    w.vm.next(); expect(w.vm.idx).toBe(0);   // wraps
    w.vm.prev(); expect(w.vm.idx).toBe(2);   // wraps back
    w.vm.goTo(1); expect(w.vm.idx).toBe(1);
  });

  it('randomizes slide order on mount, preserving every entry (no drops/dupes)', async () => {
    const w = mount(App, { props: { slug: 'petoberfest-2026' } });
    await flushPromises();
    w.vm.togglePlay();                    // pause so next() steps deterministically
    const seen: string[] = [];
    for (let i = 0; i < 3; i++) {
      seen.push(w.find('.pet-caption strong').text());
      w.vm.next();
      await nextTick();
    }
    expect(seen.slice().sort()).toEqual(['Kit', 'Milo', 'Rex']);
  });

  it('applies the Fisher–Yates shuffle (deterministic with mocked RNG)', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);   // forces [b,c,a] → Milo first
    const w = mount(App, { props: { slug: 'petoberfest-2026' } });
    await flushPromises();
    expect(w.find('.pet-caption strong').text()).toBe('Milo');
  });
});
