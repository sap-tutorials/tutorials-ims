// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { taskHref, taskLinkLabel } from '../completion';

/**
 * Regression for the Petoberfest link bug: petoberfest activities were linked
 * under /tutorials/<slug>, which 404s. The type→section mapping must send
 * puzzles to /puzzles/, petoberfest to /petoberfest/, everything else to
 * /tutorials/. taskType casing from the feed is upper-case (PUZZLE/PETOBERFEST/
 * TUTORIAL) so matching is case-insensitive.
 */
describe('taskHref', () => {
  it('links a puzzle under /puzzles/', () => {
    expect(taskHref({ taskType: 'PUZZLE', taskSlug: 'weekly-1' })).toBe('/puzzles/weekly-1');
  });

  it('links petoberfest under /petoberfest/, NOT /tutorials/', () => {
    const href = taskHref({ taskType: 'PETOBERFEST', taskSlug: 'petoberfest-2026' });
    expect(href).toBe('/petoberfest/petoberfest-2026');
    expect(href).not.toContain('/tutorials/');
  });

  it('defaults every other type to /tutorials/', () => {
    expect(taskHref({ taskType: 'TUTORIAL', taskSlug: 'intro' })).toBe('/tutorials/intro');
    expect(taskHref({ taskType: 'SOMETHING_NEW', taskSlug: 'x' })).toBe('/tutorials/x');
  });

  it('is case-insensitive on taskType', () => {
    expect(taskHref({ taskType: 'petoberfest', taskSlug: 's' })).toBe('/petoberfest/s');
    expect(taskHref({ taskType: 'Puzzle', taskSlug: 's' })).toBe('/puzzles/s');
  });

  it('returns empty string when there is no slug', () => {
    expect(taskHref({ taskType: 'PETOBERFEST', taskSlug: null })).toBe('');
    expect(taskHref(null)).toBe('');
  });
});

describe('taskLinkLabel', () => {
  it('labels each type distinctly', () => {
    expect(taskLinkLabel({ taskType: 'PUZZLE' })).toBe('Open puzzle');
    expect(taskLinkLabel({ taskType: 'PETOBERFEST' })).toBe('Open Petoberfest');
    expect(taskLinkLabel({ taskType: 'TUTORIAL' })).toBe('Open tutorial');
    expect(taskLinkLabel(null)).toBe('Open tutorial');
  });
});
