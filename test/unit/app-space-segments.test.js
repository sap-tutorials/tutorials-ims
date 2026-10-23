import { describe, it, expect } from 'vitest';
import { classifyPathSegments } from '../../srv/lib/app-space-segments.js';
import { buildPathSegments } from '../../srv/lib/path-item-task-resolver.js';

const row = (order, taskType, extra = {}) => ({ itemOrder: order, taskType, ...extra });

describe('classifyPathSegments', () => {
  it('one item at an order → linear', () => {
    const segs = classifyPathSegments([row(10, 'TUTORIAL')]);
    expect(segs).toEqual([{ order: 10, kind: 'linear', members: [row(10, 'TUTORIAL')] }]);
  });
  it('a lone GROUP at an order is linear, not a one-lane fork', () => {
    const segs = classifyPathSegments([row(10, 'GROUP', { group_ID: 'g1' })]);
    expect(segs[0].kind).toBe('linear');
  });
  it('2+ TUTORIALs sharing an order → parallel-any', () => {
    const segs = classifyPathSegments([row(20, 'TUTORIAL'), row(20, 'TUTORIAL')]);
    expect(segs[0].kind).toBe('parallel-any');
  });
  it('2+ GROUPs sharing an order → fork', () => {
    const segs = classifyPathSegments([row(20, 'GROUP', { group_ID: 'a' }), row(20, 'GROUP', { group_ID: 'b' })]);
    expect(segs[0].kind).toBe('fork');
  });
  it('a GROUP and a TUTORIAL sharing an order → fork (tutorial becomes a single-item lane)', () => {
    const segs = classifyPathSegments([row(20, 'GROUP', { group_ID: 'a' }), row(20, 'TUTORIAL')]);
    expect(segs[0].kind).toBe('fork');
    expect(segs[0].members).toHaveLength(2);
  });
  it('sorts segments ascending by order regardless of input order', () => {
    const segs = classifyPathSegments([row(30, 'TUTORIAL'), row(10, 'TUTORIAL')]);
    expect(segs.map(s => s.order)).toEqual([10, 30]);
  });
});

// #2890: a GROUP path-item's temporarilyUnavailable / unavailableReason must
// propagate onto the tutorials it expands into — both the lone-GROUP linear
// path and the fork-lane path. Without it, an unavailable GROUP branch stays
// navigable (render) and a previously-COMPLETED lane spuriously earns its prize
// (completion-counting edge). These are pure-Map inputs — no DB needed.
describe('buildPathSegments: GROUP temporarilyUnavailable propagation (#2890)', () => {
  const TUT_A = { ID: 'tut-a', legacyId: 9001, slug: 'tut-a', title: 'Tut A' };
  const TUT_B = { ID: 'tut-b', legacyId: 9002, slug: 'tut-b', title: 'Tut B' };

  const baseArgs = (pathItems, groupTutorials, groupTitles = new Map()) => ({
    pathItems,
    taskMap: new Map(),
    effLegacyByItem: new Map(),
    groupTutorials,
    groupTitles,
    recordMap: new Map(),
  });

  it('propagates an unavailable lone GROUP onto its linear expanded children', () => {
    const groupItem = row(10, 'GROUP', {
      group_ID: 'g1', temporarilyUnavailable: true, unavailableReason: 'Vendor outage',
    });
    const groupTutorials = new Map([['g1', [TUT_A, TUT_B]]]);
    const segs = buildPathSegments(baseArgs([groupItem], groupTutorials));
    const [linear] = segs;
    expect(linear.kind).toBe('linear');
    expect(linear.items).toHaveLength(2);
    expect(linear.items.every(i => i.temporarilyUnavailable === true)).toBe(true);
    expect(linear.items.every(i => i.unavailableReason === 'Vendor outage')).toBe(true);
  });

  it('propagates an unavailable fork-lane GROUP onto its lane children', () => {
    const grpUnavail = row(20, 'GROUP', {
      group_ID: 'g1', temporarilyUnavailable: true, unavailableReason: 'Branch paused',
    });
    const grpAvail = row(20, 'GROUP', { group_ID: 'g2' });
    const groupTutorials = new Map([['g1', [TUT_A]], ['g2', [TUT_B]]]);
    const groupTitles = new Map([['g1', 'Alpha'], ['g2', 'Beta']]);
    const segs = buildPathSegments(baseArgs([grpUnavail, grpAvail], groupTutorials, groupTitles));
    const fork = segs.find(s => s.kind === 'fork');
    const alpha = fork.lanes.find(l => l.label === 'Alpha');
    const beta = fork.lanes.find(l => l.label === 'Beta');
    expect(alpha.items.every(i => i.temporarilyUnavailable === true)).toBe(true);
    expect(alpha.items.every(i => i.unavailableReason === 'Branch paused')).toBe(true);
    // The available sibling lane must NOT inherit unavailability.
    expect(beta.items.every(i => i.temporarilyUnavailable === false)).toBe(true);
  });

  it('leaves an available GROUP\'s children with temporarilyUnavailable false (control)', () => {
    const groupItem = row(10, 'GROUP', { group_ID: 'g1' });
    const groupTutorials = new Map([['g1', [TUT_A, TUT_B]]]);
    const segs = buildPathSegments(baseArgs([groupItem], groupTutorials));
    expect(segs[0].items.every(i => i.temporarilyUnavailable === false)).toBe(true);
    expect(segs[0].items.every(i => !('unavailableReason' in i))).toBe(true);
  });
});
