import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import cds from '@sap/cds';
import { logPipelineStart, logPipelineEnd, logPipelineItem } from '../../srv/lib/pipeline-log.js';
import { cleanupPipelineLog } from '../../srv/jobs/cleanup.js';

const project = cds.test('serve', '--project', '.', '--in-memory');

const adminAuth = { auth: { username: 'admin', password: 'admin' } };

describe('PipelineLogItems', () => {
  let PipelineLog, PipelineLogItems;

  beforeAll(() => {
    ({ PipelineLog, PipelineLogItems } = cds.entities('com.sap.developers.ims'));
  });

  beforeEach(async () => {
    await DELETE.from(PipelineLogItems);
    await DELETE.from(PipelineLog);
  });

  describe('logPipelineItem helper', () => {
    it('inserts a row with the supplied fields', async () => {
      const logId = await logPipelineStart('CONTENT_PUBLISH', 'tester', { fileCount: 1 });
      await logPipelineItem(logId, {
        slug: 'my-tutorial',
        phase: 'METADATA',
        severity: 'ERROR',
        message: 'boom'
      });

      const rows = await SELECT.from(PipelineLogItems).where({ pipelineLog_ID: logId });
      expect(rows).toHaveLength(1);
      expect(rows[0].slug).toBe('my-tutorial');
      expect(rows[0].phase).toBe('METADATA');
      expect(rows[0].severity).toBe('ERROR');
      expect(rows[0].message).toBe('boom');
    });

    it('defaults severity to ERROR when not provided', async () => {
      const logId = await logPipelineStart('CONTENT_PUBLISH', 'tester');
      await logPipelineItem(logId, { slug: 's', phase: 'METADATA', message: 'm' });
      const [row] = await SELECT.from(PipelineLogItems).where({ pipelineLog_ID: logId });
      expect(row.severity).toBe('ERROR');
    });

    it('truncates oversized slug and message', async () => {
      const logId = await logPipelineStart('CONTENT_PUBLISH', 'tester');
      const longSlug = 'x'.repeat(500);
      const longMsg = 'y'.repeat(3000);
      await logPipelineItem(logId, {
        slug: longSlug,
        phase: 'BODYTEXT',
        severity: 'WARN',
        message: longMsg
      });
      const [row] = await SELECT.from(PipelineLogItems).where({ pipelineLog_ID: logId });
      expect(row.slug.length).toBe(255);
      expect(row.message.length).toBe(2000);
    });

    it('coerces non-string message to string before truncating', async () => {
      const logId = await logPipelineStart('CONTENT_PUBLISH', 'tester');
      const err = new Error('oops');
      await logPipelineItem(logId, {
        slug: 's',
        phase: 'METADATA',
        severity: 'ERROR',
        message: err.message
      });
      const [row] = await SELECT.from(PipelineLogItems).where({ pipelineLog_ID: logId });
      expect(row.message).toBe('oops');
    });

    it('no-ops silently when logId is missing', async () => {
      await expect(
        logPipelineItem(null, { slug: 's', phase: 'METADATA', severity: 'ERROR', message: 'm' })
      ).resolves.toBeUndefined();
      const rows = await SELECT.from(PipelineLogItems);
      expect(rows).toHaveLength(0);
    });
  });

  describe('OData exposure on /admin', () => {
    it('navigates from PipelineLog to its items', async () => {
      const logId = await logPipelineStart('CONTENT_PUBLISH', 'tester', { fileCount: 2 });
      await logPipelineItem(logId, { slug: 'a', phase: 'METADATA', severity: 'ERROR', message: 'meta failed' });
      await logPipelineItem(logId, { slug: 'b', phase: 'BODYTEXT', severity: 'WARN', message: 'body skipped' });
      await logPipelineEnd(logId, 'SUCCESS', 'done');

      const { status, data } = await project.get(
        `/admin/PipelineLog(${logId})/items`,
        adminAuth
      );
      expect(status).toBe(200);
      expect(data.value).toHaveLength(2);
      const slugs = data.value.map(r => r.slug).sort();
      expect(slugs).toEqual(['a', 'b']);
    });

    it('exposes severityCriticality via the after-READ hook', async () => {
      const logId = await logPipelineStart('CONTENT_PUBLISH', 'tester');
      await logPipelineItem(logId, { slug: 'a', phase: 'METADATA', severity: 'ERROR', message: 'm' });
      await logPipelineItem(logId, { slug: 'b', phase: 'METADATA', severity: 'WARN', message: 'm' });
      await logPipelineEnd(logId, 'SUCCESS');

      const { status, data } = await project.get(
        `/admin/PipelineLogItems?$orderby=severity asc`,
        adminAuth
      );
      expect(status).toBe(200);
      const error = data.value.find(r => r.severity === 'ERROR');
      const warn = data.value.find(r => r.severity === 'WARN');
      expect(error.severityCriticality).toBe(1);
      expect(warn.severityCriticality).toBe(2);
    });

    it('exposes the items composition as a $expand on PipelineLog', async () => {
      const logId = await logPipelineStart('CONTENT_PUBLISH', 'tester');
      await logPipelineItem(logId, { slug: 'a', phase: 'METADATA', severity: 'ERROR', message: 'm' });
      await logPipelineEnd(logId, 'SUCCESS');

      const { status, data } = await project.get(
        `/admin/PipelineLog(${logId})?$expand=items`,
        adminAuth
      );
      expect(status).toBe(200);
      expect(data.items).toHaveLength(1);
      expect(data.items[0].slug).toBe('a');
    });
  });

  describe('cleanupPipelineLog', () => {
    it('deletes child items before deleting expired parents', async () => {
      const oldLogId = cds.utils.uuid();
      const recentLogId = cds.utils.uuid();
      const oldDate = new Date(Date.now() - 60 * 86400000).toISOString();
      const recentDate = new Date().toISOString();

      await INSERT.into(PipelineLog).entries([
        { ID: oldLogId, pipelineType: 'CONTENT_PUBLISH', status: 'SUCCESS', startedAt: oldDate, initiator: 'old' },
        { ID: recentLogId, pipelineType: 'CONTENT_PUBLISH', status: 'SUCCESS', startedAt: recentDate, initiator: 'recent' }
      ]);
      await INSERT.into(PipelineLogItems).entries([
        { ID: cds.utils.uuid(), pipelineLog_ID: oldLogId, slug: 'old-a', phase: 'METADATA', severity: 'ERROR', message: 'm' },
        { ID: cds.utils.uuid(), pipelineLog_ID: oldLogId, slug: 'old-b', phase: 'BODYTEXT', severity: 'WARN', message: 'm' },
        { ID: cds.utils.uuid(), pipelineLog_ID: recentLogId, slug: 'recent', phase: 'METADATA', severity: 'ERROR', message: 'm' }
      ]);

      await cleanupPipelineLog(30);

      const remainingLogs = await SELECT.from(PipelineLog);
      expect(remainingLogs.map(l => l.ID)).toEqual([recentLogId]);

      const remainingItems = await SELECT.from(PipelineLogItems);
      expect(remainingItems).toHaveLength(1);
      expect(remainingItems[0].slug).toBe('recent');
    });

    it('handles empty pipeline log gracefully', async () => {
      const result = await cleanupPipelineLog(30);
      expect(result).toBe(0);
    });
  });
});
