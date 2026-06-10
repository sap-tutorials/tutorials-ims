// @vitest-environment happy-dom
// hugo-apps/src/tutorial-branches/__tests__/SkipPrompt.test.ts
//
// Issue #172 PR 3 — Task 13. Component-level tests for SkipPrompt.vue.
// Pattern mirrors hugo-apps/src/validation/Validation.test.ts.

import { describe, it, expect, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import SkipPrompt from '../SkipPrompt.vue';

const SLUG = 'test-slug';
const STEP_NUM = 4;
const STORAGE_KEY = `tut.branch.skip.${SLUG}.${STEP_NUM}`;

beforeEach(() => {
  localStorage.clear();
});

describe('SkipPrompt', () => {
  it('renders message-strip when skip:true', async () => {
    const wrapper = mount(SkipPrompt, {
      props: {
        slug: SLUG,
        stepNumber: STEP_NUM,
        skipLabel: 'Skip ahead',
        skipReason: 'You finished the prereq',
        decisionsPromise: Promise.resolve({
          branchPoints: [],
          skipPoints: [{
            stepNumber: STEP_NUM,
            skip: true,
            reason: { kind: 'condition', source: 'completed:foo' },
          }],
        }),
      },
    });
    await flushPromises();
    expect(wrapper.find('ui5-message-strip').exists()).toBe(true);
    // skipLabel is the button text inside the message strip.
    expect(wrapper.text()).toContain('Skip ahead');
  });

  it('Skip ahead persists localStorage', async () => {
    const wrapper = mount(SkipPrompt, {
      props: {
        slug: SLUG,
        stepNumber: STEP_NUM,
        skipLabel: 'Skip ahead',
        skipReason: '',
        decisionsPromise: Promise.resolve({
          branchPoints: [],
          skipPoints: [{ stepNumber: STEP_NUM, skip: true, reason: { kind: 'condition' } }],
        }),
      },
    });
    await flushPromises();
    const skipBtn = wrapper.findAll('ui5-button').find(b => b.text().includes('Skip'));
    expect(skipBtn).toBeTruthy();
    await skipBtn!.trigger('click');
    await flushPromises();
    expect(localStorage.getItem(STORAGE_KEY)).toBe('skip');
  });

  it('Read anyway dismisses the message-strip', async () => {
    const wrapper = mount(SkipPrompt, {
      props: {
        slug: SLUG,
        stepNumber: STEP_NUM,
        skipLabel: 'Skip',
        skipReason: '',
        decisionsPromise: Promise.resolve({
          branchPoints: [],
          skipPoints: [{ stepNumber: STEP_NUM, skip: true, reason: { kind: 'condition' } }],
        }),
      },
    });
    await flushPromises();
    expect(wrapper.find('ui5-message-strip').exists()).toBe(true);
    const readBtn = wrapper.findAll('ui5-button').find(b => b.text().includes('Read'));
    expect(readBtn).toBeTruthy();
    await readBtn!.trigger('click');
    await flushPromises();
    expect(wrapper.find('ui5-message-strip').exists()).toBe(false);
  });
});
