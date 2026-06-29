// test/unit/build-kg-stats.test.js
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

describe('GET /build/kg-stats', () => {
  beforeEach(async () => {
    const { Tutorials, Concepts, ConceptEdges, Missions, Groups } =
      cds.entities('com.sap.developers.ims');
    // Wipe everything the handler reads.
    await DELETE.from(ConceptEdges);
    await DELETE.from(Concepts);
    await DELETE.from(Tutorials);
    await DELETE.from(Missions);
    await DELETE.from(Groups);

    // Seed: 3 tutorials, 2 published concepts (1 draft excluded), 4 edges, 2 missions, 1 group.
    await INSERT.into(Tutorials).entries([
      { ID: '00000000-0000-0000-0000-000000000t01', slug: 'one',   title: 'One' },
      { ID: '00000000-0000-0000-0000-000000000t02', slug: 'two',   title: 'Two' },
      { ID: '00000000-0000-0000-0000-000000000t03', slug: 'three', title: 'Three' },
    ]);
    await INSERT.into(Concepts).entries([
      // Concepts.status is ACTIVE | MERGED | VETOED (per db/knowledge-graph.cds:28).
      // The public-published gate is `status='ACTIVE' AND publishedAt IS NOT NULL`.
      { ID: '00000000-0000-0000-0000-000000000c01', slug: 'cap',    name: 'CAP',    status: 'ACTIVE', publishedAt: '2026-06-28T03:17:42.000Z' },
      { ID: '00000000-0000-0000-0000-000000000c02', slug: 'sapui5', name: 'SAPUI5', status: 'ACTIVE', publishedAt: '2026-06-27T03:17:42.000Z' },
      { ID: '00000000-0000-0000-0000-000000000c03', slug: 'unpub',  name: 'Unpub',  status: 'ACTIVE', publishedAt: null }, // not yet published — excluded
      { ID: '00000000-0000-0000-0000-000000000c04', slug: 'merged', name: 'Merged', status: 'MERGED', publishedAt: '2026-06-28T03:17:42.000Z' }, // merged — excluded
    ]);
    await INSERT.into(ConceptEdges).entries([
      // ConceptEdges.predicate (per db/knowledge-graph.cds:77), status='ACTIVE' default.
      // extractedAt is on the edge (NOT on Concepts) — that's the source for MAX in the handler.
      { ID: '00000000-0000-0000-0000-000000000e01', source_ID: '00000000-0000-0000-0000-000000000c01', target_ID: '00000000-0000-0000-0000-000000000c02', predicate: 'relatedTo', status: 'ACTIVE', extractedAt: '2026-06-28T03:17:42.000Z' },
      { ID: '00000000-0000-0000-0000-000000000e02', source_ID: '00000000-0000-0000-0000-000000000c02', target_ID: '00000000-0000-0000-0000-000000000c01', predicate: 'requires',  status: 'ACTIVE', extractedAt: '2026-06-27T03:17:42.000Z' },
      { ID: '00000000-0000-0000-0000-000000000e03', source_ID: '00000000-0000-0000-0000-000000000c01', target_ID: '00000000-0000-0000-0000-000000000c01', predicate: 'teaches',   status: 'ACTIVE', extractedAt: '2026-06-26T03:17:42.000Z' },
      { ID: '00000000-0000-0000-0000-000000000e04', source_ID: '00000000-0000-0000-0000-000000000c02', target_ID: '00000000-0000-0000-0000-000000000c02', predicate: 'teaches',   status: 'VETOED', extractedAt: '2026-06-25T03:17:42.000Z' }, // vetoed — excluded
    ]);
    await INSERT.into(Missions).entries([
      // Missions extends TaskBase (db/schema.cds:21) — required field is `title`, not `name`.
      { ID: '00000000-0000-0000-0000-000000000m01', slug: 'm1', title: 'Mission 1', published: true, missionType: 'SEQUENTIAL' },
      { ID: '00000000-0000-0000-0000-000000000m02', slug: 'm2', title: 'Mission 2', published: true, missionType: 'SET' },
    ]);
    await INSERT.into(Groups).entries([
      // Groups also extends TaskBase — required field is `title`.
      { ID: '00000000-0000-0000-0000-000000000g01', slug: 'g1', title: 'Group 1' },
    ]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the expected JSON shape with correct counts', async () => {
    const { data, headers, status } = await project.axios.get('/build/kg-stats');
    expect(status).toBe(200);
    expect(data).toEqual({
      tutorials: 3,
      concepts: 2,          // ACTIVE + publishedAt NOT NULL (excludes 'unpub' AND 'merged')
      relationships: 3,     // ACTIVE only (excludes the VETOED edge)
      missionsAndGroups: 3, // 2 missions + 1 group
      lastExtractedAt: '2026-06-28T03:17:42.000Z', // MAX over ACTIVE ConceptEdges.extractedAt
      generatedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    expect(headers['cache-control']).toMatch(/public/);
    expect(headers['cache-control']).toMatch(/max-age=60/);
    expect(headers['cache-control']).toMatch(/stale-while-revalidate=300/);
  });

  it('serves the second call within 60s from cache (no DB hit)', async () => {
    const db = await cds.connect.to('db');
    const runSpy = vi.spyOn(db, 'run');
    // First call — populates cache.
    await project.axios.get('/build/kg-stats');
    const firstCallCount = runSpy.mock.calls.length;
    expect(firstCallCount).toBeGreaterThan(0);
    // Second call within 60s should be served from cache.
    await project.axios.get('/build/kg-stats');
    expect(runSpy.mock.calls.length).toBe(firstCallCount);
    runSpy.mockRestore();
  });

  it('refreshes the cache after the 60s TTL expires', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await project.axios.get('/build/kg-stats');
    vi.advanceTimersByTime(61_000);
    const db = await cds.connect.to('db');
    const runSpy = vi.spyOn(db, 'run');
    await project.axios.get('/build/kg-stats');
    expect(runSpy.mock.calls.length).toBeGreaterThan(0);
    runSpy.mockRestore();
  });

  it('returns the last-good payload with 200 if the DB throws after a successful prior call', async () => {
    // First call seeds the last-good payload.
    const ok = await project.axios.get('/build/kg-stats');
    expect(ok.status).toBe(200);
    const lastGood = ok.data;

    // Force a fresh fetch (advance past TTL) and break the DB.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.advanceTimersByTime(61_000);
    const db = await cds.connect.to('db');
    const runSpy = vi.spyOn(db, 'run').mockRejectedValue(new Error('boom'));

    const degraded = await project.axios.get('/build/kg-stats');
    expect(degraded.status).toBe(200);
    expect(degraded.data.tutorials).toBe(lastGood.tutorials);
    expect(degraded.data.concepts).toBe(lastGood.concepts);
    runSpy.mockRestore();
  });

  it('returns 503 if no last-good payload exists and the DB throws', async () => {
    const db = await cds.connect.to('db');
    const runSpy = vi.spyOn(db, 'run').mockRejectedValue(new Error('boom'));
    // axios validateStatus default rejects 5xx; we have to allow it.
    const res = await project.axios.get('/build/kg-stats', { validateStatus: () => true });
    expect(res.status).toBe(503);
    runSpy.mockRestore();
  });
});
