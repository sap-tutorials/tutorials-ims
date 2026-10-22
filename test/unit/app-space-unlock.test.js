// test/unit/app-space-unlock.test.js
//
// Unit tests for annotateUnlocked — server-side segment-aware unlock flags (#2887).
//
// Rules:
//   - First segment always unlocked.
//   - Segment N unlocks when segment N-1 is SATISFIED.
//   - linear satisfied: single item status === 'COMPLETED'.
//   - parallel-any satisfied: ALL items status === 'COMPLETED'.
//   - fork satisfied: ALL lanes complete (every item in each lane 'COMPLETED',
//     including synthetic checkpoint).
//   - A lane's own synthetic prize unlocks when THAT lane's tutorials complete,
//     independent of other lanes.
//   - COMPLETED_OUT_OF_WINDOW and temporarilyUnavailable are never 'complete'.

import { describe, it, expect } from 'vitest';
import { annotateUnlocked } from '../../srv/lib/app-space-segments.js';

// Helpers for building minimal item/segment fixtures.
const tut = (status, extra = {}) => ({ type: 'TUTORIAL', status, temporarilyUnavailable: false, ...extra });
const checkpoint = (status = '') => ({ type: 'CHECKPOINT', status, temporarilyUnavailable: false });
const prize = (prizeId = 'prize-1') => ({ type: 'CHECKPOINT', status: '', temporarilyUnavailable: false, prizeId });

const linear = (item) => ({ order: 1, kind: 'linear', items: [item] });
const cluster = (items) => ({ order: 2, kind: 'parallel-any', items });
const fork = (lanes) => ({ order: 3, kind: 'fork', lanes });
const lane = (items, label = '') => ({ label, items });

describe('annotateUnlocked — linear gating', () => {
  it('first linear segment is always unlocked', () => {
    const segs = [
      { order: 1, kind: 'linear', items: [tut('AVAILABLE')] },
    ];
    const result = annotateUnlocked(segs);
    expect(result[0].items[0].unlocked).toBe(true);
  });

  it('second segment unlocks when first linear is COMPLETED', () => {
    const segs = [
      { order: 1, kind: 'linear', items: [tut('COMPLETED')] },
      { order: 2, kind: 'linear', items: [tut('AVAILABLE')] },
    ];
    const result = annotateUnlocked(segs);
    expect(result[0].items[0].unlocked).toBe(true);
    expect(result[1].items[0].unlocked).toBe(true);
  });

  it('second segment remains locked when first linear is not COMPLETED', () => {
    const segs = [
      { order: 1, kind: 'linear', items: [tut('AVAILABLE')] },
      { order: 2, kind: 'linear', items: [tut('LOCKED')] },
    ];
    const result = annotateUnlocked(segs);
    expect(result[0].items[0].unlocked).toBe(true);
    expect(result[1].items[0].unlocked).toBe(false);
  });

  it('linear gate carries over: third segment locked when second is not complete', () => {
    const segs = [
      { order: 1, kind: 'linear', items: [tut('COMPLETED')] },
      { order: 2, kind: 'linear', items: [tut('AVAILABLE')] },
      { order: 3, kind: 'linear', items: [tut('LOCKED')] },
    ];
    const result = annotateUnlocked(segs);
    expect(result[0].items[0].unlocked).toBe(true);
    expect(result[1].items[0].unlocked).toBe(true);
    expect(result[2].items[0].unlocked).toBe(false);
  });
});

describe('annotateUnlocked — parallel-any (cluster) gating', () => {
  it('cluster items are all unlocked when the preceding segment is satisfied', () => {
    const segs = [
      { order: 1, kind: 'linear', items: [tut('COMPLETED')] },
      { order: 2, kind: 'parallel-any', items: [tut('AVAILABLE'), tut('AVAILABLE')] },
    ];
    const result = annotateUnlocked(segs);
    expect(result[1].items[0].unlocked).toBe(true);
    expect(result[1].items[1].unlocked).toBe(true);
  });

  it('cluster locks downstream until ALL members are COMPLETED', () => {
    const segs = [
      { order: 1, kind: 'parallel-any', items: [tut('COMPLETED'), tut('AVAILABLE')] },
      { order: 2, kind: 'linear', items: [tut('LOCKED')] },
    ];
    const result = annotateUnlocked(segs);
    // First cluster segment is always unlocked (first segment rule).
    expect(result[0].items[0].unlocked).toBe(true);
    expect(result[0].items[1].unlocked).toBe(true);
    // Second segment NOT unlocked because cluster is not fully satisfied.
    expect(result[1].items[0].unlocked).toBe(false);
  });

  it('cluster satisfied when ALL members COMPLETED unlocks downstream', () => {
    const segs = [
      { order: 1, kind: 'parallel-any', items: [tut('COMPLETED'), tut('COMPLETED')] },
      { order: 2, kind: 'linear', items: [tut('AVAILABLE')] },
    ];
    const result = annotateUnlocked(segs);
    expect(result[1].items[0].unlocked).toBe(true);
  });
});

describe('annotateUnlocked — fork gating', () => {
  it('fork join: downstream locks until BOTH lanes are complete', () => {
    const segs = [
      {
        order: 1,
        kind: 'fork',
        lanes: [
          lane([tut('COMPLETED'), checkpoint('COMPLETED')]),   // lane 1 complete
          lane([tut('AVAILABLE'), checkpoint()]),              // lane 2 incomplete
        ],
      },
      { order: 2, kind: 'linear', items: [tut('LOCKED')] },
    ];
    const result = annotateUnlocked(segs);
    // Fork segment is first → always unlocked.
    expect(result[0].lanes[0].items[0].unlocked).toBe(true);
    // Downstream locked because lane 2 not done.
    expect(result[1].items[0].unlocked).toBe(false);
  });

  it('fork join: downstream unlocks when ALL lanes complete', () => {
    const segs = [
      {
        order: 1,
        kind: 'fork',
        lanes: [
          lane([tut('COMPLETED'), checkpoint('COMPLETED')]),
          lane([tut('COMPLETED'), checkpoint('COMPLETED')]),
        ],
      },
      { order: 2, kind: 'linear', items: [tut('AVAILABLE')] },
    ];
    const result = annotateUnlocked(segs);
    expect(result[1].items[0].unlocked).toBe(true);
  });

  it('per-lane synthetic prize unlocks on its own lane completing, independent of other lanes', () => {
    const segs = [
      {
        order: 1,
        kind: 'fork',
        lanes: [
          lane([tut('COMPLETED'), prize('prize-a')]),          // lane 1 tutorials done → prize unlocked
          lane([tut('AVAILABLE'), prize('prize-b')]),          // lane 2 tutorials NOT done → prize locked
        ],
      },
    ];
    const result = annotateUnlocked(segs);
    const lane1Items = result[0].lanes[0].items;
    const lane2Items = result[0].lanes[1].items;
    // Lane 1 tutorial and its prize should both be unlocked.
    expect(lane1Items[0].unlocked).toBe(true);  // tutorial (first seg → all unlocked)
    expect(lane1Items[1].unlocked).toBe(true);  // synthetic prize: lane 1 tutorials complete
    // Lane 2 tutorial unlocked (first seg), but prize locked (lane not complete).
    expect(lane2Items[0].unlocked).toBe(true);  // tutorial (first seg → all unlocked)
    expect(lane2Items[1].unlocked).toBe(false); // synthetic prize: lane 2 tutorials NOT complete
  });
});

describe('annotateUnlocked — #2866 COMPLETED_OUT_OF_WINDOW never counts as complete', () => {
  it('COMPLETED_OUT_OF_WINDOW in a linear leaves the next segment locked', () => {
    const segs = [
      { order: 1, kind: 'linear', items: [tut('COMPLETED_OUT_OF_WINDOW')] },
      { order: 2, kind: 'linear', items: [tut('AVAILABLE')] },
    ];
    const result = annotateUnlocked(segs);
    expect(result[1].items[0].unlocked).toBe(false);
  });

  it('COMPLETED_OUT_OF_WINDOW in a lane leaves that lane incomplete (prize locked)', () => {
    const segs = [
      {
        order: 1,
        kind: 'fork',
        lanes: [
          lane([tut('COMPLETED_OUT_OF_WINDOW'), prize('prize-a')]),
        ],
      },
    ];
    const result = annotateUnlocked(segs);
    // Synthetic prize must NOT unlock — out-of-window never satisfies a lane.
    expect(result[0].lanes[0].items[1].unlocked).toBe(false);
  });

  it('COMPLETED_OUT_OF_WINDOW in a cluster leaves the cluster unsatisfied', () => {
    const segs = [
      { order: 1, kind: 'parallel-any', items: [tut('COMPLETED'), tut('COMPLETED_OUT_OF_WINDOW')] },
      { order: 2, kind: 'linear', items: [tut('LOCKED')] },
    ];
    const result = annotateUnlocked(segs);
    expect(result[1].items[0].unlocked).toBe(false);
  });
});

describe('annotateUnlocked — #2864 temporarilyUnavailable never counts as complete', () => {
  it('temporarilyUnavailable item in a linear leaves the next segment locked', () => {
    const segs = [
      { order: 1, kind: 'linear', items: [{ ...tut('COMPLETED'), temporarilyUnavailable: true }] },
      { order: 2, kind: 'linear', items: [tut('AVAILABLE')] },
    ];
    const result = annotateUnlocked(segs);
    expect(result[1].items[0].unlocked).toBe(false);
  });

  it('temporarilyUnavailable item in a cluster leaves the cluster unsatisfied', () => {
    const segs = [
      {
        order: 1,
        kind: 'parallel-any',
        items: [tut('COMPLETED'), { ...tut('COMPLETED'), temporarilyUnavailable: true }],
      },
      { order: 2, kind: 'linear', items: [tut('LOCKED')] },
    ];
    const result = annotateUnlocked(segs);
    expect(result[1].items[0].unlocked).toBe(false);
  });

  it('temporarilyUnavailable item in a lane leaves that lane unsatisfied', () => {
    const segs = [
      {
        order: 1,
        kind: 'fork',
        lanes: [
          lane([{ ...tut('COMPLETED'), temporarilyUnavailable: true }, prize('prize-a')]),
        ],
      },
    ];
    const result = annotateUnlocked(segs);
    expect(result[0].lanes[0].items[1].unlocked).toBe(false);
  });
});

describe('annotateUnlocked — return value', () => {
  it('returns the same segments array (mutate-and-return)', () => {
    const segs = [{ order: 1, kind: 'linear', items: [tut('AVAILABLE')] }];
    const result = annotateUnlocked(segs);
    expect(result).toBe(segs);
  });
});
