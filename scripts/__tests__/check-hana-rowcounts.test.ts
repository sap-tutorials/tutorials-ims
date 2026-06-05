import { describe, it, expect } from 'vitest';

// CommonJS imports under vitest — interop works via default-export.
import helpersDefault from '../lib/hana-rowcount-helpers.cjs';
const { fmtRow, tripwireFailures } = helpersDefault as {
  fmtRow: (name: string, prev: number | undefined, now: number | undefined) => string | null;
  tripwireFailures: (
    prev: Record<string, number>,
    now: Record<string, number>,
    thresholdPct: number,
    minRowThreshold: number,
  ) => Array<{ name: string; prev: number; now: number; reason: string }>;
};

describe('check-hana-rowcounts helpers', () => {
  describe('tripwireFailures', () => {
    it('returns empty when all tables within threshold', () => {
      const prev = { COM_SAP_DEVELOPERS_IMS_MISSIONS: 1000 };
      const now  = { COM_SAP_DEVELOPERS_IMS_MISSIONS: 990 }; // 1% drop
      expect(tripwireFailures(prev, now, 5, 10)).toEqual([]);
    });

    it('flags tables that lost rows beyond threshold', () => {
      const prev = { COM_SAP_DEVELOPERS_IMS_MISSIONS: 1000 };
      const now  = { COM_SAP_DEVELOPERS_IMS_MISSIONS: 800 }; // 20% drop
      const failures = tripwireFailures(prev, now, 5, 10);
      expect(failures).toHaveLength(1);
      expect(failures[0].name).toBe('COM_SAP_DEVELOPERS_IMS_MISSIONS');
      expect(failures[0].reason).toContain('5% threshold');
    });

    it('flags tables that disappeared entirely', () => {
      const prev = { COM_SAP_DEVELOPERS_IMS_MISSIONS: 1000 };
      const now  = {};
      const failures = tripwireFailures(prev, now, 5, 10);
      expect(failures).toHaveLength(1);
      expect(failures[0].reason).toBe('TABLE GONE');
    });

    it('skips tables below the min-row threshold (small tables fluctuate)', () => {
      const prev = { COM_SAP_DEVELOPERS_IMS_TINY: 5 };
      const now  = {}; // tiny table disappeared but it was below threshold
      expect(tripwireFailures(prev, now, 5, 10)).toEqual([]);
    });

    it('reproduces the 2026-06-05 wipe pattern (Missions+Groups)', () => {
      // Pre-incident snapshot (representative)
      const prev = {
        COM_SAP_DEVELOPERS_IMS_MISSIONS: 240,
        COM_SAP_DEVELOPERS_IMS_GROUPS: 260,
        COM_SAP_DEVELOPERS_IMS_TUTORIALS: 1397,
        COM_SAP_DEVELOPERS_IMS_TUTORIALMETA: 1398,
      };
      // Post-wipe state
      const now = {
        COM_SAP_DEVELOPERS_IMS_MISSIONS: 0,
        COM_SAP_DEVELOPERS_IMS_GROUPS: 1,
        COM_SAP_DEVELOPERS_IMS_TUTORIALS: 1397,
        COM_SAP_DEVELOPERS_IMS_TUTORIALMETA: 1398,
      };
      const failures = tripwireFailures(prev, now, 5, 10);
      expect(failures).toHaveLength(2);
      expect(failures.map(f => f.name)).toContain('COM_SAP_DEVELOPERS_IMS_MISSIONS');
      expect(failures.map(f => f.name)).toContain('COM_SAP_DEVELOPERS_IMS_GROUPS');
    });

    it('threshold is configurable', () => {
      const prev = { COM_SAP_DEVELOPERS_IMS_X: 100 };
      const now  = { COM_SAP_DEVELOPERS_IMS_X: 90 }; // 10% drop
      expect(tripwireFailures(prev, now, 5, 10)).toHaveLength(1);  // fails at 5%
      expect(tripwireFailures(prev, now, 15, 10)).toEqual([]);     // ok at 15%
    });
  });

  describe('fmtRow', () => {
    it('returns null on no change', () => {
      expect(fmtRow('COM_SAP_DEVELOPERS_IMS_X', 100, 100)).toBeNull();
    });

    it('flags new tables with +', () => {
      const line = fmtRow('COM_SAP_DEVELOPERS_IMS_NEW', undefined, 50);
      expect(line).toContain('+');
      expect(line).toContain('NEW');
      expect(line).toContain('(new)');
    });

    it('flags removed tables with -', () => {
      const line = fmtRow('COM_SAP_DEVELOPERS_IMS_GONE', 50, undefined);
      expect(line).toContain('-');
      expect(line).toContain('GONE');
      expect(line).toContain('(gone)');
    });

    it('shows arrow + percentage on row change', () => {
      const dropped = fmtRow('COM_SAP_DEVELOPERS_IMS_X', 100, 50);
      expect(dropped).toContain('↓');
      expect(dropped).toContain('-50');
      expect(dropped).toContain('(-50.0%)');

      const grew = fmtRow('COM_SAP_DEVELOPERS_IMS_X', 100, 150);
      expect(grew).toContain('↑');
      expect(grew).toContain('+50');
    });

    it('strips the COM_SAP_DEVELOPERS_IMS_ prefix for readability', () => {
      const line = fmtRow('COM_SAP_DEVELOPERS_IMS_MISSIONS', 100, 50);
      expect(line).not.toContain('COM_SAP_DEVELOPERS_IMS_');
      expect(line).toContain('MISSIONS');
    });
  });
});
