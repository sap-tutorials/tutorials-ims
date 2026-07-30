// test/unit/content-publish-lock-owner.test.js
// Regression test for issue #1387: PROD content rebuilds kept 409ing
// ("Another publish in progress") EVEN AFTER a clean success, because the
// chunked publish path owned the `content-publish` JobLock by CF instance id.
//
// The chunked protocol splits begin / append / commit into separate HTTP
// requests, and PROD tutorials-srv runs `instances: 2` (deploy/prod.mtaext).
// So `begin` could acquire the lock on instance A (lockedBy = A) while
// `commit` ran on instance B, whose releaseLock DELETE (WHERE lockedBy = B)
// matched nothing — leaving the lock held until its 30-min TTL and 409ing
// every rebuild in that window. DEV (instances: 1) never reproduced it.
//
// A same-process unit test can't spin up two CF instances, so instead we
// assert the *fix invariant* that makes cross-instance release correct:
//   - after begin, the JobLock is owned by the session id (a value threaded
//     through all three requests), NOT by any instance-scoped identifier;
//   - commit removes the lock row;
//   - abort removes the lock row.
// Because the owner is the session id, release works regardless of which
// instance handles the commit/abort request.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import cds from '@sap/cds';
import { gzipSync } from 'node:zlib';
import { createSessionHelpers } from '../../srv/lib/content-publish-session.js';

const NS = 'com.sap.developers.ims';
const LOCK_NAME = 'content-publish';

const project = cds.test('serve', '--project', '.', '--in-memory');

function makeBase64Gzip(html) {
  return gzipSync(Buffer.from(html, 'utf-8')).toString('base64');
}

describe('chunked publish owns the JobLock by sessionId (#1387)', () => {
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

  it('begin records the lock owner as the sessionId (not an instance id)', async () => {
    const { sessionId } = await helpers.beginPublishSession({
      trigger: 'unit-test-lock-owner',
      hugoVersion: '0.147.0',
      expectedSlugCount: 1,
      initiator: 'test-suite'
    });

    const lock = await SELECT.one.from(JobLocks).where({ jobName: LOCK_NAME });
    expect(lock, 'a content-publish lock row should exist after begin').toBeTruthy();
    expect(lock.lockedBy).toBe(sessionId);
  });

  it('commit releases the lock even when a different instance would run it', async () => {
    const { sessionId } = await helpers.beginPublishSession({
      trigger: 'unit-test-lock-commit',
      hugoVersion: '0.147.0',
      expectedSlugCount: 1,
      initiator: 'test-suite'
    });

    await helpers.appendToSession({
      sessionId,
      files: { 'unit-test-lock-slug': makeBase64Gzip('<html><body>hi</body></html>') }
    });

    // Simulate the multi-instance reality: the commit is being served by a
    // *different* CF instance than begin. Because the lock is owned by
    // sessionId (threaded across requests), release does not depend on which
    // instance handles this call. (The bug this guards was an instance-scoped
    // owner: commit's DELETE would then match nothing and the lock would leak.)
    await helpers.commitSession({ sessionId });

    const lock = await SELECT.one.from(JobLocks).where({ jobName: LOCK_NAME });
    expect(lock, 'commit must release the content-publish lock').toBeFalsy();

    // And a fresh begin must succeed immediately (no 409 within the TTL window).
    const next = await helpers.beginPublishSession({
      trigger: 'unit-test-lock-next',
      hugoVersion: '0.147.0',
      expectedSlugCount: 0,
      initiator: 'test-suite'
    });
    expect(next.sessionId).toBeTruthy();
    expect(next.sessionId).not.toBe(sessionId);
  });

  it('abort releases the lock', async () => {
    const { sessionId } = await helpers.beginPublishSession({
      trigger: 'unit-test-lock-abort',
      hugoVersion: '0.147.0',
      expectedSlugCount: 1,
      initiator: 'test-suite'
    });

    await helpers.abortSession({ sessionId, reason: 'simulated network drop' });

    const lock = await SELECT.one.from(JobLocks).where({ jobName: LOCK_NAME });
    expect(lock, 'abort must release the content-publish lock').toBeFalsy();

    // A fresh begin after abort must not 409.
    const next = await helpers.beginPublishSession({
      trigger: 'unit-test-lock-after-abort',
      hugoVersion: '0.147.0',
      expectedSlugCount: 0,
      initiator: 'test-suite'
    });
    expect(next.sessionId).toBeTruthy();
  });
});
