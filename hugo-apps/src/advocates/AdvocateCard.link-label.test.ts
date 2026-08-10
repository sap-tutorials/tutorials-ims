// hugo-apps/src/advocates/AdvocateCard.link-label.test.ts
//
// @vitest-environment happy-dom
//
// Issue #1578: the SapCommunity link kind was surfacing the raw enum value
// ("SapCommunity") as its tooltip. It must render the human-readable
// "SAP Community" instead, while an explicit per-link label still wins.
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import AdvocateCard from './components/AdvocateCard.vue';

const advocate = {
  ID: 'A1',
  slug: 'thomas-jung',
  firstName: 'Thomas',
  lastName: 'Jung',
  region: 'AMERICAS',
  hasPhoto: false,
  topics: [],
  links: [
    { kind: 'SapCommunity', url: 'https://community.sap.com/t5/user/x', label: null, sortOrder: 100 },
    { kind: 'BlueSky',      url: 'https://bsky.app/profile/tj',         label: null, sortOrder: 100 },
    { kind: 'GitHub',       url: 'https://github.com/tj',               label: 'My Code', sortOrder: 100 },
  ],
};

describe('AdvocateCard external link tooltips', () => {
  it('maps technical kinds to human-readable labels, never the raw enum', () => {
    const wrapper = mount(AdvocateCard, {
      props: { advocate, photoBase: '/api/advocates' },
    });
    const titles = wrapper.findAll('a.adv-iconbtn').map((a) => a.attributes('title'));
    expect(titles).toContain('SAP Community');
    expect(titles).toContain('Bluesky');
    expect(titles).not.toContain('SapCommunity');
    // An explicit per-link label still takes precedence.
    expect(titles).toContain('My Code');
  });
});
