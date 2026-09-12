// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { loadLocal, saveLocal, mergeProgress } from '../lib/progress';

beforeEach(() => {
  localStorage.clear();
});

describe('progress — localStorage round-trip', () => {
  it('loadLocal returns defaults when storage is empty', () => {
    const p = loadLocal();
    expect(p).toEqual({ xp: 0, streak: 0, mastered: [] });
  });

  it('saveLocal + loadLocal round-trips', () => {
    const data = { xp: 120, streak: 3, mastered: ['core-1', 'core-2'] };
    saveLocal(data);
    expect(loadLocal()).toEqual(data);
  });

  it('loadLocal is robust against corrupted JSON', () => {
    localStorage.setItem('ktt_progress', 'NOT_JSON');
    expect(loadLocal()).toEqual({ xp: 0, streak: 0, mastered: [] });
  });
});

describe('mergeProgress — matches backend semantics', () => {
  it('unions mastered and takes max xp/streak', () => {
    const local = { xp: 120, streak: 3, mastered: ['core-1', 'core-2'] };
    const remote = { xp: 90, streak: 5, mastered: ['core-2', 'sec-1'] };
    // Exact expectations from test/unit/ktt-merge.test.js
    expect(mergeProgress(local, remote)).toEqual({
      xp: 120, streak: 5, mastered: ['core-1', 'core-2', 'sec-1'],
    });
  });

  it('handles empty local and remote gracefully', () => {
    expect(mergeProgress({}, {})).toEqual({ xp: 0, streak: 0, mastered: [] });
  });

  it('takes max xp when remote is higher', () => {
    const local = { xp: 50, streak: 1, mastered: [] };
    const remote = { xp: 200, streak: 0, mastered: ['a'] };
    const result = mergeProgress(local, remote);
    expect(result.xp).toBe(200);
    expect(result.streak).toBe(1);
  });
});
