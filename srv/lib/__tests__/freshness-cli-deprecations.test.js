import { describe, it, expect } from 'vitest';
import { scanCliDeprecations } from '../freshness-detector.js';

describe('scanCliDeprecations', () => {
  it('flags a deprecated --hostname in a bash fence', () => {
    const md = '### Step 1\n\n```bash\ncf push app --hostname myhost\n```\n';
    const findings = scanCliDeprecations(md);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0].category).toBe('deprecated-api');
    expect(findings[0].confidence).toBe('High');
    expect(findings[0].groundingSource).toMatch(/^https?:\/\//);
  });

  it('returns empty for clean source', () => {
    const md = '### Step 1\n\nSome prose.\n';
    expect(scanCliDeprecations(md)).toHaveLength(0);
  });
});
