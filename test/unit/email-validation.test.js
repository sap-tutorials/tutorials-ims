import { describe, it, expect } from 'vitest';
import { validateEmail } from '../../srv/lib/email-validation.js';

describe('validateEmail', () => {
  it('accepts a normal email and returns trimmed-lowercase', () => {
    expect(validateEmail('Tom@SAP.com')).toEqual({ ok: true, value: 'tom@sap.com' });
  });

  it('trims surrounding whitespace before validating', () => {
    expect(validateEmail('  tom@sap.com  ')).toEqual({ ok: true, value: 'tom@sap.com' });
  });

  it('rejects empty string with EMAIL_REQUIRED', () => {
    expect(validateEmail('')).toEqual({ ok: false, code: 'EMAIL_REQUIRED' });
  });

  it('rejects whitespace-only with EMAIL_REQUIRED', () => {
    expect(validateEmail('   ')).toEqual({ ok: false, code: 'EMAIL_REQUIRED' });
  });

  it('rejects null/undefined with EMAIL_REQUIRED', () => {
    expect(validateEmail(null)).toEqual({ ok: false, code: 'EMAIL_REQUIRED' });
    expect(validateEmail(undefined)).toEqual({ ok: false, code: 'EMAIL_REQUIRED' });
  });

  it('rejects malformed (no @) with EMAIL_INVALID', () => {
    expect(validateEmail('not-an-email')).toEqual({ ok: false, code: 'EMAIL_INVALID' });
  });

  it('rejects malformed (no domain) with EMAIL_INVALID', () => {
    expect(validateEmail('tom@')).toEqual({ ok: false, code: 'EMAIL_INVALID' });
  });

  it('rejects malformed (no TLD) with EMAIL_INVALID', () => {
    expect(validateEmail('tom@sap')).toEqual({ ok: false, code: 'EMAIL_INVALID' });
  });

  it('rejects emails longer than 254 chars with EMAIL_TOO_LONG', () => {
    const long = 'a'.repeat(250) + '@b.co';  // 256 chars
    expect(validateEmail(long)).toEqual({ ok: false, code: 'EMAIL_TOO_LONG' });
  });

  it('accepts a 254-char email (boundary)', () => {
    const exactly254 = 'a'.repeat(248) + '@b.co';  // 254 chars
    const out = validateEmail(exactly254);
    expect(out.ok).toBe(true);
  });
});
