import { describe, it, expect, vi } from 'vitest';
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

  it('does NOT strip %% inside an inline code span', () => {
    // Regression: prose documenting the %% syntax uses backtick spans.
    const body = 'Notes are delimited by `%%`: a bare `%%` opens and `%%` closes.';
    expect(stripAuthorNotes(body, 'prod')).toBe(body);
  });

  it('strips a real inline note but keeps %% inside backticks on the same line', () => {
    const body = 'Write `%%` here %% @jdoe: drop this %% and done.';
    expect(stripAuthorNotes(body, 'prod')).toBe('Write `%%` here  and done.');
  });

  it('does NOT strip %% inside an HTML comment block', () => {
    const body = '<!-- example author note: %% @jdoe: hi %% -->';
    expect(stripAuthorNotes(body, 'prod')).toBe(body);
  });

  it('handles a tutorial with no notes', () => {
    const body = 'No notes here.';
    expect(stripAuthorNotes(body, 'prod')).toBe(body);
  });

  it('warns and strips to end for unterminated inline note', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const body = 'Prefix %% unclosed\nNext line.';
    const result = stripAuthorNotes(body, 'prod');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[author-notes]'));
    expect(result).not.toContain('%%');
    warnSpy.mockRestore();
  });

  it('includes slug in warn message when provided', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stripAuthorNotes('Prefix %% unclosed', 'prod', 'my-tutorial');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('in my-tutorial'));
    warnSpy.mockRestore();
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

  it('does NOT process %% on the fence delimiter line itself', () => {
    // The opening fence delimiter line is classified as 'code' by classifyLines,
    // so a %% on it must not be treated as an author note.
    const body = '```sql %%\nSELECT 1;\n```';
    expect(stripAuthorNotes(body, 'prod')).toBe(body);
    expect(stripAuthorNotes(body, 'qa')).toBe(body);
  });

  it('renders block note as div with attribution on QA', () => {
    const body = 'Before.\n%%\n@jdoe: Note text here.\n%%\nAfter.';
    const result = stripAuthorNotes(body, 'qa');
    expect(result).toContain('class="tut-author-note-block"');
    expect(result).toContain('data-author="jdoe"');
    expect(result).toContain('Note text here.');
  });

  it('preserves all lines of a multi-line block note body on QA', () => {
    const body = '%%\n@jdoe: Summary line\nMore detail\nEven more\n%%';
    const result = stripAuthorNotes(body, 'qa');
    expect(result).toContain('data-author="jdoe"');
    expect(result).toContain('Summary line');
    expect(result).toContain('More detail');
    expect(result).toContain('Even more');
  });
});
