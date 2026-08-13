import { describe, it, expect } from 'vitest';
import { buildOrderedGroups, type OrderableEntry } from './order';

// Mirrors the real HANA-trial reuse case: _nav.json is alphabetical by slug, so
// trial-10 arrives right after trial-1, and groups arrive interleaved. The
// helper must restore mission-sequence group order + itemOrder within groups.
const alphabetical: OrderableEntry[] = [
  { slug: 'trial-1',  groupId: 15066, groupTitle: 'Set Up',            missionGroupSeq: 1, groupOrder: 0 },
  { slug: 'trial-10', groupId: 15068, groupTitle: 'Create a Project',  missionGroupSeq: 3, groupOrder: 2 },
  { slug: 'trial-2',  groupId: 15066, groupTitle: 'Set Up',            missionGroupSeq: 1, groupOrder: 1 },
  { slug: 'trial-3',  groupId: 15066, groupTitle: 'Set Up',            missionGroupSeq: 1, groupOrder: 2 },
  { slug: 'trial-4',  groupId: 15066, groupTitle: 'Set Up',            missionGroupSeq: 1, groupOrder: 3 },
  { slug: 'trial-5',  groupId: 15067, groupTitle: 'First Steps',       missionGroupSeq: 2, groupOrder: 0 },
  { slug: 'trial-6',  groupId: 15067, groupTitle: 'First Steps',       missionGroupSeq: 2, groupOrder: 1 },
  { slug: 'trial-7',  groupId: 15067, groupTitle: 'First Steps',       missionGroupSeq: 2, groupOrder: 2 },
  { slug: 'trial-8',  groupId: 15068, groupTitle: 'Create a Project',  missionGroupSeq: 3, groupOrder: 0 },
  { slug: 'trial-9',  groupId: 15068, groupTitle: 'Create a Project',  missionGroupSeq: 3, groupOrder: 1 },
];

describe('buildOrderedGroups', () => {
  it('orders groups by missionGroupSeq and tutorials by groupOrder', () => {
    const groups = buildOrderedGroups(alphabetical);
    expect(groups.map(g => g.title)).toEqual(['Set Up', 'First Steps', 'Create a Project']);
    const createProject = groups.find(g => g.groupId === 15068)!;
    // The bug: alphabetical order put trial-10 first (10, 8, 9). Fixed → 8, 9, 10.
    expect(createProject.tutorials.map(t => t.slug)).toEqual(['trial-8', 'trial-9', 'trial-10']);
    const setUp = groups.find(g => g.groupId === 15066)!;
    expect(setUp.tutorials.map(t => t.slug)).toEqual(['trial-1', 'trial-2', 'trial-3', 'trial-4']);
  });

  it('does not mutate the input array', () => {
    const input = [...alphabetical];
    buildOrderedGroups(input);
    expect(input.map(e => e.slug)).toEqual(alphabetical.map(e => e.slug));
  });

  it('falls back to incoming order when hints are absent (older _nav.json)', () => {
    const noHints: OrderableEntry[] = [
      { slug: 'b', groupId: 2, groupTitle: 'G2' },
      { slug: 'a', groupId: 1, groupTitle: 'G1' },
      { slug: 'c', groupId: 1, groupTitle: 'G1' },
    ];
    const groups = buildOrderedGroups(noHints);
    // Stable sort with all-zero keys preserves array order: G2 seen first.
    expect(groups.map(g => g.groupId)).toEqual([2, 1]);
    expect(groups.find(g => g.groupId === 1)!.tutorials.map(t => t.slug)).toEqual(['a', 'c']);
  });
});
