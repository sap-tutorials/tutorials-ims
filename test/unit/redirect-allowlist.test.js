import { describe, it, expect } from 'vitest';
import { isAllowedTarget, ALLOWED_HOSTS } from '../../srv/lib/redirect-allowlist.js';

describe('isAllowedTarget — same-origin (preserves #891 behavior)', () => {
  it('accepts same-origin absolute paths', () => {
    expect(isAllowedTarget('/foo')).toBe(true);
    expect(isAllowedTarget('/foo/bar?q=1')).toBe(true);
    expect(isAllowedTarget('/')).toBe(true);
  });
  it('rejects protocol-relative and bare paths', () => {
    expect(isAllowedTarget('//community.sap.com')).toBe(false);
    expect(isAllowedTarget('foo')).toBe(false);
    expect(isAllowedTarget('')).toBe(false);
  });
});

describe('isAllowedTarget — allowlisted external hosts', () => {
  it('accepts https on an allowlisted host', () => {
    expect(isAllowedTarget('https://community.sap.com/topics/leonardo')).toBe(true);
    expect(isAllowedTarget('https://opensource.sap.com/')).toBe(true);
    expect(isAllowedTarget('https://www.sap.com/products/try-sap/trials-downloads.html')).toBe(true);
    expect(isAllowedTarget('https://help.sap.com/doc/abc/Cloud/en-US/index.html')).toBe(true);
    expect(isAllowedTarget('https://pages.community.sap.com/topics/business-technology-platform')).toBe(true);
  });
  it('rejects non-allowlisted hosts', () => {
    expect(isAllowedTarget('https://attacker.example/x')).toBe(false);
    expect(isAllowedTarget('https://sap.com.attacker.example/x')).toBe(false);
  });
  it('rejects non-https schemes even on allowlisted hosts', () => {
    expect(isAllowedTarget('http://community.sap.com/x')).toBe(false);
    expect(isAllowedTarget('javascript:alert(1)')).toBe(false);
    expect(isAllowedTarget('data:text/html,x')).toBe(false);
  });
  it('rejects userinfo smuggling and host injection attempts', () => {
    expect(isAllowedTarget('https://community.sap.com@evil.com/x')).toBe(false);
    expect(isAllowedTarget('https://community.sap.com.evil.com/x')).toBe(false);
  });
  it('rejects mailto and other non-http(s) schemes', () => {
    expect(isAllowedTarget('mailto:evil@attacker.example')).toBe(false);
  });
  it('exposes the exact five allowlisted hosts', () => {
    expect([...ALLOWED_HOSTS].sort()).toEqual([
      'community.sap.com', 'help.sap.com', 'opensource.sap.com',
      'pages.community.sap.com', 'www.sap.com',
    ]);
  });
});
