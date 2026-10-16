// test/unit/content-publish-session-phasetoken.test.js
//
// Task 5 (#2802): verify that:
//   1. appendToSession persists bodyHash from the bodyHashes map onto
//      ContentFiles rows (concept-* slugs get a value; others get null).
//   2. commitSession persists conceptPhaseToken on the ACTIVE ContentManifest
//      row, mirroring how pipelineToken is handled.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import cds from '@sap/cds';
import { gzipSync } from 'node:zlib';
import { createSessionHelpers } from '../../srv/lib/content-publish-session.js';

const NS = 'com.sap.developers.ims';

cds.test('serve', '--project', '.', '--in-memory');

function makeGzip(html) {
  return gzipSync(Buffer.from(html, 'utf-8')).toString('base64');
}

describe('content-publish-session phasetoken + bodyHash persistence (#2802)', () => {
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

  it('appendToSession stores bodyHash from bodyHashes map on concept-* slugs; non-concept slug gets null', async () => {
    const { sessionId } = await helpers.beginPublishSession({
      trigger: 'unit-test-bodyhash',
      hugoVersion: '0.147.0',
      expectedSlugCount: 2,
      initiator: 'test-suite',
    });

    const conceptSlug = 'concept-abap';
    const regularSlug = 'tutorial-hello-world';
    const BODY_HASH = 'aabbcc0011223344aabbcc0011223344aabbcc0011223344aabbcc0011223344';

    await helpers.appendToSession({
      sessionId,
      files: {
        [conceptSlug]: makeGzip('<html><body><main>concept body</main></body></html>'),
        [regularSlug]: makeGzip('<html><body><main>tutorial body</main></body></html>'),
      },
      bodyHashes: {
        [conceptSlug]: BODY_HASH,
        // regularSlug intentionally absent — should yield null
      },
    });

    const conceptRow = await SELECT.one.from(ContentFiles).where({ slug: conceptSlug });
    expect(conceptRow, 'concept-* row should exist').toBeTruthy();
    expect(conceptRow.bodyHash).toBe(BODY_HASH);

    const tutorialRow = await SELECT.one.from(ContentFiles).where({ slug: regularSlug });
    expect(tutorialRow, 'tutorial row should exist').toBeTruthy();
    expect(tutorialRow.bodyHash).toBeNull();
  });

  it('appendToSession without bodyHashes leaves all bodyHash columns null (backward compat)', async () => {
    const { sessionId } = await helpers.beginPublishSession({
      trigger: 'unit-test-no-bodyhash',
      hugoVersion: '0.147.0',
      expectedSlugCount: 1,
      initiator: 'test-suite',
    });

    await helpers.appendToSession({
      sessionId,
      files: {
        'concept-javascript': makeGzip('<html><body><main>js concept</main></body></html>'),
      },
      // no bodyHashes at all
    });

    const row = await SELECT.one.from(ContentFiles).where({ slug: 'concept-javascript' });
    expect(row).toBeTruthy();
    expect(row.bodyHash).toBeNull();
  });

  it('commitSession persists conceptPhaseToken on the ACTIVE ContentManifest row', async () => {
    const { sessionId } = await helpers.beginPublishSession({
      trigger: 'unit-test-phasetoken',
      hugoVersion: '0.147.0',
      expectedSlugCount: 1,
      initiator: 'test-suite',
    });

    await helpers.appendToSession({
      sessionId,
      files: {
        'tutorial-cap-intro': makeGzip('<html><body><main>cap intro</main></body></html>'),
      },
    });

    const TOKEN = 'deadbeef00112233deadbeef00112233deadbeef00112233deadbeef00112233';
    await helpers.commitSession({ sessionId, conceptPhaseToken: TOKEN });

    const manifest = await SELECT.one.from(ContentManifest).where({ sessionId });
    expect(manifest, 'manifest row should exist').toBeTruthy();
    expect(manifest.status).toBe('ACTIVE');
    expect(manifest.conceptPhaseToken).toBe(TOKEN);
  });

  it('commitSession with no conceptPhaseToken leaves the column null (legacy degrade)', async () => {
    const { sessionId } = await helpers.beginPublishSession({
      trigger: 'unit-test-null-phasetoken',
      hugoVersion: '0.147.0',
      expectedSlugCount: 1,
      initiator: 'test-suite',
    });

    await helpers.appendToSession({
      sessionId,
      files: {
        'tutorial-cap-intro': makeGzip('<html><body><main>cap intro</main></body></html>'),
      },
    });

    // omit conceptPhaseToken — should land NULL
    await helpers.commitSession({ sessionId });

    const manifest = await SELECT.one.from(ContentManifest).where({ sessionId });
    expect(manifest).toBeTruthy();
    expect(manifest.status).toBe('ACTIVE');
    expect(manifest.conceptPhaseToken).toBeNull();
  });
});
