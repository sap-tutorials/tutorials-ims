import { describe, it, expect } from 'vitest';
import { isOriginAllowed, DEFAULT_ALLOWED_ORIGIN_PATTERNS } from './origin';

describe('isOriginAllowed', () => {
  const self = 'https://developers.sap.com';

  it('allows exact self origin', () => {
    expect(isOriginAllowed(self, DEFAULT_ALLOWED_ORIGIN_PATTERNS, self)).toBe(true);
  });

  it('allows a wildcard-subdomain match on *.sap.com', () => {
    expect(isOriginAllowed('https://trial.sap.com', DEFAULT_ALLOWED_ORIGIN_PATTERNS, self)).toBe(true);
    expect(isOriginAllowed('https://a.b.cloud.sap', DEFAULT_ALLOWED_ORIGIN_PATTERNS, self)).toBe(true);
  });

  it('rejects a foreign origin', () => {
    expect(isOriginAllowed('https://evil.example.com', DEFAULT_ALLOWED_ORIGIN_PATTERNS, self)).toBe(false);
  });

  it('rejects a look-alike suffix attack (notsap.com)', () => {
    expect(isOriginAllowed('https://notsap.com', DEFAULT_ALLOWED_ORIGIN_PATTERNS, self)).toBe(false);
    expect(isOriginAllowed('https://sap.com.evil.com', DEFAULT_ALLOWED_ORIGIN_PATTERNS, self)).toBe(false);
  });

  it('rejects http downgrade for a wildcard https pattern', () => {
    expect(isOriginAllowed('http://trial.sap.com', DEFAULT_ALLOWED_ORIGIN_PATTERNS, self)).toBe(false);
  });

  it('rejects the literal wildcard "*"', () => {
    expect(isOriginAllowed('*', DEFAULT_ALLOWED_ORIGIN_PATTERNS, self)).toBe(false);
  });
});
