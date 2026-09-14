// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import KasimirStage from '../components/KasimirStage.vue';

describe('KasimirStage', () => {
  it('reflects mood in the root class and is aria-hidden', () => {
    const w = mount(KasimirStage, { props: { mood: 'celebrate' } });
    const root = w.find('.kasimir');
    expect(root.classes()).toContain('kasimir--celebrate');
    expect(root.attributes('aria-hidden')).toBe('true');
    expect(w.find('svg').exists()).toBe(true);
  });
  it('switches class when mood changes', async () => {
    const w = mount(KasimirStage, { props: { mood: 'idle' } });
    await w.setProps({ mood: 'wrong' });
    expect(w.find('.kasimir').classes()).toContain('kasimir--wrong');
  });
});
