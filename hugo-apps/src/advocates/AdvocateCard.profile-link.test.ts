// hugo-apps/src/advocates/AdvocateCard.profile-link.test.ts
//
// @vitest-environment happy-dom
//
// Issue #601: card "View profile →" link points at the internal
// /developer-advocates/<slug>/ page, not at the first external profile
// URL (which is what the pre-#601 behavior was).
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import AdvocateCard from './components/AdvocateCard.vue';

const baseAdvocate = {
  ID: 'A1',
  slug: 'thomas-jung',
  firstName: 'Thomas',
  lastName: 'Jung',
  region: 'AMERICAS',
  hasPhoto: false,
  topics: [],
  links: [
    { kind: 'LinkedIn', url: 'https://linkedin.com/in/tj', label: null, sortOrder: 100 },
    { kind: 'GitHub',   url: 'https://github.com/tj',     label: null, sortOrder: 100 },
  ],
};

describe('AdvocateCard "View profile" link', () => {
  it('points at /developer-advocates/<slug>/ (internal nav, no new tab)', () => {
    const wrapper = mount(AdvocateCard, {
      props: { advocate: baseAdvocate, photoBase: '/api/advocates' },
    });
    const link = wrapper.find('a.adv-profile');
    expect(link.exists()).toBe(true);
    expect(link.attributes('href')).toBe('/developer-advocates/thomas-jung/');
    // In-site nav: no new-tab open, so target/rel should be absent.
    expect(link.attributes('target')).toBeUndefined();
  });
});
