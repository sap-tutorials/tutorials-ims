import { describe, it, expect } from 'vitest';
import { BASE_ORDER, computeVerbOrder } from '../../../srv/lib/homepage/persona-map.js';

describe('computeVerbOrder', () => {
  it('returns BASE_ORDER when profile has no role', () => {
    expect(computeVerbOrder({})).toEqual([...BASE_ORDER]);
  });

  it('developer role leads with build', () => {
    const r = computeVerbOrder({ role: 'developer' });
    expect(r[0]).toBe('build');
    expect(r).toHaveLength(6);
    expect(new Set(r).size).toBe(6);
  });

  it('architect role leads with integrate', () => {
    expect(computeVerbOrder({ role: 'architect' })[0]).toBe('integrate');
  });

  it('sysadmin role leads with operate', () => {
    expect(computeVerbOrder({ role: 'sysadmin' })[0]).toBe('operate');
  });

  it('student role leads with learn', () => {
    expect(computeVerbOrder({ role: 'student' })[0]).toBe('learn');
  });

  it('unknown role falls back to base order', () => {
    expect(computeVerbOrder({ role: 'manager' })).toEqual([...BASE_ORDER]);
  });

  it('tilts a strictly-heaviest verb up one slot', () => {
    // developer base: [build, learn, integrate, ai, operate, connect]
    // ai has the most tagged shelves → moves from index 3 to index 2.
    const r = computeVerbOrder({ role: 'developer' }, { ai: 5, integrate: 2 });
    expect(r).toEqual(['build', 'learn', 'ai', 'integrate', 'operate', 'connect']);
  });

  it('does not tilt when the heaviest verb is already at index 0 or 1', () => {
    const r = computeVerbOrder({ role: 'developer' }, { build: 10 });
    expect(r).toEqual(['build', 'learn', 'integrate', 'ai', 'operate', 'connect']);
  });

  it('does not tilt on a tie for heaviest', () => {
    const r = computeVerbOrder({ role: 'developer' }, { ai: 5, operate: 5 });
    expect(r).toEqual(['build', 'learn', 'integrate', 'ai', 'operate', 'connect']);
  });
});
