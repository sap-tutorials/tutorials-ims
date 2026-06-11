// @vitest-environment happy-dom
// hugo-apps/src/tutorial-branches/__tests__/BranchPicker.test.ts
//
// Issue #172 PR 3 — Task 13. Component-level tests for BranchPicker.vue.
// Pattern mirrors hugo-apps/src/validation/Validation.test.ts (happy-dom +
// @vue/test-utils + flushPromises after onMounted async work).

import { describe, it, expect, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import BranchPicker from '../BranchPicker.vue';

const baseBranches = [
  {
    key: 'hana',
    label: 'HANA Cloud',
    condition: "profile.deployment == 'cloud'",
    embeddingHint: 'Configure HANA',
    steps: [{ title: 'Sub HANA', body: 'HANA content' }],
  },
  {
    key: 'postgres',
    label: 'PostgreSQL',
    condition: null,
    embeddingHint: 'Configure PG',
    steps: [{ title: 'Sub PG', body: 'PG content' }],
  },
];

const SLUG = 'test-slug';
const BPID = '1-deployment';
const STORAGE_KEY = `tut.branch.tutorial.${SLUG}.${BPID}`;

beforeEach(() => {
  localStorage.clear();
});

describe('BranchPicker', () => {
  it('renders one segmented-button-item per branch', async () => {
    const wrapper = mount(BranchPicker, {
      props: {
        slug: SLUG,
        branchPointId: BPID,
        groupKey: 'deployment',
        branches: baseBranches,
        override: null,
        decisionsPromise: Promise.resolve(null),
      },
    });
    await flushPromises();
    expect(wrapper.findAll('ui5-segmented-button-item').length).toBe(2);
  });

  it('marks the recommended branch and shows the reason chip', async () => {
    // Pre-seed localStorage to 'postgres' so selectedKey != recommendedKey.
    // The recommendation chip's v-if guard is recommendedKey !== selectedKey;
    // without a prior selection the recommendation auto-adopts and the chip
    // suppresses itself.
    localStorage.setItem(STORAGE_KEY, 'postgres');

    const wrapper = mount(BranchPicker, {
      props: {
        slug: SLUG,
        branchPointId: BPID,
        groupKey: 'deployment',
        branches: baseBranches,
        override: null,
        decisionsPromise: Promise.resolve({
          branchPoints: [{
            id: BPID,
            recommendation: {
              picked: 'hana',
              reason: { kind: 'condition', source: "profile.deployment == 'cloud'" },
              confidence: 1.0,
            },
          }],
          skipPoints: [],
        }),
      },
    });
    await flushPromises();

    const items = wrapper.findAll('ui5-segmented-button-item');
    // Find the HANA item by its rendered label text.
    const hanaItem = items.find(i => i.text().includes('HANA Cloud'));
    expect(hanaItem).toBeTruthy();
    expect(hanaItem!.attributes('data-recommended')).toBe('true');
    expect(wrapper.text()).toMatch(/Recommended because profile\.deployment/);
  });

  it('click swaps the visible branch and persists localStorage', async () => {
    const wrapper = mount(BranchPicker, {
      props: {
        slug: SLUG,
        branchPointId: BPID,
        groupKey: 'deployment',
        branches: baseBranches,
        override: null,
        decisionsPromise: Promise.resolve(null),
      },
    });
    await flushPromises();

    const items = wrapper.findAll('ui5-segmented-button-item');
    const pgItem = items.find(i => i.text().includes('PostgreSQL'));
    expect(pgItem).toBeTruthy();
    await pgItem!.trigger('click');
    await flushPromises();
    expect(localStorage.getItem(STORAGE_KEY)).toBe('postgres');
  });

  it('URL override pre-selects the overridden branch + suppresses standard chip when override matches recommendation', async () => {
    // Override matches the system pick → no chip variant should render.
    const wrapper = mount(BranchPicker, {
      props: {
        slug: SLUG,
        branchPointId: BPID,
        groupKey: 'deployment',
        branches: baseBranches,
        override: 'postgres',
        decisionsPromise: Promise.resolve({
          branchPoints: [{
            id: BPID,
            recommendation: {
              picked: 'postgres', // matches override → chip naturally absent
              reason: { kind: 'condition', source: 'p' },
              confidence: 1.0,
            },
          }],
          skipPoints: [],
        }),
      },
    });
    await flushPromises();

    const items = wrapper.findAll('ui5-segmented-button-item');
    const pgItem = items.find(i => i.text().includes('PostgreSQL'));
    const hanaItem = items.find(i => i.text().includes('HANA Cloud'));
    expect(pgItem!.attributes('selected')).toBe('true');
    expect(hanaItem!.attributes('selected')).toBeUndefined();
    expect(wrapper.find('[data-override-chip]').exists()).toBe(false);
    expect(wrapper.text()).not.toMatch(/Recommended because/);
  });

  it('URL override + recommendation differs → renders the override-chip variant (#303)', async () => {
    // User landed with ?branch=deployment:postgres but the engine picked HANA.
    // Spec §5.3.4 says branches are "highlighted, not enforced." Hiding the
    // chip silently would lose info. Instead the picker renders a transparent
    // transcript chip showing the override + the system's pick + reason.
    const wrapper = mount(BranchPicker, {
      props: {
        slug: SLUG,
        branchPointId: BPID,
        groupKey: 'deployment',
        branches: baseBranches,
        override: 'postgres',
        decisionsPromise: Promise.resolve({
          branchPoints: [{
            id: BPID,
            recommendation: {
              picked: 'hana',
              reason: { kind: 'condition', source: "profile.deployment == 'cloud'" },
              confidence: 1.0,
            },
          }],
          skipPoints: [],
        }),
      },
    });
    await flushPromises();

    // Override pre-selected postgres.
    const items = wrapper.findAll('ui5-segmented-button-item');
    const pgItem = items.find(i => i.text().includes('PostgreSQL'));
    expect(pgItem!.attributes('selected')).toBe('true');

    // Standard "Recommended because…" chip is suppressed by the override branch.
    const standardChip = wrapper.find('.branch-recommendation:not(.branch-recommendation--override)');
    expect(standardChip.exists()).toBe(false);

    // Override chip renders with system pick + reason text.
    const overrideChip = wrapper.find('[data-override-chip]');
    expect(overrideChip.exists()).toBe(true);
    expect(overrideChip.text()).toContain('HANA Cloud');
    expect(overrideChip.text()).toMatch(/system suggested HANA Cloud/);
    expect(overrideChip.text()).toContain("profile.deployment == 'cloud'");
  });
});
