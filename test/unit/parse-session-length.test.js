import { describe, it, expect } from 'vitest';
import { parseSessionLengthMinutes } from '../../srv/lib/parse-session-length.js';

describe('parseSessionLengthMinutes', () => {
  it('defaults to 60 for empty/nullish input', () => {
    expect(parseSessionLengthMinutes(null)).toBe(60);
    expect(parseSessionLengthMinutes(undefined)).toBe(60);
    expect(parseSessionLengthMinutes('')).toBe(60);
    expect(parseSessionLengthMinutes('   ')).toBe(60);
  });

  it('accepts a caller-supplied default', () => {
    expect(parseSessionLengthMinutes('', 45)).toBe(45);
    expect(parseSessionLengthMinutes('garbage', 30)).toBe(30);
  });

  it('parses plain minutes with a unit word', () => {
    expect(parseSessionLengthMinutes('30 min')).toBe(30);
    expect(parseSessionLengthMinutes('45 minutes')).toBe(45);
    expect(parseSessionLengthMinutes('90m')).toBe(90);
    expect(parseSessionLengthMinutes('20 mins')).toBe(20);
  });

  it('parses whole hours', () => {
    expect(parseSessionLengthMinutes('1 hour')).toBe(60);
    expect(parseSessionLengthMinutes('2 hours')).toBe(120);
    expect(parseSessionLengthMinutes('1 hr')).toBe(60);
    expect(parseSessionLengthMinutes('1h')).toBe(60);
  });

  it('parses fractional hours', () => {
    expect(parseSessionLengthMinutes('1.5 hours')).toBe(90);
    expect(parseSessionLengthMinutes('0.5 hr')).toBe(30);
  });

  it('parses combined hours and minutes', () => {
    expect(parseSessionLengthMinutes('1 hour 30 min')).toBe(90);
    expect(parseSessionLengthMinutes('1h15m')).toBe(75);
  });

  it('treats a bare number as minutes', () => {
    expect(parseSessionLengthMinutes('45')).toBe(45);
    expect(parseSessionLengthMinutes('90')).toBe(90);
  });

  it('is case-insensitive and tolerant of surrounding text', () => {
    expect(parseSessionLengthMinutes('Approx. 30 MIN session')).toBe(30);
    expect(parseSessionLengthMinutes('  60 Minutes  ')).toBe(60);
  });

  it('falls back to default for zero or negative results', () => {
    expect(parseSessionLengthMinutes('0 min')).toBe(60);
    expect(parseSessionLengthMinutes('0 hours', 45)).toBe(45);
  });
});
