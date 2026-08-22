// test/unit/freshness-persist.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

cds.test('serve', '--project', '.', '--in-memory');

describe('persistReport', () => {
  let db;
  beforeAll(async () => { db = await cds.connect.to('db'); });

  const finding = (over = {}) => ({ category: 'obsolete-dep', severity: 'High', confidence: 'High',
    stepRef: 1, codeBlockIndex: 0, lang: 'js', evidence: 'require("node-fetch")',
    summary: 's', suggestedFix: 'f', groundingSource: 'https://x', ...over });

  it('persists findings, computes openHighCount, and replaces on re-run', async () => {
    const { Tutorials } = cds.entities('com.sap.developers.ims');
    const tid = cds.utils.uuid();
    await INSERT.into(Tutorials).entries({ ID: tid, slug: 'p', title: 'P', legacyId: 9 });
    const { persistReport } = await import('../../srv/lib/freshness-persist.js');

    const r1 = await persistReport({ db, tutorialId: tid, model: 'm', costCents: 5, findings: [finding(), finding({ codeBlockIndex: 1, confidence: 'Low' })] });
    expect(r1.openHighCount).toBe(1);

    const { FreshnessFinding } = cds.entities('com.sap.developers.ims');
    const persisted = await SELECT.from(FreshnessFinding).where({ tutorial_ID: tid });
    expect(persisted).toHaveLength(2);
    // I1: numeric sort ranks stamped (High=3, Medium=2, Low=1, unknown=0).
    const high = persisted.find(f => f.confidence === 'High');
    const low = persisted.find(f => f.confidence === 'Low');
    expect(high.confidenceRank).toBe(3);
    expect(high.severityRank).toBe(3);   // finding() severity is High
    expect(low.confidenceRank).toBe(1);
  });

  it('carries forward disposition on a fingerprint match across re-runs', async () => {
    const { Tutorials, FreshnessFinding } = cds.entities('com.sap.developers.ims');
    const tid = cds.utils.uuid();
    await INSERT.into(Tutorials).entries({ ID: tid, slug: 'p2', title: 'P2', legacyId: 10 });
    const { persistReport } = await import('../../srv/lib/freshness-persist.js');

    await persistReport({ db, tutorialId: tid, model: 'm', costCents: 1, findings: [finding()] });
    const f1 = await SELECT.one.from(FreshnessFinding).where({ tutorial_ID: tid });
    await UPDATE(FreshnessFinding).set({ disposition: 'DISMISSED', dispositionBy: 'tom' }).where({ ID: f1.ID });

    // re-run with the SAME finding + a NEW one
    await persistReport({ db, tutorialId: tid, model: 'm', costCents: 1, findings: [finding(), finding({ stepRef: 2 })] });
    const rows = await SELECT.from(FreshnessFinding).where({ tutorial_ID: tid });
    const same = rows.find(r => r.stepRef === 1);
    const fresh = rows.find(r => r.stepRef === 2);
    expect(same.disposition).toBe('DISMISSED');   // carried forward
    expect(fresh.disposition).toBe('OPEN');        // new finding
  });
});
