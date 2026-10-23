import { describe, it, expect } from 'vitest';
import { classifyPathSegments } from '../../srv/lib/app-space-segments.js';

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
