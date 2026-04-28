import { describe, it, expect } from 'vitest';
import { computeEventStatistics, computeBurnup, computeTrackStats, computeCompletionSpeed, computeLeaderboard } from '../../srv/lib/event-statistics.js';

describe('event-statistics', () => {

  describe('computeEventStatistics', () => {
    it('counts completed tasks by type and unique users', () => {
      const records = [
        { taskType: 'TUTORIAL', status: 'COMPLETED', user_ID: 'u1' },
        { taskType: 'TUTORIAL', status: 'COMPLETED', user_ID: 'u2' },
        { taskType: 'MISSION', status: 'COMPLETED', user_ID: 'u1' },
        { taskType: 'GROUP', status: 'COMPLETED', user_ID: 'u1' },
        { taskType: 'TUTORIAL', status: 'IN_PROGRESS', user_ID: 'u3' },
      ];
      const result = computeEventStatistics(records);
      expect(result).toEqual({
        tutorials: 2,
        groups: 1,
        missions: 1,
        uniqueUsers: 2
      });
    });

    it('returns zeros for empty records', () => {
      expect(computeEventStatistics([])).toEqual({
        tutorials: 0, groups: 0, missions: 0, uniqueUsers: 0
      });
    });
  });

  describe('computeBurnup', () => {
    it('computes daily counts and cumulative totals', () => {
      const records = [
        { completionDate: '2026-03-01T10:00:00Z' },
        { completionDate: '2026-03-01T14:00:00Z' },
        { completionDate: '2026-03-02T09:00:00Z' },
        { completionDate: '2026-03-03T11:00:00Z' },
        { completionDate: '2026-03-03T15:00:00Z' },
        { completionDate: '2026-03-03T16:00:00Z' },
      ];
      const result = computeBurnup(records, '+00:00');
      expect(result).toEqual([
        { day: '2026-03-01', count: 2, cumulative: 2 },
        { day: '2026-03-02', count: 1, cumulative: 3 },
        { day: '2026-03-03', count: 3, cumulative: 6 },
      ]);
    });

    it('applies timezone offset to date grouping', () => {
      const records = [
        { completionDate: '2026-03-01T23:00:00Z' },
      ];
      const result = computeBurnup(records, '+05:00');
      expect(result).toEqual([
        { day: '2026-03-02', count: 1, cumulative: 1 },
      ]);
    });

    it('returns empty array for no records', () => {
      expect(computeBurnup([], '+00:00')).toEqual([]);
    });
  });

  describe('computeTrackStats', () => {
    it('aggregates completions per mission', () => {
      const records = [
        { taskLegacyId: 100, user_ID: 'u1', status: 'COMPLETED' },
        { taskLegacyId: 100, user_ID: 'u2', status: 'COMPLETED' },
        { taskLegacyId: 200, user_ID: 'u1', status: 'COMPLETED' },
      ];
      const missions = [
        { legacyId: 100, title: 'Mission A' },
        { legacyId: 200, title: 'Mission B' },
      ];
      const result = computeTrackStats(records, missions);
      expect(result).toEqual([
        { missionLegacyId: 100, title: 'Mission A', uniqueUsers: 2, completions: 2 },
        { missionLegacyId: 200, title: 'Mission B', uniqueUsers: 1, completions: 1 },
      ]);
    });
  });

  describe('computeCompletionSpeed', () => {
    it('calculates average completion time in minutes', () => {
      const records = [
        { taskLegacyId: 100, completionTime: 600 },
        { taskLegacyId: 100, completionTime: 1200 },
        { taskLegacyId: 200, completionTime: 300 },
      ];
      const tasks = [
        { legacyId: 100, title: 'Tutorial A' },
        { legacyId: 200, title: 'Tutorial B' },
      ];
      const result = computeCompletionSpeed(records, tasks);
      expect(result).toEqual([
        { taskLegacyId: 100, title: 'Tutorial A', avgMinutes: 15, completions: 2 },
        { taskLegacyId: 200, title: 'Tutorial B', avgMinutes: 5, completions: 1 },
      ]);
    });

    it('excludes records without completionTime', () => {
      const records = [
        { taskLegacyId: 100, completionTime: 600 },
        { taskLegacyId: 100, completionTime: null },
      ];
      const tasks = [{ legacyId: 100, title: 'Tutorial A' }];
      const result = computeCompletionSpeed(records, tasks);
      expect(result).toEqual([
        { taskLegacyId: 100, title: 'Tutorial A', avgMinutes: 10, completions: 1 },
      ]);
    });
  });

  describe('computeLeaderboard', () => {
    it('ranks users by completion count', () => {
      const records = [
        { user_ID: 'u1', status: 'COMPLETED' },
        { user_ID: 'u1', status: 'COMPLETED' },
        { user_ID: 'u1', status: 'COMPLETED' },
        { user_ID: 'u2', status: 'COMPLETED' },
        { user_ID: 'u2', status: 'COMPLETED' },
        { user_ID: 'u3', status: 'COMPLETED' },
      ];
      const users = [
        { ID: 'u1', legacyId: 1, displayName: 'Alice' },
        { ID: 'u2', legacyId: 2, displayName: 'Bob' },
        { ID: 'u3', legacyId: 3, displayName: 'Carol' },
      ];
      const result = computeLeaderboard(records, users, 2);
      expect(result).toEqual([
        { userLegacyId: 1, displayName: 'Alice', completions: 3, points: 30 },
        { userLegacyId: 2, displayName: 'Bob', completions: 2, points: 20 },
      ]);
    });
  });
});
