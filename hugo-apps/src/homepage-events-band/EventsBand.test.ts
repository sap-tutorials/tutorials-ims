// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import EventsBand from './EventsBand.vue';

const CARD = {
  title: 'CAP CodeJam Berlin',
  startsAt: '2099-05-15', endsAt: '2099-05-15',
  location: 'Berlin, Germany', url: 'https://example.com/x',
  eventType: 'codejam', region: 'EMEA', isVirtual: false,
};

function mockFetch(json: any, headers: Record<string,string> = {}) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true, status: 200,
    json: async () => json,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  }) as any;
}

describe('EventsBand', () => {
  beforeEach(() => {
    localStorage.clear();
    (window as any).__homepagePersonalized = undefined;
  });

  it('renders 6 cards from the endpoint', async () => {
    mockFetch(Array(6).fill(CARD));
    const w = mount(EventsBand);
    await flushPromises();
    await w.vm.$nextTick();
    expect(w.findAll('.event-card')).toHaveLength(6);
    expect((global.fetch as any).mock.calls[0][0]).toMatch(/^\/homepage\/events\?/);
  });

  it('renders empty state when the endpoint returns []', async () => {
    mockFetch([]);
    const w = mount(EventsBand);
    await flushPromises();
    await w.vm.$nextTick();
    expect(w.text()).toContain('No upcoming events');
  });

  // (regression) CAP OData function-imports envelope arrays as `{value:[...]}`.
  // Ensure that shape hydrates cards instead of assigning the whole object.
  it('unwraps OData `{value:[...]}` envelope like the live endpoint', async () => {
    mockFetch({ '@odata.context': '$metadata#Collection(x)', value: Array(6).fill(CARD) });
    const w = mount(EventsBand);
    await flushPromises();
    await w.vm.$nextTick();
    expect(w.findAll('.event-card')).toHaveLength(6);
  });

  it('initial region priority: envelope > localStorage > TZ', async () => {
    (window as any).__homepagePersonalized = { eventsRegion: 'APJ' };
    localStorage.setItem('sap-devs-homepage-events-region', 'AMERICAS');
    mockFetch([CARD]);
    mount(EventsBand);
    await new Promise(r => setTimeout(r, 0));
    const call = (global.fetch as any).mock.calls[0][0] as string;
    expect(call).toContain('region=APJ');
  });

  it('falls back to localStorage when no envelope', async () => {
    localStorage.setItem('sap-devs-homepage-events-region', 'AMERICAS');
    mockFetch([CARD]);
    mount(EventsBand);
    await new Promise(r => setTimeout(r, 0));
    const call = (global.fetch as any).mock.calls[0][0] as string;
    expect(call).toContain('region=AMERICAS');
  });

  it('chip click refetches with new region + writes localStorage', async () => {
    mockFetch([CARD]);
    const w = mount(EventsBand);
    await new Promise(r => setTimeout(r, 0));
    await w.findAll('.events-band__chip')[2].trigger('click');   // EMEA
    await new Promise(r => setTimeout(r, 0));
    // The EMEA events fetch is the last call (.at(-1)); setPreferredEventRegion
    // is skipped because isSignedIn() returns false without a JSESSIONID cookie
    // or __homepagePersonalized in the test environment.
    const lastCall = (global.fetch as any).mock.calls.at(-1)[0] as string;
    expect(lastCall).toMatch(/^\/homepage\/events\?.*region=EMEA/);
    expect(localStorage.getItem('sap-devs-homepage-events-region')).toBe('EMEA');
  });
});
