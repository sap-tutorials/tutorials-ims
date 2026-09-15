// test/unit/teched-jobs.test.js
// E2E of the TechEd cron jobs against in-memory SQLite: the fetch job's
// fetch+upsert+delta core, the #708 crash-safety skip on a second run, the KG
// enrichment double-gate, and the metadata-only refresh job.
import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import cds from '@sap/cds';
import { fetchAllTechEdSessions } from '../../srv/lib/teched/rainfocus-fetcher.js';
import { runFetchTechEdSessions } from '../../srv/jobs/fetch-teched-sessions-job.js';
import { runRefreshTechEdSessions } from '../../srv/jobs/refresh-teched-sessions-job.js';
import { _setLookupForTests } from '../../srv/lib/safe-fetch.js';

// Fetcher routes through safeFetch — stub DNS to a public IP so tests stay
// hermetic and the SSRF guard passes.
beforeAll(() => _setLookupForTests(async () => [{ address: '93.184.216.34', family: 4 }]));
afterAll(() => _setLookupForTests(null));

const NAMESPACE_EXT = 'com.sap.developers.ims.external';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { test } = cds;
test.in(__dirname, '..', '..');
test('serve', 'all', '--in-memory');

// Real (trimmed) RainFocus capture, both venues.
const FIXTURE = JSON.parse(
  readFileSync(path.join(__dirname, '..', 'fixtures', 'teched', 'rainfocus-search.json'), 'utf8'),
);
const VENUES = { BERLIN: { widgetId: 'w-b', profileId: 'p-b' }, VIRTUAL: { widgetId: 'w-v', profileId: 'p-v' } };
const W2V = { 'w-v': 'VIRTUAL', 'w-b': 'BERLIN' };
const resp = (json) => ({ ok: true, status: 200, headers: { get: () => null },
  arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(json)).buffer });
const fakeFetch = async (_u, init) => {
  const v = W2V[init.headers.rfwidgetid];
  const from = Number(new URLSearchParams(init.body).get('from'));
  if (from > 0) return resp({ responseCode: '0', totalSearchItems: FIXTURE[v].totalSearchItems, sectionList: [{ items: [] }] });
  return resp(FIXTURE[v]);
};
// fetchAll seam that drives the REAL fetcher over the real fixture.
const fetchAllSeam = (o = {}) =>
  fetchAllTechEdSessions({ ...o, _fetch: fakeFetch, venues: VENUES, now: Date.parse('2026-10-01T00:00:00Z') });

function entities() {
  const { TechEdSessions, TechEdSpeakers, TechEdTracks, TechEdSessionSpeakers, TechEdSessionConceptLinks } =
    cds.entities(NAMESPACE_EXT);
  return { TechEdSessions, TechEdSpeakers, TechEdTracks, TechEdSessionSpeakers, TechEdSessionConceptLinks };
}
async function clean() {
  const e = entities();
  await DELETE.from(e.TechEdSessionConceptLinks);
  await DELETE.from(e.TechEdSessionSpeakers);
  await DELETE.from(e.TechEdSessions);
  await DELETE.from(e.TechEdSpeakers);
  await DELETE.from(e.TechEdTracks);
}

describe('runFetchTechEdSessions', () => {
  beforeEach(async () => { await cds.connect.to('db'); await clean(); });

  it('core upsert inserts sessions/speakers/tracks/junction (KG gate OFF)', async () => {
    const s = await runFetchTechEdSessions('log-1', {
      fetchAllTechEdSessions: fetchAllSeam,
      flagEnabled: () => false,
    });
    expect(s.fetched).toBe(6);
    expect(s.sessionsUpserted).toBe(6);
    expect(s.speakersUpserted).toBe(10);
    expect(s.tracksUpserted).toBe(4);
    expect(s.linksReconciled).toBe(10);
    expect(s.kgEnabled).toBe(false);
    expect(s.conceptLinksWritten).toBe(0);

    const e = entities();
    expect(await SELECT.from(e.TechEdSessions)).toHaveLength(6);
    expect(await SELECT.from(e.TechEdSessionSpeakers)).toHaveLength(10);
    // core sets contentHash; enrichment (gated OFF) leaves lastExtractedHash null
    const rows = await SELECT.from(e.TechEdSessions).columns('contentHash', 'lastExtractedHash');
    expect(rows.every((r) => r.contentHash && r.lastExtractedHash == null)).toBe(true);
  });

  it('second run skips unchanged rows (delta / #708 crash-safety at core)', async () => {
    await runFetchTechEdSessions('log-1', { fetchAllTechEdSessions: fetchAllSeam, flagEnabled: () => false });
    const s2 = await runFetchTechEdSessions('log-2', { fetchAllTechEdSessions: fetchAllSeam, flagEnabled: () => false });
    expect(s2.sessionsSkipped).toBe(6);
    expect(s2.sessionsUpserted).toBe(0);
    expect(s2.linksReconciled).toBe(0);
    expect(await SELECT.from(entities().TechEdSessions)).toHaveLength(6);
  });

  it('KG enrichment stays inert when the master switch is off', async () => {
    const s = await runFetchTechEdSessions('log-1', {
      fetchAllTechEdSessions: fetchAllSeam,
      flagEnabled: () => true,                                   // flag on…
      resolveKnowledgeGraphSettings: async () => ({ enabled: false }), // …but master off
    });
    expect(s.kgEnabled).toBe(false);
    expect(s.conceptLinksWritten).toBe(0);
    expect(s.sessionsUpserted).toBe(6); // core still ran
  });

  it('enrichment loop runs its SELECTs + marks lastExtractedHash when double-gated ON (empty extract)', async () => {
    // KG on, but extractFn yields no concepts → exercises the enrichment
    // candidates SELECT (incl. track.name path), the speaker-names junction
    // query, embed(), and the lastExtractedHash write — WITHOUT the concept
    // mint/outbox machinery. Validates findings #3/#4 wiring end-to-end.
    const s = await runFetchTechEdSessions('log-1', {
      fetchAllTechEdSessions: fetchAllSeam,
      flagEnabled: () => true,
      resolveKnowledgeGraphSettings: async () => ({ enabled: true, mergeSimThresholdExtract: 0.85 }),
      embed: async (inputs) => (Array.isArray(inputs) ? inputs.map(() => new Array(8).fill(0.1)) : []),
      extractFn: async () => ({ concepts: [], promptTokens: 3, completionTokens: 4 }),
    });
    expect(s.kgEnabled).toBe(true);
    expect(s.enrichmentCandidates).toBe(6);
    expect(s.enriched).toBe(6);
    expect(s.conceptLinksWritten).toBe(0);

    // #708: every session now marked enriched-current (lastExtractedHash===contentHash)
    const rows = await SELECT.from(entities().TechEdSessions).columns('contentHash', 'lastExtractedHash');
    expect(rows.every((r) => r.lastExtractedHash === r.contentHash)).toBe(true);

    // second run enriches nothing (all lastExtractedHash===contentHash)
    const s2 = await runFetchTechEdSessions('log-2', {
      fetchAllTechEdSessions: fetchAllSeam,
      flagEnabled: () => true,
      resolveKnowledgeGraphSettings: async () => ({ enabled: true, mergeSimThresholdExtract: 0.85 }),
      embed: async (inputs) => (Array.isArray(inputs) ? inputs.map(() => new Array(8).fill(0.1)) : []),
      extractFn: async () => ({ concepts: [], promptTokens: 0, completionTokens: 0 }),
    });
    expect(s2.enrichmentCandidates).toBe(0);
    expect(s2.enriched).toBe(0);
  });
});

describe('runRefreshTechEdSessions', () => {
  beforeEach(async () => { await cds.connect.to('db'); await clean(); });

  it('metadata-only upsert leaves contentHash / lastExtractedHash untouched', async () => {
    const s = await runRefreshTechEdSessions('log-1', { fetchAllTechEdSessions: fetchAllSeam });
    expect(s.fetched).toBe(6);
    expect(s.sessionsUpserted).toBe(6);
    expect(s.speakersUpserted).toBe(10);
    expect(s.tracksUpserted).toBe(4);
    expect(s.linksReconciled).toBe(10);

    const e = entities();
    const rows = await SELECT.from(e.TechEdSessions).columns('title', 'contentHash', 'lastExtractedHash');
    expect(rows).toHaveLength(6);
    // refresh must NOT own contentHash/lastExtractedHash — both stay null
    expect(rows.every((r) => r.contentHash == null && r.lastExtractedHash == null)).toBe(true);
    expect(rows.every((r) => !!r.title)).toBe(true);
  });
});
