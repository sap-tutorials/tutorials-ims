import { describe, it, expect } from 'vitest';
import { detectLanguageEn } from '../../srv/lib/detect-language-en.js';

describe('detectLanguageEn', () => {
  it('returns "en" for clearly English text with 3+ function words', () => {
    expect(detectLanguageEn('The CAP framework is the future of SAP development for developers.')).toBe('en');
  });
  it('returns null for text with <3 function-word hits', () => {
    expect(detectLanguageEn('CAP')).toBeNull();
    expect(detectLanguageEn('Buenos dias amigos, hola mundo!')).toBeNull();
  });
  it('returns null when non-Latin-1 chars are present', () => {
    expect(detectLanguageEn('CJK characters here 日 the of and')).toBeNull();
  });
  it('is case-insensitive on function-word matching', () => {
    expect(detectLanguageEn('THE OF AND to is')).toBe('en');
  });
  it('matches only on word boundaries', () => {
    expect(detectLanguageEn('theofandtois something')).toBeNull();
  });
  it('handles empty / null gracefully', () => {
    expect(detectLanguageEn('')).toBeNull();
    expect(detectLanguageEn(null)).toBeNull();
    expect(detectLanguageEn(undefined)).toBeNull();
  });
});
