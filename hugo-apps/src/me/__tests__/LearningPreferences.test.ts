// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import LearningPreferences from '../LearningPreferences.vue';

function mockFetch(routes: Record<string, () => Promise<any>>) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method || 'GET'} ${url}`;
    const handler = routes[key] ?? routes[url];
    if (!handler) throw new Error(`unmocked: ${key}`);
    const result = await handler();
    return {
      ok: result.ok ?? true,
      status: result.status ?? 200,
      json: async () => result.body,
    };
  });
}

describe('LearningPreferences.vue', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('1. mount fetches /api/LearningPreferences AND /api/ChatConfig; Save button disabled', async () => {
    const fetchMock = mockFetch({
      '/api/LearningPreferences': async () => ({ body: { value: [{ deployment: 'cloud', role: null, cloud: 'btp' }] } }),
      '/api/ChatConfig': async () => ({ body: { branchingEnabled: true, enabled: true, bannerText: '' } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(LearningPreferences);
    await new Promise(r => setTimeout(r, 0));
    await wrapper.vm.$nextTick();
    expect(fetchMock).toHaveBeenCalledWith('/api/LearningPreferences', expect.anything());
    expect(fetchMock).toHaveBeenCalledWith('/api/ChatConfig', expect.anything());
    const saveBtn = wrapper.find('ui5-button');
    expect(saveBtn.attributes('disabled')).toBeDefined();
  });

  it('2. change Select → Save enables → click Save → POST all three values; success-strip appears', async () => {
    const fetchMock = mockFetch({
      '/api/LearningPreferences': async () => ({ body: { value: [] } }),
      '/api/ChatConfig': async () => ({ body: { branchingEnabled: true } }),
      'POST /api/setLearningPreferences': async () => {
        return { body: { deployment: 'cloud', role: null, cloud: null } };
      },
    });
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      if (init?.method === 'POST') (global as any).__lastPost = JSON.parse(init.body as string);
      return await fetchMock(url, init);
    }));
    const wrapper = mount(LearningPreferences);
    await new Promise(r => setTimeout(r, 0));
    await wrapper.vm.$nextTick();
    await (wrapper.vm as any).onChange('deployment', { detail: { selectedOption: { value: 'cloud' } } });
    await wrapper.vm.$nextTick();
    await (wrapper.vm as any).onSave();
    await new Promise(r => setTimeout(r, 0));
    expect((global as any).__lastPost).toEqual({ deployment: 'cloud', role: null, cloud: null });
    expect((wrapper.vm as any).status).toBe('saved');
  });

  it('3. server returns 500 → negative-strip appears; Selects keep user values; first Select gets focus', async () => {
    const focusSpy = vi.spyOn(HTMLElement.prototype, 'focus');
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return { ok: false, status: 500, json: async () => ({}) };
      if (url.endsWith('/LearningPreferences')) return { ok: true, json: async () => ({ value: [] }) };
      return { ok: true, json: async () => ({ branchingEnabled: true }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(LearningPreferences);
    await new Promise(r => setTimeout(r, 0));
    await wrapper.vm.$nextTick();
    await (wrapper.vm as any).onChange('deployment', { detail: { selectedOption: { value: 'onprem' } } });
    await (wrapper.vm as any).onSave();
    await new Promise(r => setTimeout(r, 0));
    expect((wrapper.vm as any).status).toBe('error');
    expect((wrapper.vm as any).prefs.deployment).toBe('onprem');  // not reverted
    expect(focusSpy).toHaveBeenCalled();  // a11y: focus moved to first Select on save failure
  });

  it('4. branchingEnabled = false → Information strip rendered; branchingEnabled = true → strip NOT rendered', async () => {
    let fetchMock = vi.fn(async (url: string) => ({
      ok: true, json: async () => url.endsWith('LearningPreferences')
        ? { value: [] } : { branchingEnabled: false },
    }));
    vi.stubGlobal('fetch', fetchMock);
    let wrapper = mount(LearningPreferences);
    await flushPromises();
    expect((wrapper.vm as any).branchingDisabled).toBe(true);

    fetchMock = vi.fn(async (url: string) => ({
      ok: true, json: async () => url.endsWith('LearningPreferences')
        ? { value: [] } : { branchingEnabled: true },
    }));
    vi.stubGlobal('fetch', fetchMock);
    wrapper = mount(LearningPreferences);
    await flushPromises();
    expect((wrapper.vm as any).branchingDisabled).toBe(false);
  });

  it('5. __none__ → null round-trip: pick "— No preference —" → Save → POST body has deployment: null', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        (global as any).__post = JSON.parse(init.body as string);
        return { ok: true, json: async () => ({}) };
      }
      if (url.endsWith('LearningPreferences')) {
        return { ok: true, json: async () => ({ value: [{ deployment: 'cloud', role: 'developer', cloud: 'btp' }] }) };
      }
      return { ok: true, json: async () => ({ branchingEnabled: true }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(LearningPreferences);
    await new Promise(r => setTimeout(r, 0));
    await wrapper.vm.$nextTick();
    expect((wrapper.vm as any).prefs.deployment).toBe('cloud');
    await (wrapper.vm as any).onChange('deployment', { detail: { selectedOption: { value: '__none__' } } });
    await (wrapper.vm as any).onSave();
    await new Promise(r => setTimeout(r, 0));
    expect((global as any).__post).toEqual({ deployment: null, role: 'developer', cloud: 'btp' });
  });
});
