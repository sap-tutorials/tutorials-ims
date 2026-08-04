// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import DetailPanel from './DetailPanel.vue';

const row = { id: 's1', kind: 'session', title: 'Test' };

describe('DetailPanel enlarge', () => {
  it('toggles wide class when the enlarge button is clicked', async () => {
    const w = mount(DetailPanel, { props: { row } });
    expect(w.find('.detail-panel__drawer--wide').exists()).toBe(false);
    await w.find('button.detail-panel__enlarge').trigger('click');
    await nextTick();
    // happy-dom doesn't auto-update DOM on ref changes; force update
    w.vm.$forceUpdate();
    await nextTick();
    expect(w.find('.detail-panel__drawer--wide').exists()).toBe(true);
  });
});
