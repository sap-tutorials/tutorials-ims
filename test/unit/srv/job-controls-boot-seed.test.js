// test/unit/srv/job-controls-boot-seed.test.js
//
// Tests for the preSeedJobLastRun() chassis: one JobLastRun row per
// registered job inserted at end of registerJobs(); idempotent rerun.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';

import {
  registerJob,
  preSeedJobLastRun,
  _resetJobRegistry,
} from '../../../srv/jobs/scheduler.js';

describe('preSeedJobLastRun', () => {
  beforeAll(async () => {
    await cds.deploy([
      path.join(process.cwd(), 'db'),
      path.join(process.cwd(), 'srv'),
    ]).to('sqlite::memory:');
  });

  afterAll(async () => {
    await cds.disconnect();
  });

  beforeEach(async () => {
    _resetJobRegistry();
    const { JobLastRun } = cds.entities('com.sap.developers.ims');
    await DELETE.from(JobLastRun);
  });

  it('pre-seed inserts one row per registered job on first call (empty table)', async () => {
    registerJob({ jobName: 'seed-a', schedule: '0 0 1 1 *', ttlMs: 1000, description: 'x', fn: async () => 'ok' });
    registerJob({ jobName: 'seed-b', schedule: '0 0 1 1 *', ttlMs: 1000, description: 'x', fn: async () => 'ok' });

    await preSeedJobLastRun();

    const { JobLastRun } = cds.entities('com.sap.developers.ims');
    const rows = await SELECT.from(JobLastRun);
    expect(rows.length).toBe(2);
    expect(rows.map(r => r.jobName).sort()).toEqual(['seed-a', 'seed-b']);
    // Fresh rows have null timestamps.
    expect(rows[0].lastSuccessAt).toBeFalsy();
    expect(rows[0].lastErrorAt).toBeFalsy();
  });

  it('pre-seed is idempotent — rerun adds zero rows when all jobs already seeded', async () => {
    registerJob({ jobName: 'seed-c', schedule: '0 0 1 1 *', ttlMs: 1000, description: 'x', fn: async () => 'ok' });

    await preSeedJobLastRun();
    const { JobLastRun } = cds.entities('com.sap.developers.ims');
    const firstCount = (await SELECT.from(JobLastRun)).length;

    await preSeedJobLastRun();
    const secondCount = (await SELECT.from(JobLastRun)).length;

    expect(firstCount).toBe(1);
    expect(secondCount).toBe(1);
  });
});
