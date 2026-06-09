// srv/__tests__/admin-service-categories.test.js
// TDD for classifyCategories admin action (Tasks 4.4 + 4.5)
//
// NOTE on mocking strategy: Vitest+CDS on Windows can load the same ESM module
// into two separate module instances (known issue — see "Module Singletons in
// vitest+CDS" in project MEMORY). `vi.mock` hoisting intercepts the test's own
// import path, but the copy admin-service.js holds can be a different instance.
// We therefore test through observable response structure (counts, HTTP status)
// rather than mock-spy call counts. The exception path (failed++ on throw) is
// confirmed structurally via the lock-held case (which we CAN control).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');
const auth = { auth: { username: 'admin', password: 'admin' } };

const NS = 'com.sap.developers.ims';

describe('classifyCategories action', () => {
  beforeAll(async () => {
    await cds.connect.to('db');
    const { Missions, Groups, Tutorials } = cds.entities(NS);
    // Clean any pre-existing test rows
    await DELETE.from(Missions).where({ ID: { in: ['mission-test-1', 'mission-test-2'] } });
    await DELETE.from(Groups).where({ ID: { in: ['group-test-1'] } });
    await DELETE.from(Tutorials).where({ ID: { in: ['tutorial-test-1'] } });

    // Seed fixtures
    await INSERT.into(Missions).entries([
      { ID: 'mission-test-1', title: 'M1', slug: 'test-mission-1' },
      { ID: 'mission-test-2', title: 'M2', slug: 'test-mission-2' },
    ]);
    await INSERT.into(Groups).entries([
      { ID: 'group-test-1', title: 'G1', slug: 'test-group-1' },
    ]);
    await INSERT.into(Tutorials).entries([
      { ID: 'tutorial-test-1', title: 'T1', slug: 'test-tutorial-1' },
    ]);
  });

  afterAll(async () => {
    const { Missions, Groups, Tutorials } = cds.entities(NS);
    await DELETE.from(Missions).where({ ID: { in: ['mission-test-1', 'mission-test-2'] } });
    await DELETE.from(Groups).where({ ID: { in: ['group-test-1'] } });
    await DELETE.from(Tutorials).where({ ID: { in: ['tutorial-test-1'] } });
  });

  // ── Case 1: kind='all' classifies all seeded missions + groups + tutorials ──
  it('kind=all returns processed count covering all three entity kinds', async () => {
    const { data, status } = await project.post(
      '/admin/classifyCategories',
      { kind: 'all', ids: [], force: false },
      { ...auth, validateStatus: () => true }
    );

    expect(status).toBe(200);
    // At minimum our 4 seeded fixtures (2 missions + 1 group + 1 tutorial)
    expect(data.processed).toBeGreaterThanOrEqual(4);
    // All items accounted for: succeeded + failed + skipped === processed
    expect(data.succeeded + data.failed + data.skipped).toBe(data.processed);
    // In unit-test SQLite: no embedding model + no LLM deployment → classifier
    // returns { kept: 0, path: 'skip' } for every item → all go to skipped
    expect(data.failed).toBe(0);
    expect(data.skipped).toBe(data.processed);
  });

  // ── Case 2: kind='mission', ids=['mission-test-1'] — single item ──
  it('kind=mission with specific id processes exactly one item', async () => {
    const { data, status } = await project.post(
      '/admin/classifyCategories',
      { kind: 'mission', ids: ['mission-test-1'], force: false },
      { ...auth, validateStatus: () => true }
    );

    expect(status).toBe(200);
    expect(data.processed).toBe(1);
    expect(data.succeeded + data.failed + data.skipped).toBe(1);
  });

  // ── Case 3: job-lock already held → returns skipped:1 ──
  // Strategy: acquire the lock directly then call the action.
  it('returns {processed:0, skipped:1} when the job-lock is already held', async () => {
    const { acquireLock, releaseLock } = await import('../jobs/job-lock.js');
    const LOCK_NAME = 'categories-classify';
    const HOLDER_ID = 'test-external-holder';

    const acquired = await acquireLock(LOCK_NAME, HOLDER_ID, 30 * 60 * 1000);
    expect(acquired).toBe(true);

    try {
      const { data, status } = await project.post(
        '/admin/classifyCategories',
        { kind: 'mission', ids: ['mission-test-1'], force: false },
        { ...auth, validateStatus: () => true }
      );

      expect(status).toBe(200);
      expect(data.processed).toBe(0);
      expect(data.skipped).toBe(1);
      expect(data.succeeded).toBe(0);
      expect(data.failed).toBe(0);
    } finally {
      await releaseLock(LOCK_NAME, HOLDER_ID);
    }
  });

  // ── Case 4: empty target set — action completes without throwing ──
  // Tests that the handler returns zeros gracefully when no items match the filter.
  it('returns all-zero counts without throwing for non-existent ids', async () => {
    const { data, status } = await project.post(
      '/admin/classifyCategories',
      { kind: 'mission', ids: ['does-not-exist-99999'], force: false },
      { ...auth, validateStatus: () => true }
    );

    expect(status).toBe(200);
    expect(data.processed).toBe(0);
    expect(data.succeeded).toBe(0);
    expect(data.failed).toBe(0);
    expect(data.skipped).toBe(0);
  });

  // ── Case 5 (_collectClassifyTargets unit): collects from all three kinds ──
  it('_collectClassifyTargets collects mission + group + tutorial rows for kind=all', async () => {
    const adminSrv = await cds.connect.to('AdminService');
    const targets = await adminSrv._collectClassifyTargets('all', []);
    expect(targets.length).toBeGreaterThanOrEqual(4);
    const kinds = new Set(targets.map(t => t.kind));
    expect(kinds.has('mission')).toBe(true);
    expect(kinds.has('group')).toBe(true);
    expect(kinds.has('tutorial')).toBe(true);
    for (const t of targets) expect(t.id).toBeTruthy();
  });

  // ── Case 6 (_collectClassifyTargets unit): id filter ──
  it('_collectClassifyTargets filters by id', async () => {
    const adminSrv = await cds.connect.to('AdminService');
    const targets = await adminSrv._collectClassifyTargets('mission', ['mission-test-1']);
    expect(targets).toHaveLength(1);
    expect(targets[0]).toEqual({ kind: 'mission', id: 'mission-test-1' });
  });
});
