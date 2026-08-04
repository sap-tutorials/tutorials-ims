// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { nextTick } from 'vue';
import DetailPanel from './DetailPanel.vue';

const row = { id: 's1', kind: 'session', title: 'T', youtubeUrl: 'https://www.youtube.com/watch?v=Zmo7YU9BUlc' };

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true, json: async () => ({ videoId: 'Zmo7YU9BUlc', source: 'auto', lang: 'en', segments: [{ start: 12, text: 'hello' }] }),
  })));
});

describe('DetailPanel transcript', () => {
  it('loads and renders transcript lines when expanded', async () => {
    const w = mount(DetailPanel, { props: { row } });
    await w.find('button.detail-panel__enlarge').trigger('click');
    await w.find('button.detail-panel__transcript-toggle').trigger('click');
    await flushPromises();
    w.vm.$forceUpdate();
    await nextTick();
    expect(w.find('.detail-panel__transcript').text()).toContain('hello');
    expect(w.find('.detail-panel__transcript').text()).toContain('auto-generated');
  });
});
