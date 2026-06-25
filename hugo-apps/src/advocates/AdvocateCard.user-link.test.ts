// hugo-apps/src/advocates/AdvocateCard.user-link.test.ts
//
// @vitest-environment happy-dom
//
// Spec: docs/superpowers/specs/2026-06-25-advocate-user-link-design.md §3 + §5
// Component-level tests for AdvocateCard.vue's new user-link affordances:
// mailto link (when advocate.email is present) and tutorial-count pill
// (when authoredTutorials/contributedTutorials are non-empty).
//
// We test the card directly (props-driven) rather than going through App.vue
// + load() because the loading dance + reactive timing makes DOM assertions
// flaky in happy-dom. Card-level tests are stable and focused on the
// behaviour we're adding.

import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import AdvocateCard from './components/AdvocateCard.vue';

const FIXTURE_LINKED = {
  ID: 'a-linked',
  slug: 'a-linked',
  firstName: 'Linked',
  lastName: 'Advocate',
  region: 'AMERICAS' as const,
  title: 'DA',
  topics: [],
  links: [],
  hasPhoto: false,
  email: 'linked@example.com',
  authoredTutorials: [
    { slug: 't-1', title: 'A Tutorial' },
    { slug: 't-2', title: 'B Tutorial' },
    { slug: 't-3', title: 'C Tutorial' },
  ],
  contributedTutorials: [
    { slug: 't-4', title: 'D Tutorial' },
  ],
};

const FIXTURE_UNLINKED = {
  ID: 'a-unlinked',
  slug: 'a-unlinked',
  firstName: 'Unlinked',
  lastName: 'Advocate',
  region: 'EMEA' as const,
  title: 'DA',
  topics: [],
  links: [],
  hasPhoto: false,
};

describe('AdvocateCard.vue — user-link affordances', () => {
  it('renders a mailto: link when advocate.email is present', () => {
    const wrapper = mount(AdvocateCard, {
      props: { advocate: FIXTURE_LINKED, photoBase: '/api/advocates' },
    });
    const mailto = wrapper.find('a[href^="mailto:linked@example.com"]');
    expect(mailto.exists()).toBe(true);
  });

  it('omits the mailto: link when advocate.email is absent', () => {
    const wrapper = mount(AdvocateCard, {
      props: { advocate: FIXTURE_UNLINKED, photoBase: '/api/advocates' },
    });
    const mailtos = wrapper.findAll('a[href^="mailto:"]');
    expect(mailtos.length).toBe(0);
  });

  it('shows authored + contributed tutorial counts when present', () => {
    const wrapper = mount(AdvocateCard, {
      props: { advocate: FIXTURE_LINKED, photoBase: '/api/advocates' },
    });
    expect(wrapper.text()).toMatch(/3\s*authored/i);
    expect(wrapper.text()).toMatch(/1\s*contributed/i);
  });

  it('hides the tutorial-count pill when both arrays are absent', () => {
    const wrapper = mount(AdvocateCard, {
      props: { advocate: FIXTURE_UNLINKED, photoBase: '/api/advocates' },
    });
    const pill = wrapper.find('.adv-tutorials-pill');
    expect(pill.exists()).toBe(false);
  });

  it('shows only the count side that is non-empty', () => {
    // Only authored, no contributed
    const onlyAuthored = {
      ...FIXTURE_UNLINKED,
      authoredTutorials: [{ slug: 't-a', title: 'A' }, { slug: 't-b', title: 'B' }],
    };
    const wrapper = mount(AdvocateCard, {
      props: { advocate: onlyAuthored, photoBase: '/api/advocates' },
    });
    expect(wrapper.text()).toMatch(/2\s*authored/i);
    expect(wrapper.text()).not.toMatch(/contributed/i);
  });
});
