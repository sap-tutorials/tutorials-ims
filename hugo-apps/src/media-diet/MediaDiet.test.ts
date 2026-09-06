// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import MediaDiet from './MediaDiet.vue';

const CHANNELS = [
  { name: 'SAP Learning', url: 'https://learning.sap.com', purpose: 'Official SAP learning portal', focusAreas: ['CAP', 'BTP'] },
  { name: 'SAP Community', url: 'https://community.sap.com', purpose: 'Discussion forums', focusAreas: ['BTP', 'ABAP'] },
  { name: 'SAP YouTube', url: 'https://youtube.com/sapdevs', purpose: 'Video tutorials', focusAreas: ['CAP', 'ABAP', 'BTP'] },
  { name: 'HANA Academy', url: 'https://hana.academy', purpose: 'HANA deep-dives', focusAreas: ['HANA'] },
];

describe('MediaDiet', () => {
  it('renders a list of unique focus areas for selection', () => {
    const wrapper = mount(MediaDiet, { props: { channels: CHANNELS } });
    const text = wrapper.text();
    expect(text).toContain('CAP');
    expect(text).toContain('BTP');
    expect(text).toContain('ABAP');
    expect(text).toContain('HANA');
  });

  it('filters channels client-side when a focus area is selected', async () => {
    const wrapper = mount(MediaDiet, { props: { channels: CHANNELS } });
    // Find the CAP focus area button/checkbox and click it
    const capToggle = wrapper.findAll('[data-focus-area]').find((el) =>
      el.text().includes('CAP'),
    );
    expect(capToggle).toBeDefined();
    await capToggle!.trigger('click');
    // After selecting CAP: SAP Learning, SAP YouTube should appear; HANA Academy should not
    const results = wrapper.find('[data-testid="results"]');
    expect(results.text()).toContain('SAP Learning');
    expect(results.text()).toContain('SAP YouTube');
    expect(results.text()).not.toContain('HANA Academy');
  });

  it('shows no more than 12 results', async () => {
    const manyChannels = Array.from({ length: 20 }, (_, i) => ({
      name: `Channel ${i}`, url: `https://ch${i}.example`, purpose: `Purpose ${i}`,
      focusAreas: ['BTP'],
    }));
    const wrapper = mount(MediaDiet, { props: { channels: manyChannels } });
    const btpToggle = wrapper.findAll('[data-focus-area]').find((el) =>
      el.text().includes('BTP'),
    );
    expect(btpToggle).toBeDefined();
    await btpToggle!.trigger('click');
    // Results should be capped at 12
    const resultItems = wrapper.findAll('[data-testid="result-item"]');
    expect(resultItems.length).toBeLessThanOrEqual(12);
  });

  it('ranks results by match count descending', async () => {
    const wrapper = mount(MediaDiet, { props: { channels: CHANNELS } });
    // Select both CAP and ABAP
    for (const label of ['CAP', 'ABAP']) {
      const toggle = wrapper.findAll('[data-focus-area]').find((el) => el.text().includes(label));
      if (toggle) await toggle.trigger('click');
    }
    const resultItems = wrapper.findAll('[data-testid="result-item"]');
    // SAP YouTube matches both CAP + ABAP (count=2) → should appear before single-match channels
    const names = resultItems.map((el) => el.find('.media-diet-result__name').text());
    const ytIndex = names.indexOf('SAP YouTube');
    const learningIndex = names.indexOf('SAP Learning'); // only CAP
    const communityIndex = names.indexOf('SAP Community'); // only ABAP
    expect(ytIndex).toBeLessThan(learningIndex);
    expect(ytIndex).toBeLessThan(communityIndex);
  });

  it('allows at most 6 focus areas selected simultaneously', async () => {
    const manyAreas = Array.from({ length: 10 }, (_, i) => ({
      name: `Channel ${i}`, url: `https://ch${i}.example`, purpose: `Purpose ${i}`,
      focusAreas: [`Area${i}`],
    }));
    const wrapper = mount(MediaDiet, { props: { channels: manyAreas } });
    const toggles = wrapper.findAll('[data-focus-area]');
    // Click all 10 focus areas
    for (const toggle of toggles) await toggle.trigger('click');
    const selected = wrapper.findAll('[data-focus-area][aria-pressed="true"]');
    expect(selected.length).toBeLessThanOrEqual(6);
    expect(selected.length).toBe(6);
  });

  it('shows a live match count once a focus area is selected', async () => {
    const wrapper = mount(MediaDiet, { props: { channels: CHANNELS } });
    const capToggle = wrapper.findAll('[data-focus-area]').find((el) => el.text().includes('CAP'));
    await capToggle!.trigger('click');
    const count = wrapper.find('[data-testid="result-count"]');
    expect(count.exists()).toBe(true);
    // CAP matches SAP Learning + SAP YouTube = 2
    expect(count.text()).toContain('2');
  });

  it('shows empty-state prompt when no focus area is selected', () => {
    const wrapper = mount(MediaDiet, { props: { channels: CHANNELS } });
    expect(wrapper.text()).toMatch(/pick|select|choose/i);
    const results = wrapper.findAll('[data-testid="result-item"]');
    expect(results).toHaveLength(0);
  });

  it('handles channels with no focusAreas gracefully', () => {
    const sparse = [
      { name: 'Sparse', url: 'https://sparse.example', purpose: 'No focus areas', focusAreas: undefined },
      ...CHANNELS,
    ];
    const wrapper = mount(MediaDiet, { props: { channels: sparse as any } });
    // Should not throw — focus areas list excludes the sparse channel
    expect(wrapper.text()).toContain('CAP');
  });
});
