// test/unit/srv/fetch-devtoberfest-sessions-job.test.js
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';

let runFetchDevtoberfestSessions;

// The job double-gates on the KG master switch + KG_DEVTOBERFEST_SESSIONS_ENABLED.
// We seed KnowledgeGraphSettings.enabled=true and inject flagEnabled:()=>true.
async function enableKg() {
  const { KnowledgeGraphSettings } = cds.entities('com.sap.developers.ims');
  await DELETE.from(KnowledgeGraphSettings);
  await INSERT.into(KnowledgeGraphSettings).entries({ enabled: true });
  globalThis.__kgSettingsCacheDirty__ = true;
}

const baseOpts = () => ({
  flagEnabled: () => true,
  extractFn: async () => ({ concepts: [], promptTokens: 0, completionTokens: 0 }),
  // Polymorphic embed stub: the job calls embed(description) → bare vector;
  // resolveConceptCandidates calls embed([name]) → array-of-vectors. A
  // non-zero component keeps the vector truthy through the merge/mint path.
  embed: async (input) => {
    const v = new Float32Array(1536); v[0] = 0.1;
    return Array.isArray(input) ? input.map(() => v) : v;
  },
});

beforeAll(async () => {
  process.env.VITEST = 'true';
  await cds.deploy([
    path.join(process.cwd(), 'db'),
    path.join(process.cwd(), 'srv'),
  ]).to('sqlite::memory:');
  ({ runFetchDevtoberfestSessions } = await import('../../../srv/jobs/fetch-devtoberfest-sessions-job.js'));
});

afterAll(async () => {
  await cds.disconnect();
});

beforeEach(async () => {
  const { Concepts } = cds.entities('com.sap.developers.ims');
  const { DevtoberfestSessions, DevtoberfestSessionConceptLinks } = cds.entities('com.sap.developers.ims.external');
  await DELETE.from(DevtoberfestSessionConceptLinks);
  await DELETE.from(DevtoberfestSessions);
  await DELETE.from(Concepts);
  await enableKg();
});

const oneSession = (over = {}) => ({
  id: 's-1', sessionCode: 'DEV101', title: 'Build AI services using SAP CAP',
  abstract: 'Hands-on session covering CAP and the SAP Generative AI Hub.',
  scheduledStart: new Date(), youtubeUrl: 'https://youtu.be/abc', url: 'https://youtu.be/abc',
  speakerNames: 'Ada Lovelace', activityTaskSlug: 'cap-genai-hub', activityTaskType: 'TUTORIAL',
  ...over,
});

describe('runFetchDevtoberfestSessions', () => {
  it('no-ops when the feature flag is off', async () => {
    const summary = await runFetchDevtoberfestSessions(null, {
      ...baseOpts(), flagEnabled: () => false,
      fetchSessions: async () => [oneSession()],
    });
    expect(summary.skippedDisabled).toBe(true);
    expect(summary.upserted).toBe(0);
  });

  it('no-ops when the KG master switch is off', async () => {
    const { KnowledgeGraphSettings } = cds.entities('com.sap.developers.ims');
    await DELETE.from(KnowledgeGraphSettings);
    await INSERT.into(KnowledgeGraphSettings).entries({ enabled: false });
    globalThis.__kgSettingsCacheDirty__ = true;
    const summary = await runFetchDevtoberfestSessions(null, {
      ...baseOpts(), fetchSessions: async () => [oneSession()],
    });
    expect(summary.skippedDisabled).toBe(true);
  });

  it('fail-closed when the facade read throws (Leg B not deployed)', async () => {
    const summary = await runFetchDevtoberfestSessions(null, {
      ...baseOpts(),
      fetchSessions: async () => { throw new Error('synonym ACTIVITY_SESSION_V1 not found'); },
    });
    expect(summary.errors).toBeGreaterThanOrEqual(1);
    expect(summary.upserted).toBe(0);
  });

  it('upserts one row per session with a dtf-<sessionCode> slug', async () => {
    const { DevtoberfestSessions } = cds.entities('com.sap.developers.ims.external');
    await runFetchDevtoberfestSessions(null, {
      ...baseOpts(), budgetOverride: 0,   // extraction skipped; upsert still runs
      fetchSessions: async () => [oneSession()],
    });
    const row = await SELECT.one.from(DevtoberfestSessions).columns('slug', 'title', 'activityTaskSlug').where({ sourceId: 's-1' });
    expect(row?.slug).toBe('dtf-dev101');
    expect(row?.activityTaskSlug).toBe('cap-genai-hub');
  });

  it('counts the tutorial bridge for TUTORIAL-typed activities', async () => {
    const summary = await runFetchDevtoberfestSessions(null, {
      ...baseOpts(), budgetOverride: 0,
      fetchSessions: async () => [oneSession(), oneSession({ id: 's-2', sessionCode: 'DEV102', activityTaskType: 'PUZZLE' })],
    });
    expect(summary.bridgeCount).toBe(1);
  });

  it('synthesizes description when the abstract is empty', async () => {
    const { DevtoberfestSessions } = cds.entities('com.sap.developers.ims.external');
    await runFetchDevtoberfestSessions(null, {
      ...baseOpts(), budgetOverride: 0,
      fetchSessions: async () => [oneSession({ id: 's-syn', sessionCode: 'DEV900', abstract: '' })],
    });
    const row = await SELECT.one.from(DevtoberfestSessions).columns('description').where({ sourceId: 's-syn' });
    expect(row.description).toContain('presented by Ada Lovelace');
  });

  it('#708 crash-safety: skips extract when contentHash === lastExtractedHash', async () => {
    const { DevtoberfestSessions } = cds.entities('com.sap.developers.ims.external');
    await INSERT.into(DevtoberfestSessions).entries({
      slug: 'dtf-dev101', title: 'Build AI services using SAP CAP', description: 'x',
      url: 'https://x', sourceId: 's-1', sessionCode: 'DEV101',
      contentHash: 'same', lastExtractedHash: 'same', lastSeenAt: new Date(),
    });
    let extractCalls = 0;
    await runFetchDevtoberfestSessions(null, {
      ...baseOpts(), budgetOverride: 100,
      fetchSessions: async () => [oneSession()],
      extractFn: async () => { extractCalls++; return { concepts: [], promptTokens: 0, completionTokens: 0 }; },
      hashOverride: () => 'same',
    });
    expect(extractCalls).toBe(0);
  });

  it('respects the budget cap on extractions', async () => {
    let extractCalls = 0;
    await runFetchDevtoberfestSessions(null, {
      ...baseOpts(), budgetOverride: 2,
      fetchSessions: async () => Array.from({ length: 5 }, (_, i) => oneSession({ id: `s-b${i}`, sessionCode: `DEV${i}` })),
      extractFn: async () => { extractCalls++; return { concepts: [], promptTokens: 0, completionTokens: 0 }; },
    });
    expect(extractCalls).toBeLessThanOrEqual(2);
  });

  it('writes presents concept links for extracted concepts', async () => {
    const { DevtoberfestSessions, DevtoberfestSessionConceptLinks } = cds.entities('com.sap.developers.ims.external');
    const { Concepts } = cds.entities('com.sap.developers.ims');
    await runFetchDevtoberfestSessions(null, {
      ...baseOpts(), budgetOverride: 100,
      fetchSessions: async () => [oneSession()],
      extractFn: async () => ({
        concepts: [{ slug: 'sap-cap', name: 'SAP CAP', description: 'CAP', confidence: 0.95 }],
        promptTokens: 10, completionTokens: 5,
      }),
    });
    const ses = await SELECT.one.from(DevtoberfestSessions).columns('ID').where({ sourceId: 's-1' });
    const links = await SELECT.from(DevtoberfestSessionConceptLinks).where({ session_ID: ses.ID });
    expect(links.length).toBe(1);
    expect(links[0].predicate).toBe('presents');
    const concept = await SELECT.one.from(Concepts).where({ slug: 'sap-cap' });
    expect(concept).toBeTruthy();
  });
});
