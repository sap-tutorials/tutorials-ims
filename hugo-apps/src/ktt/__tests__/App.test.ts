// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import App from '../App.vue';

const LESSONS = { units: [{ id: 'core', title: 'Core Platform', icon: 'home', order: 1,
  lessons: [{ id: 'core-1', legacyId: 90001, title: 'Meet the Platform', acronyms: [], beats: [] }] }] };

describe('KTT App', () => {
  it('renders the landing screen with a start CTA', () => {
    const wrapper = mount(App, { props: { apiUrl: '/ktt', lessons: LESSONS } });
    expect(wrapper.text()).toContain('Kasimir');
    expect(wrapper.find('[data-testid="ktt-start"]').exists()).toBe(true);
  });
});
