// test/hybrid/author-service-os-variants.test.js
// Hybrid test for issue #173 /author/generateOsVariants — opt-in via HYBRID_AI_TESTS=true
// (mirrors test/hybrid/categories-classifier.test.js pattern). Default skip keeps
// `npm run test:hybrid` at $0/run.

import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
import './_guard.js'; // hybrid write-safety guard

const HYBRID_AI = process.env.HYBRID_AI_TESTS === 'true';

describe.skipIf(!HYBRID_AI)('AuthorService.generateOsVariants — hybrid (real AI Core)', () => {
  let srv;

  beforeAll(async () => {
    srv = await cds.connect.to('AuthorService');
  });

  it('returns valid markdown variants for a Windows -> macOS+Linux PowerShell snippet', async () => {
    const result = await srv.send('generateOsVariants', {
      sourceMarkdown: 'Open PowerShell and run:\n\n```powershell\ncd $HOME\\projects\nnpm install\n```',
      sourceOS: 'Windows',
      targetOSes: ['macOS', 'Linux'],
      context: { tutorialSlug: '__TEST__os-variants', stepHeading: 'Setup' },
    });

    expect(result.variants).toHaveLength(2);
    expect(result.variants[0].os).toBe('macOS');
    expect(result.variants[1].os).toBe('Linux');

    const mac = result.variants[0].markdown.toLowerCase();
    expect(mac).toMatch(/terminal|bash/);
    expect(mac).toMatch(/~\//);

    const linux = result.variants[1].markdown.toLowerCase();
    expect(linux).toMatch(/terminal|bash/);

    expect(mac).not.toContain('powershell');
    expect(linux).not.toContain('powershell');

    expect(result.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.tokensUsed).toBeGreaterThan(0);
  }, 60_000);
});
