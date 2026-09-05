// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import ChannelsHealth from './ChannelsHealth.vue';

const SAMPLE_STATS = {
  total: 150,
  publishedCount: 120,
  byStatus: { Active: 110, Archived: 30, Closed: 10 },
  byOwnerType: { SAP_Official: 50, Community_Member: 80, SAP_Developer_Advocate: 20 },
  byCategory: { Documentation: 45, Community: 60, 'Developer Tools': 45 },
  bySubcategory: { 'API Docs': 20, Forum: 30 },
  sapVsCommunity: { sap: 70, community: 80 },
  activeVsInactive: { active: 110, inactive: 40 },
  buildAt: '2026-09-05T10:00:00.000Z',
  error: null,
};

describe('ChannelsHealth', () => {
  it('renders the total channel count', () => {
    const wrapper = mount(ChannelsHealth, { props: { stats: SAMPLE_STATS } });
    expect(wrapper.text()).toContain('150');
  });

  it('renders active vs inactive counts', () => {
    const wrapper = mount(ChannelsHealth, { props: { stats: SAMPLE_STATS } });
    expect(wrapper.text()).toContain('110');
    expect(wrapper.text()).toContain('40');
  });

  it('renders SAP vs community counts', () => {
    const wrapper = mount(ChannelsHealth, { props: { stats: SAMPLE_STATS } });
    expect(wrapper.text()).toContain('70');
    expect(wrapper.text()).toContain('80');
  });

  it('renders status breakdown entries', () => {
    const wrapper = mount(ChannelsHealth, { props: { stats: SAMPLE_STATS } });
    expect(wrapper.text()).toContain('Active');
    expect(wrapper.text()).toContain('Archived');
  });

  it('renders category coverage entries', () => {
    const wrapper = mount(ChannelsHealth, { props: { stats: SAMPLE_STATS } });
    expect(wrapper.text()).toContain('Documentation');
    expect(wrapper.text()).toContain('Community');
  });

  it('does NOT render any panel referencing linkStatus, lastChecked, or updateFrequency', () => {
    const wrapper = mount(ChannelsHealth, { props: { stats: SAMPLE_STATS } });
    const html = wrapper.html();
    expect(html).not.toMatch(/linkStatus/i);
    expect(html).not.toMatch(/lastChecked/i);
    expect(html).not.toMatch(/updateFrequency/i);
    expect(html).not.toMatch(/link status/i);
    expect(html).not.toMatch(/last checked/i);
    expect(html).not.toMatch(/update frequency/i);
  });

  it('shows empty-state message when stats.total is 0', () => {
    const empty = { ...SAMPLE_STATS, total: 0, publishedCount: 0, byStatus: {}, byOwnerType: {}, byCategory: {}, bySubcategory: {}, sapVsCommunity: { sap: 0, community: 0 }, activeVsInactive: { active: 0, inactive: 0 } };
    const wrapper = mount(ChannelsHealth, { props: { stats: empty } });
    expect(wrapper.text()).toMatch(/no channel data|loading|stats not/i);
  });
});
