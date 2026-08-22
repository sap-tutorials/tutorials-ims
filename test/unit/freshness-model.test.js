// test/unit/freshness-model.test.js
// Task 2: Persistence layer smoke test — FreshnessReport + FreshnessFinding entities.
// Verifies the new CDS model deploys to SQLite, INSERT works, and the default
// disposition is 'OPEN'.

import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

describe('freshness data model', () => {
  let db;
  beforeAll(async () => { db = await cds.connect.to('db'); });

  it('persists a report with findings and defaults disposition to OPEN', async () => {
    const { FreshnessReport, FreshnessFinding } = cds.entities('com.sap.developers.ims');
    const reportId = cds.utils.uuid();
    await db.run(INSERT.into(FreshnessReport).entries({
      ID: reportId, tutorial_ID: null, status: 'DONE', model: 'test', cost: '$0.00', openHighCount: 1,
    }));
    await db.run(INSERT.into(FreshnessFinding).entries({
      ID: cds.utils.uuid(), report_ID: reportId, tutorial_ID: null,
      fingerprint: 'abc', category: 'obsolete-dep', severity: 'High', confidence: 'High',
      stepRef: 1, codeBlockIndex: 0, lang: 'JavaScript', evidence: 'require("node-fetch")',
      summary: 'node-fetch obsolete', suggestedFix: 'use native fetch', groundingSource: 'https://x',
    }));
    const f = await db.run(SELECT.one.from(FreshnessFinding).where({ report_ID: reportId }));
    expect(f.disposition).toBe('OPEN');
    expect(f.confidence).toBe('High');
  });
});
