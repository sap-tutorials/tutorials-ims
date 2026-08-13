// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import Dropdown from './TutorialNavigatorDropdown.vue';

// Alphabetical-by-slug order, exactly how _nav.json ships it (trial-10 after
// trial-1). The component must render groups in mission sequence and tutorials
// in itemOrder using the baked missionGroupSeq/groupOrder hints.
const tutorials = [
  { slug: 'trial-1',  title: 'T1',  missionId: 15069, missionTitle: 'Jump Start', groupId: 15066, groupTitle: 'Set Up',    prev: null, next: 'trial-2', missionGroupSeq: 1, groupOrder: 0 },
  { slug: 'trial-10', title: 'T10', missionId: 15069, missionTitle: 'Jump Start', groupId: 15068, groupTitle: 'Create',    prev: 'trial-9', next: null, missionGroupSeq: 3, groupOrder: 2 },
  { slug: 'trial-2',  title: 'T2',  missionId: 15069, missionTitle: 'Jump Start', groupId: 15066, groupTitle: 'Set Up',    prev: 'trial-1', next: 'trial-3', missionGroupSeq: 1, groupOrder: 1 },
  { slug: 'trial-3',  title: 'T3',  missionId: 15069, missionTitle: 'Jump Start', groupId: 15066, groupTitle: 'Set Up',    prev: 'trial-2', next: 'trial-4', missionGroupSeq: 1, groupOrder: 2 },
  { slug: 'trial-4',  title: 'T4',  missionId: 15069, missionTitle: 'Jump Start', groupId: 15066, groupTitle: 'Set Up',    prev: 'trial-3', next: null, missionGroupSeq: 1, groupOrder: 3 },
  { slug: 'trial-5',  title: 'T5',  missionId: 15069, missionTitle: 'Jump Start', groupId: 15067, groupTitle: 'First Steps', prev: null, next: 'trial-6', missionGroupSeq: 2, groupOrder: 0 },
  { slug: 'trial-8',  title: 'T8',  missionId: 15069, missionTitle: 'Jump Start', groupId: 15068, groupTitle: 'Create',    prev: null, next: 'trial-9', missionGroupSeq: 3, groupOrder: 0 },
  { slug: 'trial-9',  title: 'T9',  missionId: 15069, missionTitle: 'Jump Start', groupId: 15068, groupTitle: 'Create',    prev: 'trial-8', next: 'trial-10', missionGroupSeq: 3, groupOrder: 1 },
];

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ tutorials }) })));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('TutorialNavigatorDropdown ordering', () => {
  it('renders groups in mission sequence and tutorials in itemOrder', async () => {
    const wrapper = mount(Dropdown, { props: { currentSlug: 'trial-3', isOpen: true } });
    await flushPromises();
    await flushPromises();

    const groupTitles = wrapper.findAll('.nav-dropdown-group-title').map(n => n.text());
    expect(groupTitles).toEqual(['Set Up', 'First Steps', 'Create']);

    // The bug rendered "Create" as [trial-10, trial-8, trial-9]; fixed → 8,9,10.
    const createGroup = wrapper.findAll('.nav-dropdown-group').find(
      g => g.find('.nav-dropdown-group-title').text() === 'Create',
    )!;
    const items = createGroup.findAll('.nav-dropdown-item-title').map(n => n.text());
    expect(items).toEqual(['T8', 'T9', 'T10']);
  });
});
