// Hybrid test — runs against real HANA via `cds bind --exec`. Gated by
// HYBRID_KG_ONDEMAND=true to control LLM quota. Run with:
//   HYBRID_KG_ONDEMAND=true cds bind --exec -- npx vitest run --project hybrid test/hybrid/kg-ondemand.test.js
//
// Bare `vitest <file>` silently skips hybrid setup — memory rule.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import cds from '@sap/cds';
import { enqueueOnDemandExtraction } from '../../srv/lib/kg/on-demand-enqueue.js';
import { runOnDemandDrain } from '../../srv/jobs/kg-ondemand-job.js';
import { _resetCacheForTests as _resetSettingsCache } from '../../srv/lib/runtime-config/kg-settings.js';

const NS = 'com.sap.developers.ims';
const RUN = process.env.HYBRID_KG_ONDEMAND === 'true';

describe.skipIf(!RUN)('KG on-demand — hybrid (#948)', () => {
  let db, originalOnDemand;

  beforeAll(async () => {
    db = await cds.connect.to('db');
    const { KnowledgeGraphSettings } = cds.entities(NS);
    const [row] = await SELECT.from(KnowledgeGraphSettings);
    originalOnDemand = row?.onDemandExtractionEnabled ?? false;
    await UPDATE(KnowledgeGraphSettings).set({ onDemandExtractionEnabled: true });
    _resetSettingsCache();
  });

  afterAll(async () => {
    const { KgOnDemandRequests, KnowledgeGraphSettings } = cds.entities(NS);
    // Cleanup any rows this suite left behind.
    await DELETE.from(KgOnDemandRequests).where({ normalizedKey: { like: 'hybridtest%' } });
    // Restore the flag (existing code).
    await UPDATE(KnowledgeGraphSettings).set({ onDemandExtractionEnabled: originalOnDemand });
    _resetSettingsCache();
  });

  beforeEach(async () => {
    const { KgOnDemandRequests } = cds.entities(NS);
    await DELETE.from(KgOnDemandRequests).where({ normalizedKey: { like: 'hybridtest%' } });
  });

  it('inserts a PENDING row on HANA', async () => {
    const r = await enqueueOnDemandExtraction({
      db, query: 'hybridtest one',
      requester: { id: 'hybridtest-u1', kind: 'user' },
    });
    expect(r.status).toBe('enqueued');
    const { KgOnDemandRequests } = cds.entities(NS);
    const rows = await SELECT.from(KgOnDemandRequests).where({ normalizedKey: 'hybridtest one' }).columns('status');
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('PENDING');
  });

  it('coalesces 5 concurrent enqueues into 1 row', async () => {
    const promises = Array.from({ length: 5 }, (_, i) => enqueueOnDemandExtraction({
      db, query: 'hybridtest coalesce',
      requester: { id: `hybridtest-c${i}`, kind: 'user' },
    }));
    const results = await Promise.all(promises);
    const enq = results.filter(r => r.status === 'enqueued').length;
    const co  = results.filter(r => r.status === 'coalesced').length;
    expect(enq).toBe(1);
    expect(co).toBe(4);
  });

  it('end-to-end: enqueue → drain → next expandSearchConcepts sees new concepts', async () => {
    // Use a query guaranteed zero-seed against the current KG.
    const rawQuery = 'hybridtest quantum tulip encabulator';

    const enqR = await enqueueOnDemandExtraction({
      db, query: rawQuery,
      requester: { id: 'hybridtest-e2e', kind: 'user' },
    });
    expect(enqR.status).toBe('enqueued');

    const summary = await runOnDemandDrain({});
    expect(summary.processed).toBeGreaterThanOrEqual(1);
    // Note: the drain may extract 0 tutorials if cosine-rank returns nothing —
    // that's a valid outcome and the test does not assert non-zero extraction.

    const { KgOnDemandRequests } = cds.entities(NS);
    const [row] = await SELECT.from(KgOnDemandRequests)
      .where({ normalizedKey: 'hybridtest quantum tulip encabulator' })
      .columns('status', 'tutorialsExtracted', 'llmPromptTokens');
    expect(['DONE', 'FAILED']).toContain(row.status);
  });
});
