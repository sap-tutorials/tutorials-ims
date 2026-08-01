// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import App from '../App.vue';

const feed = {
  activeEditionId: 'e1', editions: [{ id: 'e1', name: '2026', isCurrent: true }],
  sessions: [
    { id: 's1', kind: 'session', title: 'With Video', week: '1', youtubeUrl: 'https://youtu.be/abc123', communityEventUrl: 'https://community.sap.com/x' },
    { id: 's2', kind: 'session', title: 'No Video', week: '1', youtubeUrl: '' },
  ],
  activities: [],
};
beforeEach(() => {
  global.fetch = vi.fn((url: string) => Promise.resolve({ ok: true, json: () => Promise.resolve(String(url).includes('my-completions') ? { authenticated: false } : feed) } as any)) as any;
});

describe('Sessions grid', () => {
  it('renders a card per session with a youtube thumbnail when available', async () => {
    const wrapper = mount(App);
    await flushPromises();
    expect(wrapper.text()).toContain('With Video');
    expect(wrapper.text()).toContain('No Video');
    const imgs = wrapper.findAll('img').map((i) => i.attributes('src') || '');
    expect(imgs.some((s) => s.includes('img.youtube.com/vi/abc123'))).toBe(true);
  });
});
