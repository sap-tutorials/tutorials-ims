// srv/__tests__/lib/content-publish-session.test.js
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import cds from '@sap/cds';
import { createSessionHelpers } from '../../lib/content-publish-session.js';

const NS = 'com.sap.developers.ims';

cds.test('serve', '--project', '.', '--in-memory');

describe('content-publish-session', () => {
  let helpers;

  beforeAll(async () => {
    await cds.connect.to('db');
    helpers = createSessionHelpers({ namespace: NS });
  });

  beforeEach(async () => {
    const { ContentManifest, ContentFiles, JobLocks } = cds.entities(NS);
    await DELETE.from(ContentFiles);
    await DELETE.from(ContentManifest);
    await DELETE.from(JobLocks);
  });

  it('beginPublishSession allocates a fresh version, sessionId, and PUBLISHING manifest', async () => {
    const { ContentManifest } = cds.entities(NS);
    const result = await helpers.beginPublishSession({ trigger: 'test', hugoVersion: 'v1', expectedSlugCount: 5 });

    expect(result.version).toBe(1);
    expect(result.sessionId).toMatch(/^[0-9a-f-]{36}$/);

    const row = await SELECT.one.from(ContentManifest).where({ version: 1 });
    expect(row.status).toBe('PUBLISHING');
    expect(row.sessionId).toBe(result.sessionId);
    expect(row.lastAppendAt).toBeTruthy();
    expect(row.trigger).toBe('test');
  });

  it('beginPublishSession returns 409 when the lock is already held', async () => {
    await helpers.beginPublishSession({ trigger: 'a', hugoVersion: 'v1', expectedSlugCount: 0 });
    await expect(
      helpers.beginPublishSession({ trigger: 'b', hugoVersion: 'v1', expectedSlugCount: 0 })
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});
