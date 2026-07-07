import { describe, it, expect } from 'vitest';
import { classifyByKeywords } from '../../srv/lib/relevance-keyword-rules.js';

describe('classifyByKeywords', () => {
  it('allowlist hit + no blocklist → relevant', () => {
    const r = classifyByKeywords({ title: 'New CAP release', description: 'Java 22 support for SDK.' });
    expect(r.verdict).toBe('relevant');
    expect(r.reason).toMatch(/allowlist/i);
  });
  it('allowlist + blocklist → not-relevant (blocklist wins)', () => {
    const r = classifyByKeywords({ title: 'SAP announces CAP partnership', description: 'CEO comments on Q2 earnings.' });
    expect(r.verdict).toBe('not-relevant');
    expect(r.reason).toMatch(/blocklist/i);
  });
  it('no allowlist hit → not-relevant', () => {
    const r = classifyByKeywords({ title: 'Executive appointment', description: 'New board member joins.' });
    expect(r.verdict).toBe('not-relevant');
  });
  it('is case-insensitive', () => {
    expect(classifyByKeywords({ title: 'sap btp release', description: 'new api and sdk' }).verdict).toBe('relevant');
  });
  it('respects word boundaries — "capitalization" does not match "CAP"', () => {
    const r = classifyByKeywords({ title: 'Capitalization matters', description: 'A grammar note.' });
    expect(r.verdict).toBe('not-relevant');
  });
  it('tolerates null description', () => {
    expect(classifyByKeywords({ title: 'CAP API demo', description: null }).verdict).toBe('relevant');
  });
  it('tolerates undefined title', () => {
    expect(classifyByKeywords({ title: undefined, description: 'API sample' }).verdict).toBe('relevant');
  });
  it('blocklist matches inflected forms of "celebrate"', () => {
    for (const w of ['celebrates', 'celebrated', 'celebration', 'celebrating']) {
      const r = classifyByKeywords({ title: `SAP ${w} the launch`, description: 'API news' });
      expect(r.verdict, `for word "${w}"`).toBe('not-relevant');
    }
  });
});
