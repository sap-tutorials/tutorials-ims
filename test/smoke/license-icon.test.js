import { describe, it, expect, beforeAll } from 'vitest';
import { BASE_URL, fetchWithRetry } from './smoke.config.js';

describe('License key icon (issue #81)', () => {
  describe('license-gated tutorial: joulestudio-agent-create', () => {
    let html;
    beforeAll(async () => {
      const res = await fetchWithRetry(`${BASE_URL}/tutorials/joulestudio-agent-create/`);
      expect(res.status).toBe(200);
      html = await res.text();
    });

    it('renders the .license-key element', () => {
      expect(html).toMatch(/class=["']?license-key["']?/);
    });

    it('exposes the "Requires a product license" aria-label', () => {
      expect(html).toMatch(/aria-label=["']?Requires a product license["']?/);
    });

    it('does NOT render a "License" op-chip in the header chip strip', () => {
      // Scope to op-chip--tag spans (the chip-strip class) to avoid false negatives
      // from step bodies that may legitimately discuss licensing.
      const chipMatches = html.match(/<span[^>]*class=["']?op-chip op-chip--tag["']?[^>]*>([^<]*)<\/span>/g) || [];
      const chipTexts = chipMatches.map(m => m.replace(/<[^>]+>/g, '').trim());
      expect(chipTexts).not.toContain('License');
    });
  });

  describe('non-license tutorial: abap-cloud-ui-from-interface', () => {
    let html;
    beforeAll(async () => {
      const res = await fetchWithRetry(`${BASE_URL}/tutorials/abap-cloud-ui-from-interface/`);
      expect(res.status).toBe(200);
      html = await res.text();
    });

    it('does NOT render the .license-key element', () => {
      expect(html).not.toMatch(/class=["']?license-key["']?/);
    });
  });
});
