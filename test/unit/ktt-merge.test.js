// test/unit/ktt-merge.test.js
// Unit test for the pure mergeProgress helper (no CAP bootstrap needed).

import { expect, test } from 'vitest';
import { mergeProgress } from '../../srv/lib/ktt/merge.js';

test('mergeProgress unions mastered and takes max xp/streak', () => {
  const local = { xp: 120, streak: 3, mastered: ['core-1', 'core-2'] };
  const remote = { xp: 90, streak: 5, mastered: ['core-2', 'sec-1'] };
  expect(mergeProgress(local, remote)).toEqual({
    xp: 120, streak: 5, mastered: ['core-1', 'core-2', 'sec-1'],
  });
});
