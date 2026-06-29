import { describe, it, expect } from 'vitest';
import { CATEGORY_LABELS, categoryLabel } from '../../../srv/lib/discovery-mission-categories.js';

describe('discovery-mission-categories', () => {
  describe('CATEGORY_LABELS table', () => {
    it('maps the 8 known short codes to English labels', () => {
      expect(CATEGORY_LABELS).toMatchObject({
        onboard: 'Onboarding',
        intgn: 'Integration',
        develop: 'Development',
        extend: 'Extension',
        analyze: 'Analytics',
        automate: 'Automation',
        secure: 'Security',
        migrate: 'Migration',
      });
    });
  });

  describe('categoryLabel()', () => {
    it('returns the English label for known short codes', () => {
      expect(categoryLabel('onboard')).toBe('Onboarding');
      expect(categoryLabel('intgn')).toBe('Integration');
    });

    it('falls back to title-case for unknown slugs', () => {
      expect(categoryLabel('iot')).toBe('Iot');
      expect(categoryLabel('blockchain')).toBe('Blockchain');
    });

    it('returns empty string for null/undefined/empty input', () => {
      expect(categoryLabel(null)).toBe('');
      expect(categoryLabel(undefined)).toBe('');
      expect(categoryLabel('')).toBe('');
    });
  });
});
