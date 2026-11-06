import { describe, it, expect } from 'vitest';
import { stripAuthorNotes, AuthorNoteError } from '../author-notes.js';

describe('stripAuthorNotes — PROD channel', () => {
  it('strips an inline note leaving surrounding prose intact', () => {
    const body = 'Choose a region. %% @jdoe: is eu10 still default? %% Continue.';
    expect(stripAuthorNotes(body, 'prod')).toBe('Choose a region.  Continue.');
  });

  it('strips a block note (opening %% on its own line)', () => {
    const body = 'Before.\n%%\nNote content.\n%%\nAfter.';
    expect(stripAuthorNotes(body, 'prod')).toBe('Before.\n\nAfter.');
  });

  it('does NOT strip %% inside a fenced code block', () => {
    const body = '```sql\nSELECT %% FROM t;\n```';
    expect(stripAuthorNotes(body, 'prod')).toBe(body);
  });

  it('handles a tutorial with no notes', () => {
    const body = 'No notes here.';
    expect(stripAuthorNotes(body, 'prod')).toBe(body);
  });
});

describe('stripAuthorNotes — QA channel', () => {
  it('renders inline note as span with attribution', () => {
    const body = 'Text %% @jdoe: check this %% end.';
    const result = stripAuthorNotes(body, 'qa');
    expect(result).toContain('class="tut-author-note"');
    expect(result).toContain('data-author="jdoe"');
    expect(result).toContain('check this');
    expect(result).not.toContain('%%');
  });

  it('renders inline note with no attribution', () => {
    const body = 'Text %% reviewer note %% end.';
    const result = stripAuthorNotes(body, 'qa');
    expect(result).toContain('class="tut-author-note"');
    expect(result).toContain('data-author=""');
  });

  it('throws AuthorNoteError with line number for unterminated note', () => {
    const body = 'Line 1.\n%% unclosed note\nLine 3.';
    expect(() => stripAuthorNotes(body, 'qa')).toThrow(AuthorNoteError);
    try { stripAuthorNotes(body, 'qa'); } catch (e: any) {
      expect(e.line).toBe(2);
    }
  });

  it('does NOT process %% inside a fenced code block on QA', () => {
    const body = '```sql\nSELECT %% FROM t;\n```';
    expect(stripAuthorNotes(body, 'qa')).toBe(body);
  });
});
