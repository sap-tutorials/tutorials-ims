// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import ChannelsDirectory from './ChannelsDirectory.vue';

describe('ChannelsDirectory — hub band', () => {
  const wrapper = () => mount(ChannelsDirectory, { props: { channels: [], collections: [] } });

  it('renders three hub navigation cards', () => {
    const links = wrapper().findAll('.channels-hub-band__cards a');
    expect(links).toHaveLength(3);
  });

  it('card hrefs include atlas, health, and media-diet', () => {
    const hrefs = wrapper().findAll('.channels-hub-band__cards a').map((l) => l.attributes('href'));
    expect(hrefs).toContain('/channels/atlas/');
    expect(hrefs).toContain('/channels/health/');
    expect(hrefs).toContain('/channels/media-diet/');
  });

  it('does not link to the unbuilt crosswalk page', () => {
    const hrefs = wrapper().findAll('.channels-hub-band__cards a').map((l) => l.attributes('href'));
    expect(hrefs).not.toContain('/channels/crosswalk/');
  });

  it('hub band appears in DOM before the filter controls', () => {
    const html = wrapper().html();
    const hubPos = html.indexOf('channels-hub-band');
    const ctrlPos = html.indexOf('channels-directory__controls');
    expect(hubPos).toBeGreaterThan(-1);
    expect(hubPos).toBeLessThan(ctrlPos);
  });

  it('each card has a title and an icon name', () => {
    const cards = wrapper().findAll('.channels-hub-band__cards li');
    expect(cards).toHaveLength(3);
    for (const card of cards) {
      expect(card.find('.hub-card__title').text()).toBeTruthy();
      const icon = card.find('ui5-icon');
      expect(icon.attributes('name')).toBeTruthy();
    }
  });
});
