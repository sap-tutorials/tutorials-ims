// test/unit/app-space-unavailable-gating.test.js
//
// #2864 — a temporarily-unavailable path item must not be openable on the
// App Space kiosk, even if it would otherwise be unlocked/openable by the
// #2866 gating rules. isTutorialOpenable is the single chokepoint the template
// uses both to gate the click handler and to apply the `clickable` class, so
// returning false here greys AND delinks the card.

import { describe, it, expect } from 'vitest';
import { isTutorialOpenable } from '../../hugo-apps/src/app-space/app-space-gating.ts';

const tut = (status, extra = {}) => ({ type: 'TUTORIAL', status, ...extra });

describe('isTutorialOpenable — #2864 temporarilyUnavailable blocks opening', () => {
  it('an available, unlocked first tutorial is normally openable', () => {
    expect(isTutorialOpenable([tut('AVAILABLE')], 0)).toBe(true);
  });

  it('is NOT openable when the item is temporarilyUnavailable', () => {
    expect(isTutorialOpenable([tut('AVAILABLE', { temporarilyUnavailable: true })], 0)).toBe(false);
  });

  it('temporarilyUnavailable overrides the COMPLETED_OUT_OF_WINDOW redo exception', () => {
    const items = [tut('COMPLETED_OUT_OF_WINDOW', { temporarilyUnavailable: true })];
    expect(isTutorialOpenable(items, 0)).toBe(false);
  });
});
