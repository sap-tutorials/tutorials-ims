import { describe, it, expect } from 'vitest';
import { pickCanonicalMeta } from '../../scripts/lib/pick-canonical-meta.cjs';

describe('pickCanonicalMeta', () => {
  it('returns the only row when array has length 1', () => {
    const r = { ID: 'a', OWNER: null };
    expect(pickCanonicalMeta([r])).toEqual({ winner: r, losers: [] });
  });

  it('throws on empty input', () => {
    expect(() => pickCanonicalMeta([])).toThrow();
  });

  it('prefers non-null OWNER over null', () => {
    const a = { ID: 'a', OWNER: null, NOTIFICATIONNUMBER: 5, MODIFIEDAT: '2026-06-17T00:00:00' };
    const b = { ID: 'b', OWNER: 'thomas@sap.com', NOTIFICATIONNUMBER: 0, MODIFIEDAT: '2024-01-01T00:00:00' };
    expect(pickCanonicalMeta([a, b]).winner.ID).toBe('b');
  });

  it('breaks owner tie by NOTIFICATIONNUMBER (higher wins)', () => {
    const a = { ID: 'a', OWNER: 'x@sap.com', NOTIFICATIONNUMBER: 1, MODIFIEDAT: '2026-06-17' };
    const b = { ID: 'b', OWNER: 'y@sap.com', NOTIFICATIONNUMBER: 3, MODIFIEDAT: '2026-06-17' };
    expect(pickCanonicalMeta([a, b]).winner.ID).toBe('b');
  });

  it('breaks notification tie by REVIEWEDDATE (more recent wins)', () => {
    const a = { ID: 'a', OWNER: 'x', NOTIFICATIONNUMBER: 0, REVIEWEDDATE: '2024-01-01T00:00:00', MODIFIEDAT: '2026-06-17' };
    const b = { ID: 'b', OWNER: 'y', NOTIFICATIONNUMBER: 0, REVIEWEDDATE: '2026-06-01T00:00:00', MODIFIEDAT: '2026-06-17' };
    expect(pickCanonicalMeta([a, b]).winner.ID).toBe('b');
  });

  it('breaks reviewedDate tie by MODIFIEDAT (more recent wins)', () => {
    const a = { ID: 'a', OWNER: null, NOTIFICATIONNUMBER: 0, MODIFIEDAT: '2026-06-16T17:12:05.062', LEGACYID: 100 };
    const b = { ID: 'b', OWNER: null, NOTIFICATIONNUMBER: 0, MODIFIEDAT: '2026-06-17T18:00:00.000', LEGACYID: 200 };
    expect(pickCanonicalMeta([a, b]).winner.ID).toBe('b');
  });

  it('breaks fully-equal tie by lower LEGACYID', () => {
    const a = { ID: 'a', OWNER: null, NOTIFICATIONNUMBER: 0, MODIFIEDAT: '2026-06-16T17:12:05.062', LEGACYID: 200 };
    const b = { ID: 'b', OWNER: null, NOTIFICATIONNUMBER: 0, MODIFIEDAT: '2026-06-16T17:12:05.062', LEGACYID: 100 };
    expect(pickCanonicalMeta([a, b]).winner.ID).toBe('b');
  });

  it('reproduces the worked example: Thomas wins over Michelle', () => {
    const michelle = { ID: 'm', OWNER: 'michelle.wang05@sap.com', OWNEREMAIL: 'michelle.wang05@sap.com', NOTIFICATIONNUMBER: 0, REVIEWEDDATE: '2024-04-08T16:28:13', MODIFIEDAT: '2026-06-16T16:26:46.228', LEGACYID: 10001597 };
    const thomas =   { ID: 't', OWNER: 'thomas.jung@sap.com',     OWNEREMAIL: null,                       NOTIFICATIONNUMBER: 3, REVIEWEDDATE: '2026-02-23T16:59:07.569', MODIFIEDAT: '2026-06-16T17:35:34.633', LEGACYID: 10004279 };
    const { winner, losers } = pickCanonicalMeta([michelle, thomas]);
    expect(winner.ID).toBe('t');
    expect(losers).toEqual([michelle]);
  });
});
