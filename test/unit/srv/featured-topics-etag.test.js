import { describe, it, expect } from 'vitest';
import { computeSnapshotEtag } from '../../../srv/lib/featured-topics-etag.js';

describe('computeSnapshotEtag', () => {
  const ts = new Date('2026-07-06T04:11:00Z');
  it('is stable across identical snapshots', () => {
    const slots = [
      { slotOrder: 1, conceptSlug: 'cap',  missionSlugs: ['a','b','c','d'] },
      { slotOrder: 2, conceptSlug: 'hana', missionSlugs: ['e','f','g','h'] },
    ];
    expect(computeSnapshotEtag({ computedAt: ts, slots }))
      .toBe(computeSnapshotEtag({ computedAt: ts, slots: [...slots] }));
  });
  it('changes when a missionSlug changes', () => {
    const a = { computedAt: ts, slots: [{ slotOrder: 1, conceptSlug: 'cap', missionSlugs: ['a','b','c','d'] }] };
    const b = { computedAt: ts, slots: [{ slotOrder: 1, conceptSlug: 'cap', missionSlugs: ['a','b','c','X'] }] };
    expect(computeSnapshotEtag(a)).not.toBe(computeSnapshotEtag(b));
  });
  it('changes when slot order changes', () => {
    const a = { computedAt: ts, slots: [
      { slotOrder: 1, conceptSlug: 'cap',  missionSlugs: ['a'] },
      { slotOrder: 2, conceptSlug: 'hana', missionSlugs: ['b'] },
    ]};
    const b = { computedAt: ts, slots: [
      { slotOrder: 1, conceptSlug: 'hana', missionSlugs: ['b'] },
      { slotOrder: 2, conceptSlug: 'cap',  missionSlugs: ['a'] },
    ]};
    expect(computeSnapshotEtag(a)).not.toBe(computeSnapshotEtag(b));
  });
  it('is weak-tagged with quoted sha1', () => {
    const etag = computeSnapshotEtag({ computedAt: ts, slots: [] });
    expect(etag).toMatch(/^W\/"[0-9a-f]{40}"$/);
  });
  it('empty snapshot has a stable non-empty etag', () => {
    expect(computeSnapshotEtag({ computedAt: ts, slots: [] }))
      .toBe(computeSnapshotEtag({ computedAt: ts, slots: [] }));
  });
});
