import { describe, it, expect } from 'vitest';
import { CTA_TARGETS, listCtaTargets } from '../alert-cta-targets.js';

describe('alert-cta-targets', () => {
  it('exports a stable array of {url, label} entries', () => {
    expect(Array.isArray(CTA_TARGETS)).toBe(true);
    expect(CTA_TARGETS.length).toBeGreaterThan(0);
    for (const t of CTA_TARGETS) {
      expect(t).toHaveProperty('url');
      expect(t).toHaveProperty('label');
      expect(typeof t.url).toBe('string');
      expect(typeof t.label).toBe('string');
    }
  });

  it('listCtaTargets() returns a shallow copy', () => {
    const a = listCtaTargets();
    const b = listCtaTargets();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });

  it('includes the canonical anchor routes', () => {
    const urls = CTA_TARGETS.map(t => t.url);
    expect(urls).toContain('/');
    expect(urls).toContain('/browse/');
    expect(urls).toContain('/devtoberfest/');
    expect(urls).toContain('/developer-advocates/');
  });
});
