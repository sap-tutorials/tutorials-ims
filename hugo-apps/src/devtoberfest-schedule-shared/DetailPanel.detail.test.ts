// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import DetailPanel from './DetailPanel.vue';

const row = {
  id: 's1', kind: 'session', title: 'Test Session',
  youtubeUrl: 'https://www.youtube.com/watch?v=Zmo7YU9BUlc',
  linkedinUrl: 'https://linkedin.com/in/x',
  speakers: [{ id: 'sp1', name: 'Al One', role: 'PM', company: 'SAP', photoUrl: '/api/devtoberfest/speaker/sp1/photo' }],
};

describe('DetailPanel enrichments', () => {
  it('renders an inline youtube embed iframe', () => {
    const w = mount(DetailPanel, { props: { row } });
    const iframe = w.find('iframe.detail-panel__embed');
    expect(iframe.exists()).toBe(true);
    expect(iframe.attributes('src')).toBe('https://www.youtube.com/embed/Zmo7YU9BUlc?enablejsapi=1');
  });
  it('renders a speaker with photo and name', () => {
    const w = mount(DetailPanel, { props: { row } });
    expect(w.find('.detail-panel__speaker').text()).toContain('Al One');
    expect(w.find('.detail-panel__speaker img').attributes('src')).toBe('/api/devtoberfest/speaker/sp1/photo');
  });
  it('renders a LinkedIn link when present', () => {
    const w = mount(DetailPanel, { props: { row } });
    const link = w.find('a.detail-panel__link--linkedin');
    expect(link.exists()).toBe(true);
    expect(link.attributes('href')).toBe('https://linkedin.com/in/x');
  });
});
