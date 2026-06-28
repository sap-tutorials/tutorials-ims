// @vitest-environment happy-dom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import EventsBand from './EventsBand.vue';

// Spec: docs/superpowers/specs/2026-06-28-homepage-icon-events-refinement-design.md
//
// Locks in the empty-vs-error split. The combined branch shipped to DEV
// said "Could not load upcoming events" whenever the array was empty,
// even on a clean fetch — so a fresh environment looked broken. These
// tests fail if anyone collapses the two branches back together.

interface EventCard {
  title: string;
  startsAt: string;
  location: string;
  format: string;
  register: string | null;
}

const FALLBACK_LINK_HREF = 'https://community.sap.com/t5/sap-events/ct-p/events';

describe('EventsBand.vue', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('renders four loading skeleton placeholders while the fetch is in flight', async () => {
    // Fetch never resolves during this assertion window — we check
    // the synchronous initial render before any await.
    globalThis.fetch = vi.fn(() => new Promise(() => { /* pending forever */ })) as unknown as typeof globalThis.fetch;

    const wrapper = mount(EventsBand);
    // No flushPromises — we want the loading state.
    const skeletons = wrapper.findAll('.hb-events-band__skel');
    expect(skeletons).toHaveLength(4);
  });

  it('shows "Could not load upcoming events." when the fetch rejects', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network')) as unknown as typeof globalThis.fetch;

    const wrapper = mount(EventsBand);
    await flushPromises();

    const text = wrapper.text();
    expect(text).toContain('Could not load upcoming events.');
    expect(text).not.toContain('No upcoming events scheduled.');
    expect(wrapper.find(`a[href="${FALLBACK_LINK_HREF}"]`).exists()).toBe(true);
    expect(wrapper.findAll('.hb-events-band__card')).toHaveLength(0);
  });

  it('shows "No upcoming events scheduled." when the fetch returns an empty array', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ value: [] }),
    } as unknown as Response) as unknown as typeof globalThis.fetch;

    const wrapper = mount(EventsBand);
    await flushPromises();

    const text = wrapper.text();
    expect(text).toContain('No upcoming events scheduled.');
    expect(text).not.toContain('Could not load upcoming events.');
    expect(wrapper.find(`a[href="${FALLBACK_LINK_HREF}"]`).exists()).toBe(true);
    expect(wrapper.findAll('.hb-events-band__card')).toHaveLength(0);
  });

  it('renders one card per event with the correct format chip class', async () => {
    const events: EventCard[] = [
      { title: 'SAP Sapphire',  startsAt: '2030-05-15T09:00:00Z', location: 'Orlando',  format: 'in-person', register: 'https://example.test/sapphire' },
      { title: 'Virtual Bytes', startsAt: '2030-06-01T13:00:00Z', location: 'Zoom',     format: 'virtual',   register: null },
      { title: 'TechEd Hybrid', startsAt: '2030-09-20T10:00:00Z', location: 'Barcelona', format: 'hybrid',    register: 'https://example.test/teched' },
    ];
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ value: events }),
    } as unknown as Response) as unknown as typeof globalThis.fetch;

    const wrapper = mount(EventsBand);
    await flushPromises();

    const cards = wrapper.findAll('.hb-events-band__card');
    expect(cards).toHaveLength(3);

    // Verify format → chip-class mapping per EventsBand.vue formatChipClass()
    expect(cards[0].find('.hb-chip--inperson').exists()).toBe(true);
    expect(cards[1].find('.hb-chip--virtual').exists()).toBe(true);
    expect(cards[2].find('.hb-chip--hybrid').exists()).toBe(true);

    // Title + location render
    expect(cards[0].text()).toContain('SAP Sapphire');
    expect(cards[0].text()).toContain('Orlando');

    // Register link present when URL is provided; "Registration TBD" placeholder when null
    expect(cards[0].find('a.hb-events-band__register').attributes('href')).toBe('https://example.test/sapphire');
    expect(cards[1].text()).toContain('Registration TBD');
    expect(cards[2].find('a.hb-events-band__register').attributes('href')).toBe('https://example.test/teched');
  });
});
