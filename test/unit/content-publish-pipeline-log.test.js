// test/unit/content-publish-pipeline-log.test.js
// Regression test for the 2026-06-22 fix where the chunked publish path
// (/content/publish/begin → append → commit) wasn't writing PipelineLog
// rows. The admin UI's Pipeline Log tile had been empty since 2026-05-29
// — the day publish migrated to the chunked protocol. Author left a
// "Task 3: route wiring if needed" TODO at content-publish-session.js:269
// that was never done.
//
// This test exercises createSessionHelpers directly (matching the pattern
// in test/hybrid/content-publish-chunked.test.js) and asserts that:
//   - begin → PipelineLog row inserted with status RUNNING, pipelineType CONTENT_PUBLISH
//   - commit → same row updated to SUCCESS with summary, durationMs, finishedAt
//   - abort → same row updated to FAILED
//
// The PipelineLog.ID equals the session's sessionId (1:1 correlation),
// which keeps debugging trivial: an admin row in /admin-ui/#pipelinelog-display
// maps directly to a ContentManifest row.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import cds from '@sap/cds';
import { gzipSync } from 'node:zlib';
import { createSessionHelpers } from '../../srv/lib/content-publish-session.js';

const NS = 'com.sap.developers.ims';

const project = cds.test('serve', '--project', '.', '--in-memory');

function makeBase64Gzip(html) {
  return gzipSync(Buffer.from(html, 'utf-8')).toString('base64');
}

describe('chunked publish writes PipelineLog rows (#regression)', () => {
  let helpers;
  let ContentFiles, ContentManifest, PipelineLog, JobLocks;

  beforeAll(() => {
    helpers = createSessionHelpers({ namespace: NS });
    ({ ContentFiles, ContentManifest, PipelineLog, JobLocks } = cds.entities(NS));
  });

  beforeEach(async () => {
    await DELETE.from(ContentFiles);
    await DELETE.from(ContentManifest);
    await DELETE.from(PipelineLog);
    await DELETE.from(JobLocks);
  });

  it('begin → commit emits a CONTENT_PUBLISH PipelineLog row that ends in SUCCESS', async () => {
    // begin
    const { sessionId, version } = await helpers.beginPublishSession({
      trigger: 'unit-test',
      hugoVersion: '0.147.0',
      expectedSlugCount: 1,
      initiator: 'test-suite'
    });

    // After begin, PipelineLog should have a RUNNING row keyed by sessionId.
    const afterBegin = await SELECT.one.from(PipelineLog).where({ ID: sessionId });
    expect(afterBegin, 'PipelineLog row should exist after beginPublishSession').toBeTruthy();
    expect(afterBegin.pipelineType).toBe('CONTENT_PUBLISH');
    expect(afterBegin.status).toBe('RUNNING');
    expect(afterBegin.initiator).toBe('test-suite');
    expect(afterBegin.startedAt).toBeTruthy();
    expect(afterBegin.finishedAt).toBeFalsy();

    // The metadata column should carry the begin-time payload as JSON.
    const meta = JSON.parse(afterBegin.metadata || '{}');
    expect(meta.trigger).toBe('unit-test');
    expect(meta.hugoVersion).toBe('0.147.0');
    expect(meta.expectedSlugCount).toBe(1);
    expect(meta.version).toBe(version);

    // append one slug
    await helpers.appendToSession({
      sessionId,
      files: { 'unit-test-slug': makeBase64Gzip('<html><body>hi</body></html>') }
    });

    // commit
    await helpers.commitSession({ sessionId });

    const afterCommit = await SELECT.one.from(PipelineLog).where({ ID: sessionId });
    expect(afterCommit.status, 'PipelineLog row should land in SUCCESS').toBe('SUCCESS');
    expect(afterCommit.finishedAt).toBeTruthy();
    expect(afterCommit.durationMs).toBeGreaterThanOrEqual(0);
    expect(afterCommit.summary).toMatch(/^Published v\d+: \d+ new \+ \d+ carried = \d+ slugs in \d+ms$/);
  });

  it('begin → abort emits a CONTENT_PUBLISH PipelineLog row that ends in FAILED', async () => {
    const { sessionId } = await helpers.beginPublishSession({
      trigger: 'unit-test-abort',
      hugoVersion: '0.147.0',
      expectedSlugCount: 1,
      initiator: 'test-suite'
    });

    await helpers.abortSession({ sessionId, reason: 'simulated network drop' });

    const afterAbort = await SELECT.one.from(PipelineLog).where({ ID: sessionId });
    expect(afterAbort.status).toBe('FAILED');
    expect(afterAbort.finishedAt).toBeTruthy();
    expect(afterAbort.summary).toMatch(/^Aborted v\d+: simulated network drop$/);
    expect(afterAbort.errorDetails).toBe('simulated network drop');
  });

  it('PipelineLog.ID equals ContentManifest.sessionId (1:1 correlation)', async () => {
    const { sessionId } = await helpers.beginPublishSession({
      trigger: 'unit-test-correlation',
      hugoVersion: '0.147.0',
      expectedSlugCount: 0,
      initiator: 'test-suite'
    });

    // Same sessionId on both rows means an admin can pivot from a Pipeline Log
    // row to the underlying ContentManifest by ID without joins.
    const log = await SELECT.one.from(PipelineLog).where({ ID: sessionId });
    const manifest = await SELECT.one.from(ContentManifest).where({ sessionId });

    expect(log).toBeTruthy();
    expect(manifest).toBeTruthy();
    expect(log.ID).toBe(manifest.sessionId);
  });
});
