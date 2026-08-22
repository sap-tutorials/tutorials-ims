// hugo-apps/src/advocates/AdvocateCard.a11y.test.ts
//
// @vitest-environment happy-dom
//
// Locks in the accessibility fixes for the advocate flip card:
//  - the wrapper is NOT role="button" (a button must not contain the back-face
//    email/social/profile links — axe nested-interactive).
//  - the front-face name is an <h2> (page has a single <h1>; jumping to <h3>
//    tripped axe heading-order), and the back-face name is not a second heading.
//  - the scrollable bio is keyboard-focusable (axe scrollable-region-focusable),
//    revealed via .adv-flipwrap:focus-within.
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import AdvocateCard from './components/AdvocateCard.vue';

const advocate = {
  ID: 'A1',
  slug: 'thomas-jung',
  firstName: 'Thomas',
  lastName: 'Jung',
  title: 'Chief Developer Advocate',
  region: 'AMERICAS',
  bio: 'A long bio that scrolls.',
  hasPhoto: false,
  topics: [],
  links: [{ kind: 'GitHub', url: 'https://github.com/tj', label: null, sortOrder: 100 }],
  email: 'tj@example.com',
};

describe('AdvocateCard accessibility', () => {
  const wrapper = mount(AdvocateCard, { props: { advocate, photoBase: '/api/advocates' } });

  it('does not make the wrapper a role=button (avoids nested interactive links)', () => {
    const wrap = wrapper.find('.adv-flipwrap');
    expect(wrap.attributes('role')).toBeUndefined();
    expect(wrap.attributes('aria-pressed')).toBeUndefined();
    expect(wrap.attributes('tabindex')).toBeUndefined();
  });

  it('uses a single h2 for the card name and no heading on the back face', () => {
    const headings = wrapper.findAll('h1, h2, h3, h4, h5, h6');
    expect(headings).toHaveLength(1);
    expect(headings[0].element.tagName).toBe('H2');
    expect(headings[0].text()).toContain('Thomas Jung');
  });

  it('makes the scrollable bio keyboard-focusable', () => {
    expect(wrapper.find('.adv-bio').attributes('tabindex')).toBe('0');
  });
});
