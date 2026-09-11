import { describe, it, expect } from 'vitest';
import { prefersMarkdown } from '../../lib/tutorial-markdown.js';

describe('prefersMarkdown', () => {
  it('true when only text/markdown is requested', () => {
    expect(prefersMarkdown('text/markdown')).toBe(true);
  });

  it('true when markdown q-value exceeds html', () => {
    expect(prefersMarkdown('text/markdown;q=0.9, text/html;q=0.8')).toBe(true);
  });

  it('true when markdown and html are equally weighted', () => {
    expect(prefersMarkdown('text/markdown, text/html')).toBe(true);
  });

  it('false for a typical browser Accept header (no markdown)', () => {
    expect(
      prefersMarkdown('text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'),
    ).toBe(false);
  });

  it('false when html outranks a lower-weighted markdown', () => {
    expect(prefersMarkdown('text/html, text/markdown;q=0.5')).toBe(false);
  });

  it('false when markdown is explicitly refused (q=0)', () => {
    expect(prefersMarkdown('text/markdown;q=0, text/html')).toBe(false);
  });

  it('false for a wildcard-only Accept header', () => {
    expect(prefersMarkdown('*/*')).toBe(false);
  });

  it('false for missing / empty / non-string headers', () => {
    expect(prefersMarkdown(undefined)).toBe(false);
    expect(prefersMarkdown('')).toBe(false);
    expect(prefersMarkdown(null)).toBe(false);
    expect(prefersMarkdown(42)).toBe(false);
  });

  it('handles whitespace and casing', () => {
    expect(prefersMarkdown('  TEXT/MARKDOWN ')).toBe(true);
  });
});
