import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { validateLessons } from '../../scripts/lib/ktt-lessons-schema';

describe('ktt_lessons.json', () => {
  const data = JSON.parse(readFileSync('hugo/data/ktt_lessons.json', 'utf8'));
  it('has 3-5 units and passes structural validation', () => {
    expect(data.units.length).toBeGreaterThanOrEqual(3);
    expect(data.units.length).toBeLessThanOrEqual(5);
    expect(validateLessons(data)).toEqual([]);
  });
  it('every drill has an answer and >=2 distractors; legacyIds unique', () => {
    const errs = validateLessons(data);
    expect(errs).toEqual([]);
  });
});
