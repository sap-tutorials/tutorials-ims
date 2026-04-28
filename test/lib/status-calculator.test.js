import { describe, it, expect } from 'vitest';
import { calculateTutorialProgress, calculateMissionProgress } from '../../srv/lib/status-calculator.js';

describe('status-calculator', () => {
  describe('calculateTutorialProgress', () => {
    it('returns 0 for no completed steps', () => {
      const result = calculateTutorialProgress([], 5);
      expect(result).toEqual({ progress: 0, status: 'IN_PROGRESS' });
    });

    it('returns percentage for partial completion', () => {
      const result = calculateTutorialProgress([1, 2], 5);
      expect(result).toEqual({ progress: 40, status: 'IN_PROGRESS' });
    });

    it('returns 100 and COMPLETED when all steps done', () => {
      const result = calculateTutorialProgress([1, 2, 3], 3);
      expect(result).toEqual({ progress: 100, status: 'COMPLETED' });
    });

    it('handles empty total steps', () => {
      const result = calculateTutorialProgress([], 0);
      expect(result).toEqual({ progress: 100, status: 'COMPLETED' });
    });
  });

  describe('calculateMissionProgress', () => {
    it('returns 0 for no completed tutorials', () => {
      const result = calculateMissionProgress(0, 3);
      expect(result).toEqual({ progress: 0, status: 'IN_PROGRESS' });
    });

    it('returns COMPLETED when all tutorials done', () => {
      const result = calculateMissionProgress(3, 3);
      expect(result).toEqual({ progress: 100, status: 'COMPLETED' });
    });

    it('calculates percentage', () => {
      const result = calculateMissionProgress(1, 4);
      expect(result).toEqual({ progress: 25, status: 'IN_PROGRESS' });
    });
  });
});
