// Hybrid AI test for the homepage explainer generator (#759 PR 3a).
//
// Gated by HYBRID_AI_TESTS=true so default `npm run test:hybrid` stays
// free. When enabled, makes 3 real AI Core calls (~$0.05 total).
// Asserts the orchestrator returns the expected JSON shape and the
// action handler persists the status transition.

import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
import { isSafeForWrites } from './_guard.js';

const RUN = process.env.HYBRID_AI_TESTS === 'true' && isSafeForWrites();

(RUN ? describe : describe.skip)('hybrid: explainer generation against real HANA + AI Core (#759 PR 3a)', () => {
  let db;
  beforeAll(async () => { db = await cds.connect.to('db'); });

  it('generates a verb explainer end-to-end', async () => {
    const { generateExplainer } = await import('../../srv/lib/explainer-generator.js');
    const result = await generateExplainer({
      kind: 'verb',
      row: { verbKey: 'LEARN', label: 'Learn' },
    });
    expect(result).not.toBeNull();
    expect(typeof result.tagline).toBe('string');
    expect(result.tagline.length).toBeGreaterThan(0);
    expect(result.tagline.length).toBeLessThanOrEqual(140);
    expect(typeof result.whyItMatters).toBe('string');
    expect(result.whyItMatters.length).toBeGreaterThan(0);
    expect(result.whyItMatters.length).toBeLessThanOrEqual(800);
    expect(result.costCents).toBeGreaterThan(0);
  });

  it('generates a shelf explainer', async () => {
    const { generateExplainer } = await import('../../srv/lib/explainer-generator.js');
    const result = await generateExplainer({
      kind: 'shelf',
      row: { shelfKey: 'START_HERE', label: 'Start here' },
    });
    expect(result?.tagline).toBeTruthy();
  });

  it('generates a shelf-entry explainer with verb context', async () => {
    const { generateExplainer } = await import('../../srv/lib/explainer-generator.js');
    const result = await generateExplainer({
      kind: 'shelf-entry',
      row: {
        title: 'SAP Joule',
        url: 'https://help.sap.com/docs/joule',
        description: "SAP's generative AI copilot",
      },
      context: {
        verbDefinition: {
          label: 'Extend with AI',
          tagline: 'Build AI capabilities into SAP apps',
        },
      },
    });
    expect(result?.whyItMatters).toBeTruthy();
  });

  it('action handler persists status transition BLANK → AI_SEEDED', async () => {
    const admin = await cds.connect.to('AdminService');
    // Pick a verb that's currently BLANK; reset if needed.
    await db.run(UPDATE('com.sap.developers.ims.VerbDefinitions')
      .set({ authoringStatus: 'BLANK', tagline: null, whyItMatters: null })
      .where({ verbKey: 'CONNECT' }));
    const result = await admin.send('generateVerbExplainers', {
      ids: [], mode: 'fill-blanks',
    });
    expect(result.processed).toBeGreaterThan(0);
    const after = await db.run(SELECT.one.from('com.sap.developers.ims.VerbDefinitions')
      .where({ verbKey: 'CONNECT' }));
    expect(['AI_SEEDED', 'REVIEWED']).toContain(after.authoringStatus);
    expect(after.tagline?.length).toBeGreaterThan(0);
  });
});
