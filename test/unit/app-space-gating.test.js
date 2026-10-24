// test/unit/app-space-gating.test.js
//
// Unit tests for App Space step-timeline gating (#2866 follow-up).
//
// Covers the distinction between:
//   isItemUnlocked     — progress/prize gating, strict === 'COMPLETED'
//   isTutorialOpenable — whether a TUTORIAL's link stays live
//
// The #2866 bug: a tutorial COMPLETED *before* the event window (status
// 'COMPLETED_OUT_OF_WINDOW') had its URL disabled, so the user couldn't reach
// the tutorial to reset their progress and redo it during the event. The fix
// keeps the link live for redo items WITHOUT advancing the track or unlocking
// the prize.

import { describe, it, expect } from 'vitest';
import { isItemUnlocked, isTutorialOpenable } from '../../hugo-apps/src/app-space/app-space-gating.ts';

const tut = (status) => ({ type: 'TUTORIAL', status });
const checkpoint = (status = 'LOCKED') => ({ type: 'CHECKPOINT', status });
const prize = (status = 'LOCKED') => ({ type: 'PRIZE', status });

describe('isItemUnlocked — progress/prize gating (strict COMPLETED)', () => {
  it('first tutorial is always unlocked', () => {
    expect(isItemUnlocked([tut('AVAILABLE')], 0)).toBe(true);
  });

  it('later tutorial unlocks only when the previous is exactly COMPLETED', () => {
    const items = [tut('COMPLETED'), tut('AVAILABLE')];
    expect(isItemUnlocked(items, 1)).toBe(true);
  });

  it('out-of-window completion does NOT unlock the next tutorial', () => {
    const items = [tut('COMPLETED_OUT_OF_WINDOW'), tut('AVAILABLE')];
    expect(isItemUnlocked(items, 1)).toBe(false);
  });

  it('out-of-window completion does NOT unlock the prize', () => {
    const items = [tut('COMPLETED_OUT_OF_WINDOW'), prize()];
    expect(isItemUnlocked(items, 1)).toBe(false);
  });

  it('prize unlocks only when every tutorial is exactly COMPLETED', () => {
    expect(isItemUnlocked([tut('COMPLETED'), tut('COMPLETED'), prize()], 2)).toBe(true);
    expect(isItemUnlocked([tut('COMPLETED'), tut('COMPLETED_OUT_OF_WINDOW'), prize()], 2)).toBe(false);
  });

  it('checkpoint unlocks only when preceding tutorials are exactly COMPLETED', () => {
    expect(isItemUnlocked([tut('COMPLETED'), checkpoint()], 1)).toBe(true);
    expect(isItemUnlocked([tut('COMPLETED_OUT_OF_WINDOW'), checkpoint()], 1)).toBe(false);
  });
});

describe('isItemUnlocked — server unlocked flag (#2887)', () => {
  it('unlocked:true on an item whose predecessor is incomplete returns true (flag wins)', () => {
    // Task 3 set unlocked=true server-side, bypassing adjacency logic.
    const items = [tut('AVAILABLE'), { type: 'TUTORIAL', status: 'LOCKED', unlocked: true }];
    expect(isItemUnlocked(items, 1)).toBe(true);
  });

  it('unlocked:false with a COMPLETED predecessor returns false (flag wins)', () => {
    // Even though the predecessor is COMPLETED, the flag says don't unlock.
    const items = [tut('COMPLETED'), { type: 'TUTORIAL', status: 'AVAILABLE', unlocked: false }];
    expect(isItemUnlocked(items, 1)).toBe(false);
  });

  it('item with NO unlocked property falls back to adjacency behavior', () => {
    // Legacy payloads or existing linear tracks without the flag use the old logic.
    const items = [tut('COMPLETED'), tut('AVAILABLE')];
    expect(isItemUnlocked(items, 1)).toBe(true); // predecessor COMPLETED → unlock
  });

  it('unlocked flag on a checkpoint works the same way', () => {
    const items = [tut('AVAILABLE'), { type: 'CHECKPOINT', status: 'LOCKED', unlocked: true }];
    expect(isItemUnlocked(items, 1)).toBe(true);

    const items2 = [tut('COMPLETED'), { type: 'CHECKPOINT', status: 'AVAILABLE', unlocked: false }];
    expect(isItemUnlocked(items2, 1)).toBe(false);
  });

  it('unlocked flag on a prize works the same way', () => {
    const items = [tut('AVAILABLE'), { type: 'PRIZE', status: 'LOCKED', unlocked: true }];
    expect(isItemUnlocked(items, 1)).toBe(true);

    const items2 = [tut('COMPLETED'), { type: 'PRIZE', status: 'AVAILABLE', unlocked: false }];
    expect(isItemUnlocked(items2, 1)).toBe(false);
  });
});

describe('isTutorialOpenable — keeps the tutorial link live (#2866)', () => {
  it('an out-of-window completed tutorial stays openable (the bug fix)', () => {
    // Even though it is NOT unlocked for gating, its URL must stay reachable so
    // the user can reset progress and redo it during the event.
    const items = [tut('COMPLETED_OUT_OF_WINDOW'), tut('AVAILABLE')];
    expect(isItemUnlocked(items, 0)).toBe(true); // first item, unlocked anyway
    expect(isTutorialOpenable(items, 0)).toBe(true);

    // And a redo item that is NOT the first (so not unlocked) still opens.
    const gated = [tut('AVAILABLE'), tut('COMPLETED_OUT_OF_WINDOW')];
    expect(isItemUnlocked(gated, 1)).toBe(false);
    expect(isTutorialOpenable(gated, 1)).toBe(true);
  });

  it('an unlocked, in-window tutorial is openable', () => {
    const items = [tut('COMPLETED'), tut('AVAILABLE')];
    expect(isTutorialOpenable(items, 1)).toBe(true);
  });

  it('a genuinely locked tutorial is NOT openable', () => {
    const items = [tut('AVAILABLE'), tut('LOCKED')];
    expect(isTutorialOpenable(items, 1)).toBe(false);
  });

  it('a non-tutorial item is never openable', () => {
    expect(isTutorialOpenable([prize('EARNED')], 0)).toBe(false);
    expect(isTutorialOpenable([checkpoint('AVAILABLE')], 0)).toBe(false);
  });
});
