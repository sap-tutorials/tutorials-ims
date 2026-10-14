// Real-DB verification of the #2762 crash-loop backstop sentinel (in-memory SQLite).
// Exercises the DEFAULT recordRestart / wasRecentlyRestarted + loadCanaryRows
// paths against a real cds.deploy — NOT mocks — proving the CDS QL round-trips.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';
import path from 'node:path';

import {
  runStallCheckOnce,
  CANARY_JOBS,
  SELF_RESTART_MARKER,
  _DEFAULT_GRACE_MS,
  _DEFAULT_RESTART_COOLDOWN_MS,
} from '../../../../srv/lib/scheduler-boot-healthcheck.js';

describe('#2762 scheduler-boot-healthcheck — real JobLastRun persistence (SQLite)', () => {
  let JobLastRun;

  beforeAll(async () => {
    await cds.deploy([
      path.join(process.cwd(), 'db'),
      path.join(process.cwd(), 'srv'),
    ]).to('sqlite::memory:');
    ({ JobLastRun } = cds.entities('com.sap.developers.ims'));
  });

  afterAll(async () => { await cds.disconnect(); });

  it('first persistent stall writes the sentinel marker and exits; a second check within cooldown is suppressed', async () => {
    const now = () => new Date('2026-10-14T12:00:00Z');
    const staleTs = new Date('2026-10-14T11:30:00Z');
    // Seed both canaries stale via the real table.
    for (const jobName of CANARY_JOBS) {
      await UPSERT.into(JobLastRun).entries({ jobName });
      await UPDATE(JobLastRun).set({ lastSuccessAt: staleTs }).where({ jobName });
    }

    // 1st detection: no marker yet → records marker + exits.
    let exits = 0;
    const v1 = await runStallCheckOnce({
      loadRows: async () => cds.db.run(
        SELECT.from(JobLastRun).columns('jobName', 'lastSuccessAt').where({ jobName: { in: CANARY_JOBS } })
      ),
      raiseAlert: async () => {},
      exit: () => { exits++; },
      now, graceMs: _DEFAULT_GRACE_MS, cooldownMs: _DEFAULT_RESTART_COOLDOWN_MS,
      // use the REAL default wasRecentlyRestarted + recordRestart (not injected)
    });
    expect(v1.stalled).toBe(true);
    expect(exits).toBe(1);

    // The sentinel row must now exist with a timestamp.
    const marker = await SELECT.one.from(JobLastRun).where({ jobName: SELF_RESTART_MARKER });
    expect(marker).toBeTruthy();
    expect(marker.lastSuccessAt).toBeTruthy();

    // 2nd detection a few minutes later, still within cooldown → suppressed.
    const soon = () => new Date('2026-10-14T12:08:00Z');
    let exits2 = 0, alerts2 = 0;
    const v2 = await runStallCheckOnce({
      loadRows: async () => cds.db.run(
        SELECT.from(JobLastRun).columns('jobName', 'lastSuccessAt').where({ jobName: { in: CANARY_JOBS } })
      ),
      raiseAlert: async () => { alerts2++; },
      exit: () => { exits2++; },
      now: soon, graceMs: _DEFAULT_GRACE_MS, cooldownMs: _DEFAULT_RESTART_COOLDOWN_MS,
    });
    expect(v2.stalled).toBe(true);
    expect(alerts2).toBe(1);   // persistent-stall alert still fires
    expect(exits2).toBe(0);    // but NO second exit → crash-loop broken
  });
});
