import { describe, it, expect } from 'vitest';
import cds from '@sap/cds';
import { isSafeForWrites } from './_guard.js';

const RUN = process.env.HYBRID_AI_TESTS === 'true' && isSafeForWrites();

cds.test('serve', '--project', '.', '--profile', 'hybrid');

(RUN ? describe : describe.skip)('hybrid: classifier against real HANA + AI Core', () => {
  it('classifies a known AI-themed mission into artificial-intelligence', async () => {
    const { classifyAndPersist } = await import('../../srv/lib/category-classifier.js');
    // Pick a deterministic seed mission slug that should land in AI.
    // Falls back to skip if fixture missing — safe for sample DEV data drift.
    const [m] = await SELECT.from('com.sap.developers.ims.Missions')
      .columns('ID')
      .where({ slug: 'ai-mission-fixture' })
      .limit(1);
    if (!m) {
      console.warn('[hybrid] ai-mission-fixture not found in DEV — skipping');
      return;
    }
    const r = await classifyAndPersist('mission', m.ID);
    expect(r.kept).toBe(1);
    expect(r.assigned.map(a => a.slug)).toContain('artificial-intelligence');
  });
});
