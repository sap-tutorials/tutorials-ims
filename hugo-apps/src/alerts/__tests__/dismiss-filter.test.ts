import { describe, it, expect } from 'vitest';
import { filterVisible } from '../dismiss-filter';
import type { ApiAlert } from '../types';

const mkAlert = (id: string): ApiAlert => ({
  id, title: id, body: null, severity: 'Information',
  ctaLabel: null, ctaUrl: null, dismissible: true,
  startsAt: '2026-01-01T00:00:00Z', endsAt: null,
});

describe('filterVisible', () => {
  it('returns all alerts when dismissedSet is empty', () => {
    const alerts = [mkAlert('a'), mkAlert('b')];
    expect(filterVisible(alerts, new Set())).toEqual(alerts);
  });
  it('drops dismissed alerts', () => {
    const alerts = [mkAlert('a'), mkAlert('b'), mkAlert('c')];
    const out = filterVisible(alerts, new Set(['b']));
    expect(out.map(a => a.id)).toEqual(['a', 'c']);
  });
  it('keeps order', () => {
    const alerts = [mkAlert('a'), mkAlert('b'), mkAlert('c')];
    const out = filterVisible(alerts, new Set(['a']));
    expect(out.map(a => a.id)).toEqual(['b', 'c']);
  });
});
