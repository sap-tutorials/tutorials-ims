// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import App from './App.vue';

// Stub ClusterMap.vue so vite never resolves sigma/graphology/fa2 at transform
// time. The brief says App.test.ts must exercise "fetch + data flow WITHOUT a
// real Sigma render" — stubs are the correct pattern here.
vi.mock('./ClusterMap.vue', () => ({
  default: {
    name: 'ClusterMapStub',
    props: ['nodes', 'edges', 'focusCluster'],
    template: '<div class="cluster-map-stub" />',
  },
}));

describe('topics-map App', () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        nodes: [{ id: 'c:hana', slug: 'hana', label: 'HANA', size: 5, type: 'cluster' }],
        edges: [],
      }),
    } as any);
  });

  it('fetches clusters-data on mount without throwing', async () => {
    const wrapper = mount(App, { props: { focusCluster: '' } });
    await new Promise((r) => setTimeout(r, 0));
    expect(globalThis.fetch).toHaveBeenCalledWith(expect.stringContaining('/graph/clusters-data'));
    expect(wrapper.exists()).toBe(true);
  });

  it('degrades quietly when fetch fails — island container not rendered', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('down'));
    const wrapper = mount(App, { props: { focusCluster: '' } });
    await new Promise((r) => setTimeout(r, 0));
    // The v-if="!failed && graphData" gate must suppress the container on error.
    expect(wrapper.find('.topics-map-island').exists()).toBe(false);
    expect(wrapper.exists()).toBe(true); // component itself still mounted, no throw
  });
});
