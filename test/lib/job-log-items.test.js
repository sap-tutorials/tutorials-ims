import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import cds from '@sap/cds';
import { logPipelineStart, logPipelineEnd, logJobItem } from '../../srv/lib/pipeline-log.js';
import { cleanupPipelineLog } from '../../srv/jobs/cleanup.js';
import { formatJobSummary } from '../../srv/jobs/scheduler.js';

const project = cds.test('serve', '--project', '.', '--in-memory');

const adminAuth = { auth: { username: 'admin', password: 'admin' } };

describe('JobLogItems', () => {
  let PipelineLog, JobLogItems;

  beforeAll(() => {
    ({ PipelineLog, JobLogItems } = cds.entities('com.sap.developers.ims'));
  });

  beforeEach(async () => {
    await DELETE.from(JobLogItems);
    await DELETE.from(PipelineLog);
  });

  describe('logJobItem helper', () => {
    it('inserts a row with the supplied fields', async () => {
      const logId = await logPipelineStart('SCHEDULED_JOB', 'system', { jobName: 'account-merge-batch' });
      await logJobItem(logId, {
        itemKey: 'sec-uuid-1',
        itemKind: 'ACCOUNT_MERGE',
        status: 'SUCCESS',
        message: 'Merged into pri-uuid-9'
      });

      const rows = await SELECT.from(JobLogItems).where({ jobLog_ID: logId });
      expect(rows).toHaveLength(1);
      expect(rows[0].itemKey).toBe('sec-uuid-1');
      expect(rows[0].itemKind).toBe('ACCOUNT_MERGE');
      expect(rows[0].status).toBe('SUCCESS');
      expect(rows[0].message).toBe('Merged into pri-uuid-9');
    });

    it('defaults status to SUCCESS and itemKind to OTHER when not provided', async () => {
      const logId = await logPipelineStart('SCHEDULED_JOB', 'system');
      await logJobItem(logId, { itemKey: 'k', message: 'm' });
      const [row] = await SELECT.from(JobLogItems).where({ jobLog_ID: logId });
      expect(row.status).toBe('SUCCESS');
      expect(row.itemKind).toBe('OTHER');
    });

    it('truncates oversized itemKey and message', async () => {
      const logId = await logPipelineStart('SCHEDULED_JOB', 'system');
      const longKey = 'x'.repeat(500);
      const longMsg = 'y'.repeat(3000);
      await logJobItem(logId, {
        itemKey: longKey,
        itemKind: 'TUTORIAL_EMBEDDING',
        status: 'WARN',
        message: longMsg
      });
      const [row] = await SELECT.from(JobLogItems).where({ jobLog_ID: logId });
      expect(row.itemKey.length).toBe(255);
      expect(row.message.length).toBe(2000);
    });

    it('no-ops silently when logId is missing', async () => {
      await expect(
        logJobItem(null, { itemKey: 'k', itemKind: 'OTHER', status: 'ERROR', message: 'm' })
      ).resolves.toBeUndefined();
      const rows = await SELECT.from(JobLogItems);
      expect(rows).toHaveLength(0);
    });
  });

  describe('OData exposure on /admin', () => {
    it('navigates from JobExecutionLog to its jobItems', async () => {
      const logId = await logPipelineStart('SCHEDULED_JOB', 'system', { jobName: 'account-merge-batch' });
      await logJobItem(logId, { itemKey: 'sec-1', itemKind: 'ACCOUNT_MERGE', status: 'SUCCESS', message: 'merged' });
      await logJobItem(logId, { itemKey: 'sec-2', itemKind: 'ACCOUNT_MERGE', status: 'ERROR',   message: 'boom' });
      await logPipelineEnd(logId, 'SUCCESS', 'account-merge-batch: pending=2, processed=1, failed=1');

      const { status, data } = await project.get(
        `/admin/JobExecutionLog(${logId})/jobItems`,
        adminAuth
      );
      expect(status).toBe(200);
      expect(data.value).toHaveLength(2);
      const keys = data.value.map(r => r.itemKey).sort();
      expect(keys).toEqual(['sec-1', 'sec-2']);
    });

    it('exposes statusCriticality via the after-READ hook', async () => {
      const logId = await logPipelineStart('SCHEDULED_JOB', 'system');
      await logJobItem(logId, { itemKey: 'a', itemKind: 'OTHER', status: 'ERROR',   message: 'm' });
      await logJobItem(logId, { itemKey: 'b', itemKind: 'OTHER', status: 'WARN',    message: 'm' });
      await logJobItem(logId, { itemKey: 'c', itemKind: 'OTHER', status: 'SUCCESS', message: 'm' });
      await logJobItem(logId, { itemKey: 'd', itemKind: 'OTHER', status: 'SKIPPED', message: 'm' });
      await logPipelineEnd(logId, 'SUCCESS');

      const { status, data } = await project.get(
        `/admin/JobLogItems?$orderby=itemKey asc`,
        adminAuth
      );
      expect(status).toBe(200);
      const byKey = Object.fromEntries(data.value.map(r => [r.itemKey, r]));
      expect(byKey.a.statusCriticality).toBe(1); // ERROR
      expect(byKey.b.statusCriticality).toBe(2); // WARN
      expect(byKey.c.statusCriticality).toBe(3); // SUCCESS
      expect(byKey.d.statusCriticality).toBe(0); // SKIPPED / unknown
    });

    it('exposes the jobItems composition as a $expand on JobExecutionLog', async () => {
      const logId = await logPipelineStart('SCHEDULED_JOB', 'system');
      await logJobItem(logId, { itemKey: 'a', itemKind: 'OTHER', status: 'SUCCESS', message: 'm' });
      await logPipelineEnd(logId, 'SUCCESS');

      const { status, data } = await project.get(
        `/admin/JobExecutionLog(${logId})?$expand=jobItems`,
        adminAuth
      );
      expect(status).toBe(200);
      expect(data.jobItems).toHaveLength(1);
      expect(data.jobItems[0].itemKey).toBe('a');
    });
  });

  describe('cleanupPipelineLog cascade', () => {
    it('deletes job items before deleting expired parents', async () => {
      const oldLogId = cds.utils.uuid();
      const recentLogId = cds.utils.uuid();
      const oldDate = new Date(Date.now() - 60 * 86400000).toISOString();
      const recentDate = new Date().toISOString();

      await INSERT.into(PipelineLog).entries([
        { ID: oldLogId,    pipelineType: 'SCHEDULED_JOB', status: 'SUCCESS', startedAt: oldDate,    initiator: 'old' },
        { ID: recentLogId, pipelineType: 'SCHEDULED_JOB', status: 'SUCCESS', startedAt: recentDate, initiator: 'recent' }
      ]);
      await INSERT.into(JobLogItems).entries([
        { ID: cds.utils.uuid(), jobLog_ID: oldLogId,    itemKey: 'old-a',  itemKind: 'OTHER', status: 'SUCCESS', message: 'm' },
        { ID: cds.utils.uuid(), jobLog_ID: oldLogId,    itemKey: 'old-b',  itemKind: 'OTHER', status: 'ERROR',   message: 'm' },
        { ID: cds.utils.uuid(), jobLog_ID: recentLogId, itemKey: 'recent', itemKind: 'OTHER', status: 'SUCCESS', message: 'm' }
      ]);

      await cleanupPipelineLog(30);

      const remainingLogs = await SELECT.from(PipelineLog);
      expect(remainingLogs.map(l => l.ID)).toEqual([recentLogId]);

      const remainingItems = await SELECT.from(JobLogItems);
      expect(remainingItems).toHaveLength(1);
      expect(remainingItems[0].itemKey).toBe('recent');
    });
  });
});

describe('formatJobSummary', () => {
  it('falls back to the job name when result is null/undefined', () => {
    expect(formatJobSummary('foo', null)).toBe('foo');
    expect(formatJobSummary('foo', undefined)).toBe('foo');
  });

  it('passes strings through (capped at 2000 chars)', () => {
    expect(formatJobSummary('foo', 'all good')).toBe('all good');
    const long = 'x'.repeat(3000);
    expect(formatJobSummary('foo', long).length).toBe(2000);
  });

  it('formats numbers as "<job>: processed N"', () => {
    expect(formatJobSummary('cleanup-step-failures', 42)).toBe('cleanup-step-failures: processed 42');
  });

  it('renders objects as a key=value list', () => {
    expect(formatJobSummary('account-merge-batch', { pending: 5, processed: 4, failed: 1 }))
      .toBe('account-merge-batch: pending=5, processed=4, failed=1');
  });

  it('skips null/undefined fields and non-primitive values in objects', () => {
    expect(formatJobSummary('embedding-reconciliation', {
      candidates: 3, embedded: 2, skipped: 1, failed: 0, lockHeld: false, weird: { nested: 1 }, missing: null
    })).toBe('embedding-reconciliation: candidates=3, embedded=2, skipped=1, failed=0, lockHeld=false');
  });

  it('falls back to the job name for empty objects', () => {
    expect(formatJobSummary('foo', {})).toBe('foo');
  });
});
