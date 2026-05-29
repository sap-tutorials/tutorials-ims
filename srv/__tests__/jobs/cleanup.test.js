// srv/__tests__/jobs/cleanup.test.js
import cds from '@sap/cds';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { cleanupStuckPublishing } from '../../jobs/cleanup.js';

cds.test('serve', '--project', '.', '--in-memory');

const NS = 'com.sap.developers.ims';

describe('cleanupStuckPublishing', () => {
  beforeAll(async () => {
    await cds.connect.to('db');
  });

  beforeEach(async () => {
    const { ContentManifest, ContentFiles, JobLocks } = cds.entities(NS);
    await DELETE.from(ContentFiles);
    await DELETE.from(ContentManifest);
    await DELETE.from(JobLocks);
  });

  it('marks PUBLISHING rows older than threshold as FAILED only when sessionId is set (chunked cohort)', async () => {
    const { ContentManifest } = cds.entities(NS);
    const oldDate = new Date(Date.now() - 31 * 60 * 1000).toISOString();

    // Stale chunked session — should be reaped.
    await INSERT.into(ContentManifest).entries({
      version: 1, status: 'PUBLISHING', sessionId: '11111111-1111-1111-1111-111111111111',
      lastAppendAt: oldDate, fileCount: 0, totalSizeBytes: 0,
      changedSlugs: '[]', trigger: 'stale'
    });

    // Stale legacy publish (no sessionId, only 31 min old) — should NOT be reaped (60-min threshold).
    await INSERT.into(ContentManifest).entries({
      version: 2, status: 'PUBLISHING', sessionId: null,
      lastAppendAt: null,
      fileCount: 0, totalSizeBytes: 0,
      changedSlugs: '[]', trigger: 'legacy-not-yet-old-enough'
    });
    // Force createdAt via UPDATE — managed aspect overwrites on INSERT.
    await UPDATE(ContentManifest).where({ version: 2 }).set({ createdAt: oldDate });

    await cleanupStuckPublishing(30, 60);

    const v1 = await SELECT.one.from(ContentManifest).where({ version: 1 });
    const v2 = await SELECT.one.from(ContentManifest).where({ version: 2 });
    expect(v1.status).toBe('FAILED');
    expect(v2.status).toBe('PUBLISHING'); // legacy untouched at 31 min
  });

  it('reaps legacy single-shot publishes (sessionId NULL) using createdAt and the longer threshold', async () => {
    const { ContentManifest } = cds.entities(NS);
    const veryOld = new Date(Date.now() - 61 * 60 * 1000).toISOString();

    await INSERT.into(ContentManifest).entries({
      version: 3, status: 'PUBLISHING', sessionId: null,
      lastAppendAt: null,
      fileCount: 0, totalSizeBytes: 0,
      changedSlugs: '[]', trigger: 'legacy-very-old'
    });
    await UPDATE(ContentManifest).where({ version: 3 }).set({ createdAt: veryOld });

    await cleanupStuckPublishing(30, 60);

    const v3 = await SELECT.one.from(ContentManifest).where({ version: 3 });
    expect(v3.status).toBe('FAILED');
  });
});
