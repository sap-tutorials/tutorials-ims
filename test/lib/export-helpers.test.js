import { describe, it, expect } from 'vitest';
import { formatTaskRecordsCSV, formatAwardMissionsCSV, formatTimeSpent } from '../../srv/lib/export-helpers.js';

describe('export-helpers', () => {

  describe('formatTimeSpent', () => {
    it('formats seconds to human-readable', () => {
      expect(formatTimeSpent(3600)).toBe('1 hr');
      expect(formatTimeSpent(5400)).toBe('1 hr, 30 min');
      expect(formatTimeSpent(7200)).toBe('2 hrs');
      expect(formatTimeSpent(900)).toBe('15 min');
      expect(formatTimeSpent(0)).toBe('0 min');
      expect(formatTimeSpent(null)).toBe('');
    });
  });

  describe('formatTaskRecordsCSV', () => {
    it('produces CSV with header and rows', () => {
      const records = [
        {
          completionDate: '2026-03-15T10:30:00Z',
          taskType: 'TUTORIAL',
          titleSnapshot: 'Setup BTP Account',
          completionTime: 5400
        },
        {
          completionDate: '2026-03-16T14:00:00Z',
          taskType: 'MISSION',
          titleSnapshot: 'Get Started Mission',
          completionTime: null
        }
      ];
      const csv = formatTaskRecordsCSV(records);
      const lines = csv.split('\n');
      expect(lines[0]).toBe('DATE & TIME,TYPE,TITLE,TIME SPENT');
      expect(lines[1]).toContain('TUTORIAL');
      expect(lines[1]).toContain('Setup BTP Account');
      expect(lines[1]).toContain('1 hr, 30 min');
      expect(lines[2]).toContain('MISSION');
      expect(lines[2]).toContain('Get Started Mission');
    });

    it('returns header only for empty records', () => {
      const csv = formatTaskRecordsCSV([]);
      expect(csv).toBe('DATE & TIME,TYPE,TITLE,TIME SPENT');
    });
  });

  describe('formatAwardMissionsCSV', () => {
    it('produces CSV for mission awards', () => {
      const awards = [
        { userDisplayName: 'Alice', missionTitle: 'BTP Basics', completionDate: '2026-03-15T10:30:00Z' },
        { userDisplayName: 'Bob', missionTitle: 'CAP Deep Dive', completionDate: '2026-03-16T14:00:00Z' },
      ];
      const csv = formatAwardMissionsCSV(awards);
      const lines = csv.split('\n');
      expect(lines[0]).toBe('USER,MISSION,COMPLETED AT');
      expect(lines[1]).toContain('Alice');
      expect(lines[1]).toContain('BTP Basics');
    });
  });
});
