// test/unit/pipeline-log-reconciler.test.js
//
// #1293: boot-time reconciler for orphaned scheduled-job PipelineLog rows.
//
// When the srv process dies mid-run (deploy restart, crash, CF app stop),
// runWithLock's finally block never executes, so its PipelineLog row stays
// stuck at STATUS='RUNNING' forever. The #1021 outbox-wedge fix cleans a
// DIFFERENT table (cds.outbox.Messages), not the PipelineLog row.
//
// reconcileOrphanedRunningJobs() runs once at boot and flips any
// SCHEDULED_JOB + RUNNING row older than a 60-min floor to FAILED. A row
// younger than the floor may be a legitimately in-flight job on another
// CF instance, so the age gate avoids racing genuine runs.
//
// forceCloseRunningPipelineLog(jobName) is the manual operator path
// (sibling to forceUnwedge). It closes RUNNING rows for one job with NO
// age gate — the operator has already decided the row is orphaned.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import cds from '@sap/cds';
import {
  reconcileOrphanedRunningJobs,
  forceCloseRunningPipelineLog,
  _RECONCILE_FLOOR_MS_FOR_TESTS,
} from '../../srv/lib/pipeline-log-reconciler.js';

const NS = 'com.sap.developers.ims';
const DB = './db/schema.cds';

let PipelineLog;

beforeEach(async () => {
  await cds.deploy(DB).to('sqlite::memory:');
  ({ PipelineLog } = cds.entities(NS));
  await DELETE.from(PipelineLog);
});

afterEach(async () => {
  if (cds.db) {
    try { await cds.disconnect(); } catch { /* best-effort */ }
  }
});

// Helper: insert a PipelineLog row with an explicit startedAt.
async function insertRow({ id, pipelineType, status, startedAt, jobName, finishedAt = null }) {
  await INSERT.into(PipelineLog).entries({
    ID: id,
    pipelineType,
    status,
    startedAt: startedAt instanceof Date ? startedAt.toISOString() : startedAt,
    finishedAt,
    initiator: 'system',
    metadata: jobName ? JSON.stringify({ jobName }) : null,
  });
}

const HOUR = 60 * 60 * 1000;

describe('reconcileOrphanedRunningJobs (#1293)', () => {
  it('closes a SCHEDULED_JOB RUNNING row older than the 60-min floor', async () => {
    const old = new Date(Date.now() - 2 * HOUR);
    await insertRow({
      id: 'aaaaaaaa-0000-0000-0000-000000000001',
      pipelineType: 'SCHEDULED_JOB',
      status: 'RUNNING',
      startedAt: old,
      jobName: 'fetch-learning-journeys',
    });

    const result = await reconcileOrphanedRunningJobs();

    expect(result.closed).toBe(1);
    const row = await SELECT.one.from(PipelineLog).where({ ID: 'aaaaaaaa-0000-0000-0000-000000000001' });
    expect(row.status).toBe('FAILED');
    expect(row.finishedAt).toBeTruthy();
    expect(row.errorDetails).toMatch(/interrupted by restart/i);
  });

  it('does NOT close a RUNNING row younger than the floor (genuine in-flight)', async () => {
    const recent = new Date(Date.now() - 5 * 60 * 1000); // 5 min ago
    await insertRow({
      id: 'aaaaaaaa-0000-0000-0000-000000000002',
      pipelineType: 'SCHEDULED_JOB',
      status: 'RUNNING',
      startedAt: recent,
      jobName: 'kg-communities',
    });

    const result = await reconcileOrphanedRunningJobs();

    expect(result.closed).toBe(0);
    const row = await SELECT.one.from(PipelineLog).where({ ID: 'aaaaaaaa-0000-0000-0000-000000000002' });
    expect(row.status).toBe('RUNNING');
    expect(row.finishedAt).toBeNull();
  });

  it('leaves non-SCHEDULED_JOB RUNNING rows alone (e.g. CONTENT_PUBLISH)', async () => {
    const old = new Date(Date.now() - 3 * HOUR);
    await insertRow({
      id: 'aaaaaaaa-0000-0000-0000-000000000003',
      pipelineType: 'CONTENT_PUBLISH',
      status: 'RUNNING',
      startedAt: old,
      jobName: null,
    });

    const result = await reconcileOrphanedRunningJobs();

    expect(result.closed).toBe(0);
    const row = await SELECT.one.from(PipelineLog).where({ ID: 'aaaaaaaa-0000-0000-0000-000000000003' });
    expect(row.status).toBe('RUNNING');
  });

  it('leaves already-finished rows alone (SUCCESS / FAILED)', async () => {
    const old = new Date(Date.now() - 3 * HOUR);
    await insertRow({
      id: 'aaaaaaaa-0000-0000-0000-000000000004',
      pipelineType: 'SCHEDULED_JOB',
      status: 'SUCCESS',
      startedAt: old,
      finishedAt: old,
      jobName: 'kg-pagerank',
    });

    const result = await reconcileOrphanedRunningJobs();

    expect(result.closed).toBe(0);
    const row = await SELECT.one.from(PipelineLog).where({ ID: 'aaaaaaaa-0000-0000-0000-000000000004' });
    expect(row.status).toBe('SUCCESS');
  });

  it('closes multiple orphaned rows in one pass and computes durationMs', async () => {
    const old = new Date(Date.now() - 90 * 60 * 1000); // 90 min ago
    await insertRow({ id: 'aaaaaaaa-0000-0000-0000-000000000005', pipelineType: 'SCHEDULED_JOB', status: 'RUNNING', startedAt: old, jobName: 'job-a' });
    await insertRow({ id: 'aaaaaaaa-0000-0000-0000-000000000006', pipelineType: 'SCHEDULED_JOB', status: 'RUNNING', startedAt: old, jobName: 'job-b' });

    const result = await reconcileOrphanedRunningJobs();

    expect(result.closed).toBe(2);
    const rows = await SELECT.from(PipelineLog).where({ status: 'FAILED' });
    expect(rows.length).toBe(2);
    for (const r of rows) {
      expect(r.durationMs).toBeGreaterThan(0);
    }
  });

  it('exposes a 60-minute floor constant', () => {
    expect(_RECONCILE_FLOOR_MS_FOR_TESTS).toBe(60 * 60 * 1000);
  });
});

describe('forceCloseRunningPipelineLog (#1293)', () => {
  it('closes a RUNNING row for the named job with NO age gate', async () => {
    const recent = new Date(Date.now() - 2 * 60 * 1000); // 2 min ago — younger than floor
    await insertRow({
      id: 'bbbbbbbb-0000-0000-0000-000000000001',
      pipelineType: 'SCHEDULED_JOB',
      status: 'RUNNING',
      startedAt: recent,
      jobName: 'fetch-news',
    });

    const result = await forceCloseRunningPipelineLog('fetch-news');

    expect(result.closed).toBe(1);
    const row = await SELECT.one.from(PipelineLog).where({ ID: 'bbbbbbbb-0000-0000-0000-000000000001' });
    expect(row.status).toBe('FAILED');
    expect(row.finishedAt).toBeTruthy();
    expect(row.errorDetails).toMatch(/force-closed/i);
  });

  it('only closes rows matching the given jobName', async () => {
    const recent = new Date(Date.now() - 2 * 60 * 1000);
    await insertRow({ id: 'bbbbbbbb-0000-0000-0000-000000000002', pipelineType: 'SCHEDULED_JOB', status: 'RUNNING', startedAt: recent, jobName: 'fetch-news' });
    await insertRow({ id: 'bbbbbbbb-0000-0000-0000-000000000003', pipelineType: 'SCHEDULED_JOB', status: 'RUNNING', startedAt: recent, jobName: 'kg-wcc' });

    const result = await forceCloseRunningPipelineLog('fetch-news');

    expect(result.closed).toBe(1);
    const other = await SELECT.one.from(PipelineLog).where({ ID: 'bbbbbbbb-0000-0000-0000-000000000003' });
    expect(other.status).toBe('RUNNING');
  });

  it('returns closed:0 when no RUNNING row exists for the job', async () => {
    const result = await forceCloseRunningPipelineLog('nonexistent-job');
    expect(result.closed).toBe(0);
  });
});
