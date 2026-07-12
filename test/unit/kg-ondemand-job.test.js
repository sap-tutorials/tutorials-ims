// test/unit/kg-ondemand-job.test.js
//
// Unit tests for runOnDemandDrain (#948). All mocks injected via deps —
// no LLM calls, no real embed client. Uses in-memory SQLite.
//
// embed() mock contract: returns Float32Array[] (array of Float32Arrays),
// matching the real embed() signature (inputs: string[] → Float32Array[]).
// The drain calls embedOne which does: const [vec] = await embedFn([query]).
//
// 6 test cases:
//   1. kg-disabled flag → skips with reason='kg-disabled'
//   2. ondemand-disabled flag → skips with reason='ondemand-disabled'
//   3. Happy path: 2 PENDING rows → both DONE
//   4. Extraction throws once → row PENDING with attempts=1
//   5. Extraction throws N times (MAX_ATTEMPTS=2) → row FAILED
//   6. Empty top-K → row DONE with tutorialsExtracted=0, no LLM calls
//   7. DRAIN_BATCH bounds per-tick work (5 rows, batch=2 → 2 processed)
//
// Issue: #948

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import cds from '@sap/cds';
import { runOnDemandDrain } from '../../srv/jobs/kg-ondemand-job.js';
import { _resetCacheForTests as _resetSettingsCache } from '../../srv/lib/runtime-config/kg-settings.js';

const NS = 'com.sap.developers.ims';

async function setFlags({ enabled = true, onDemand = true } = {}) {
  const { KnowledgeGraphSettings } = cds.entities(NS);
  await DELETE.from(KnowledgeGraphSettings);
  await INSERT.into(KnowledgeGraphSettings).entries({
    enabled, onDemandExtractionEnabled: onDemand,
    extractBuildCap: 200,
  });
  _resetSettingsCache();
}

async function seedPending(rows) {
  const { KgOnDemandRequests } = cds.entities(NS);
  await DELETE.from(KgOnDemandRequests);
  for (let i = 0; i < rows.length; i++) {
    await INSERT.into(KgOnDemandRequests).entries({
      ID: `qqqqqqqq-${String(i).padStart(4, '0')}-0000-0000-000000000000`,
      query: rows[i].query,
      normalizedKey: rows[i].normalizedKey ?? rows[i].query,
      status: 'PENDING',
      requestedByKind: 'user',
    });
  }
}

// embed() mock: returns Float32Array[] so embedOne can do const [vec] = await embedFn([query])
function makeEmbedMock() {
  return vi.fn(async () => [new Float32Array(1536).fill(0.1)]);
}

describe('runOnDemandDrain (#948)', () => {
  beforeAll(async () => {
    await cds.deploy(cds.env.roots).to('sqlite::memory:');
  });

  beforeEach(async () => {
    const { KgOnDemandRequests, Tutorials, TutorialEmbedding, Concepts } = cds.entities(NS);
    await DELETE.from(KgOnDemandRequests);
    await DELETE.from(TutorialEmbedding);
    await DELETE.from(Concepts);
    await DELETE.from(Tutorials);
    delete process.env.KG_ONDEMAND_DRAIN_BATCH;
    delete process.env.KG_ONDEMAND_TUTORIALS_PER_REQ;
    delete process.env.KG_ONDEMAND_MAX_ATTEMPTS;
    _resetSettingsCache();
  });

  it('skips with reason=kg-disabled when master flag is off', async () => {
    await setFlags({ enabled: false, onDemand: true });
    const summary = await runOnDemandDrain({});
    expect(summary.reason).toBe('kg-disabled');
    expect(summary.processed).toBe(0);
  });

  it('skips with reason=ondemand-disabled when only the on-demand flag is off', async () => {
    await setFlags({ enabled: true, onDemand: false });
    const summary = await runOnDemandDrain({});
    expect(summary.reason).toBe('ondemand-disabled');
  });

  it('happy path: drains PENDING rows and marks DONE', async () => {
    await setFlags();
    await seedPending([{ query: 'q1' }, { query: 'q2' }]);

    const embed = makeEmbedMock();
    const rankTutorials = vi.fn(async () => [
      { tutorialId: 'tid-1', slug: 't1', title: 'T1', score: 0.9 },
    ]);
    const extractOne = vi.fn(async () => ({
      teaches: [{ slug: 'foo', name: 'Foo', confidence: 0.9 }],
      tokenUsage: { prompt: 100, completion: 50 },
      warnings: [],
    }));

    const summary = await runOnDemandDrain({
      embed, rankTutorials, extractOne,
      persistExtraction: vi.fn(async () => ({ created: 1, merged: 0 })),
    });

    expect(summary.processed).toBe(2);
    expect(summary.failed).toBe(0);
    expect(extractOne).toHaveBeenCalledTimes(2);
    const { KgOnDemandRequests } = cds.entities(NS);
    const rows = await SELECT.from(KgOnDemandRequests).columns('status', 'attempts', 'tutorialsExtracted');
    expect(rows.every(r => r.status === 'DONE')).toBe(true);
    expect(rows.every(r => r.attempts === 1)).toBe(true);
  });

  it('extraction throws once → row goes back to PENDING with attempts=1', async () => {
    await setFlags();
    await seedPending([{ query: 'q1' }]);

    let call = 0;
    const embed = makeEmbedMock();
    const rankTutorials = vi.fn(async () => [{ tutorialId: 'tid-1', slug: 't1', title: 'T1', score: 0.9 }]);
    const extractOne = vi.fn(async () => {
      call++;
      if (call === 1) throw new Error('LLM boom');
      return { teaches: [], tokenUsage: {}, warnings: [] };
    });

    const summary = await runOnDemandDrain({
      embed, rankTutorials, extractOne,
      persistExtraction: vi.fn(async () => ({ created: 0, merged: 0 })),
    });

    expect(summary.processed).toBe(0);
    expect(summary.failed).toBe(0);
    const { KgOnDemandRequests } = cds.entities(NS);
    const [row] = await SELECT.from(KgOnDemandRequests).columns('status', 'attempts', 'lastError');
    expect(row.status).toBe('PENDING');
    expect(row.attempts).toBe(1);
    expect(row.lastError).toMatch(/LLM boom/);
  });

  it('extraction throws N times → row lands in FAILED', async () => {
    await setFlags();
    process.env.KG_ONDEMAND_MAX_ATTEMPTS = '2';
    await seedPending([{ query: 'q1' }]);

    const embed = makeEmbedMock();
    const rankTutorials = vi.fn(async () => [{ tutorialId: 'tid-1', slug: 't1', title: 'T1', score: 0.9 }]);
    const extractOne = vi.fn(async () => { throw new Error('always fails'); });

    await runOnDemandDrain({
      embed, rankTutorials, extractOne,
      persistExtraction: vi.fn(async () => ({ created: 0, merged: 0 })),
    });
    // second tick
    const summary = await runOnDemandDrain({
      embed, rankTutorials, extractOne,
      persistExtraction: vi.fn(async () => ({ created: 0, merged: 0 })),
    });

    expect(summary.failed).toBe(1);
    const { KgOnDemandRequests } = cds.entities(NS);
    const [row] = await SELECT.from(KgOnDemandRequests).columns('status', 'attempts');
    expect(row.status).toBe('FAILED');
    expect(row.attempts).toBe(2);
  });

  it('empty top-K → row DONE with tutorialsExtracted=0, no LLM calls', async () => {
    await setFlags();
    await seedPending([{ query: 'q1' }]);

    const embed = makeEmbedMock();
    const rankTutorials = vi.fn(async () => []);
    const extractOne = vi.fn();

    const summary = await runOnDemandDrain({
      embed, rankTutorials, extractOne,
      persistExtraction: vi.fn(async () => ({ created: 0, merged: 0 })),
    });

    expect(summary.processed).toBe(1);
    expect(extractOne).not.toHaveBeenCalled();
    const { KgOnDemandRequests } = cds.entities(NS);
    const [row] = await SELECT.from(KgOnDemandRequests).columns('status', 'tutorialsExtracted');
    expect(row.status).toBe('DONE');
    expect(row.tutorialsExtracted).toBe(0);
  });

  it('DRAIN_BATCH bounds per-tick work', async () => {
    await setFlags();
    process.env.KG_ONDEMAND_DRAIN_BATCH = '2';
    await seedPending([{ query: 'q1' }, { query: 'q2' }, { query: 'q3' }, { query: 'q4' }, { query: 'q5' }]);

    const embed = makeEmbedMock();
    const rankTutorials = vi.fn(async () => []);
    const extractOne = vi.fn();

    const summary = await runOnDemandDrain({
      embed, rankTutorials, extractOne,
      persistExtraction: vi.fn(async () => ({ created: 0, merged: 0 })),
    });

    expect(summary.processed).toBe(2);
    const { KgOnDemandRequests } = cds.entities(NS);
    const rows = await SELECT.from(KgOnDemandRequests).columns('status');
    expect(rows.filter(r => r.status === 'DONE')).toHaveLength(2);
    expect(rows.filter(r => r.status === 'PENDING')).toHaveLength(3);
  });

  it('records latencyMs on FAILED path', async () => {
    await setFlags();
    process.env.KG_ONDEMAND_MAX_ATTEMPTS = '1';
    await seedPending([{ query: 'q1' }]);

    const embed = makeEmbedMock();
    const rankTutorials = vi.fn(async () => [{ tutorialId: 'tid-1', slug: 't1', title: 'T1', score: 0.9 }]);
    const extractOne = vi.fn(async () => { throw new Error('boom'); });

    await runOnDemandDrain({
      embed, rankTutorials, extractOne,
      persistExtraction: vi.fn(async () => ({ created: 0, merged: 0 })),
    });

    const { KgOnDemandRequests } = cds.entities(NS);
    const [row] = await SELECT.from(KgOnDemandRequests).columns('status', 'latencyMs');
    expect(row.status).toBe('FAILED');
    expect(row.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('finally-recovery flips RUNNING back to PENDING if terminal UPDATE fails', async () => {
    await setFlags();
    await seedPending([{ query: 'q1' }]);

    const embed = makeEmbedMock();
    const rankTutorials = vi.fn(async () => [{ tutorialId: 'tid-1', slug: 't1', title: 'T1', score: 0.9 }]);
    const extractOne = vi.fn(async () => ({
      teaches: [{ slug: 'foo', name: 'Foo', confidence: 0.9 }],
      tokenUsage: { prompt: 100, completion: 50 },
      warnings: [],
    }));
    // Break the persist step so the DONE UPDATE never runs — the whole body
    // throws after RUNNING has been set.
    const persistExtraction = vi.fn(async () => { throw new Error('persist boom'); });

    await runOnDemandDrain({ embed, rankTutorials, extractOne, persistExtraction });

    const { KgOnDemandRequests } = cds.entities(NS);
    const [row] = await SELECT.from(KgOnDemandRequests).columns('status', 'lastError');
    // The row should NOT be stuck in RUNNING. Either PENDING (retry) or FAILED (max attempts).
    // With MAX_ATTEMPTS default 3 and attempts=1, expect PENDING.
    expect(row.status).toBe('PENDING');
    expect(row.lastError).toMatch(/persist boom/);
  });
});

describe('on-demand link-only (#1115)', () => {
  beforeAll(async () => {
    // CDS may already be deployed from the sibling describe; deploy is idempotent.
    await cds.deploy(cds.env.roots).to('sqlite::memory:');
  });

  beforeEach(async () => {
    const { KgOnDemandRequests, Tutorials, TutorialEmbedding, Concepts, TutorialConceptLinks } = cds.entities(NS);
    await DELETE.from(TutorialConceptLinks);
    await DELETE.from(KgOnDemandRequests);
    await DELETE.from(TutorialEmbedding);
    await DELETE.from(Concepts);
    await DELETE.from(Tutorials);
    delete process.env.KG_ONDEMAND_DRAIN_BATCH;
    delete process.env.KG_ONDEMAND_TUTORIALS_PER_REQ;
    delete process.env.KG_ONDEMAND_MAX_ATTEMPTS;
    _resetSettingsCache();
  });

  it('links to an existing concept but never mints a new one', async () => {
    const { Concepts, Tutorials, TutorialConceptLinks } = cds.entities(NS);
    await setFlags({ enabled: true, onDemand: true });

    // One existing ACTIVE concept the extraction will hit by exact slug.
    await INSERT.into(Concepts).entries({
      ID: 'e0000000-0000-0000-0000-000000000001', slug: 'existing-concept', name: 'Existing',
      status: 'ACTIVE', embedding: Buffer.alloc(1536 * 4),
    });
    await INSERT.into(Tutorials).entries({
      ID: 't0000000-0000-0000-0000-00000000000a', slug: 'ondemand-tut', title: 'OD Tut', status: 'ACTIVE',
    });
    await seedPending([{ query: 'anything' }]);

    // rankTutorials → our one tutorial. extractOne → one existing slug (exact)
    // + one novel slug (would-mint) both above 0.7.
    const rankTutorials = async () => ([{ tutorialId: 't0000000-0000-0000-0000-00000000000a', slug: 'ondemand-tut', title: 'OD Tut', score: 0.9 }]);
    const extractOne = async () => ({
      teaches: [
        { slug: 'existing-concept', name: 'Existing', confidence: 0.9 },
        { slug: 'brand-new-concept', name: 'Brand New', confidence: 0.9 },
      ],
      extends: null, prerequisites: [], warnings: [], tokenUsage: { prompt: 0, completion: 0 },
    });
    const embed = makeEmbedMock();

    const result = await runOnDemandDrain({ embed, rankTutorials, extractOne });

    // No new concept minted — count stays 1.
    const concepts = await SELECT.from(Concepts);
    expect(concepts.length).toBe(1);
    // Link to the existing concept written.
    const links = await SELECT.from(TutorialConceptLinks).where({ concept_ID: 'e0000000-0000-0000-0000-000000000001' });
    expect(links.length).toBe(1);
    expect(result.mintsSkipped).toBeGreaterThanOrEqual(1);
  });

  it('drops a resolved link below the 0.7 on-demand floor', async () => {
    const { Concepts, Tutorials, TutorialConceptLinks } = cds.entities(NS);
    await setFlags({ enabled: true, onDemand: true });
    await INSERT.into(Concepts).entries({
      ID: 'e0000000-0000-0000-0000-000000000002', slug: 'low-conf-concept', name: 'Low', status: 'ACTIVE', embedding: Buffer.alloc(1536 * 4),
    });
    await INSERT.into(Tutorials).entries({
      ID: 't0000000-0000-0000-0000-00000000000b', slug: 'lc-tut', title: 'LC', status: 'ACTIVE',
    });
    await seedPending([{ query: 'anything' }]);
    const rankTutorials = async () => ([{ tutorialId: 't0000000-0000-0000-0000-00000000000b', slug: 'lc-tut', title: 'LC', score: 0.9 }]);
    const extractOne = async () => ({
      teaches: [{ slug: 'low-conf-concept', name: 'Low', confidence: 0.65 }],
      extends: null, prerequisites: [], warnings: [], tokenUsage: { prompt: 0, completion: 0 },
    });
    await runOnDemandDrain({ embed: makeEmbedMock(), rankTutorials, extractOne });
    const links = await SELECT.from(TutorialConceptLinks);
    expect(links.length).toBe(0);
  });
});
