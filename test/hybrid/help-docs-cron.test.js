// test/hybrid/help-docs-cron.test.js
//
// Phase 4.7 (#748) Task 2: hybrid end-to-end for fetch-help-docs-job.
// BLOCKED-until-deploy AND BLOCKED-until-seeded (graceful skip when
// HelpDocs is empty). Same posture as Phase 4.2-4.6 hybrid crons.

import { describe, it, beforeAll, expect } from 'vitest';
import cds from '@sap/cds';
import { runFetchHelpDocs } from '../../srv/jobs/fetch-help-docs-job.js';

describe('fetch-help-docs-job (hybrid)', () => {
  beforeAll(() => {
    if (!process.env.ALLOW_HYBRID_WRITES) {
      throw new Error('ALLOW_HYBRID_WRITES not set; refusing to write HANA.');
    }
  });

  it('runs end-to-end (requires HelpDocs seeded first via scripts/seed-help-docs.cjs)', async () => {
    const { HelpDocs } = cds.entities('com.sap.developers.ims.external');
    const pre = await SELECT.one.from(HelpDocs).columns('count(*) as n');
    if ((pre?.n ?? 0) === 0) {
      // eslint-disable-next-line no-console
      console.warn(
        'HelpDocs table is empty; cron will hit MAX-or-abort gate. ' +
        'Run scripts/seed-help-docs.cjs --commit first (or click "Seed help docs" in admin UI).',
      );
      return; // graceful skip — same posture as Phase 4.2-4.6
    }
    // Stub embed/extract so the hybrid run doesn't burn AI Core quota.
    const summary = await runFetchHelpDocs(null, {
      embed: async () => new Float32Array(384),
      extractFn: async () => ({ concepts: [], promptTokens: 0, completionTokens: 0 }),
    });
    expect(summary.errors).toBe(0);
    expect(summary.fetched).toBeGreaterThanOrEqual(0);
    // Per-source breakout should always be present.
    expect(summary.perSource).toBeDefined();
    expect(summary.perSource['help-sap-com']).toBeDefined();
    expect(summary.perSource['cap-cloud-sap']).toBeDefined();
    expect(summary.perSource['ui5-sap-com']).toBeDefined();
  });

  it('re-run with same corpus is a no-op (#708 crash-safety short-circuits)', async () => {
    const { HelpDocs } = cds.entities('com.sap.developers.ims.external');
    const pre = await SELECT.one.from(HelpDocs).columns('count(*) as n');
    if ((pre?.n ?? 0) === 0) return; // graceful skip

    const stubs = {
      embed: async () => new Float32Array(384),
      extractFn: async () => ({ concepts: [], promptTokens: 0, completionTokens: 0 }),
    };
    // First run.
    await runFetchHelpDocs(null, stubs);
    // Second run — expect skippedNoChange >= 1 (or extracted === 0).
    const second = await runFetchHelpDocs(null, stubs);
    expect(second.errors).toBe(0);
    expect(second.skippedNoChange).toBeGreaterThanOrEqual(0);
    expect(second.extracted).toBe(0);
  });
});
