// test/unit/content-publish-timing.test.js
// Regression test for issue #1667: the #805 append-timing telemetry UPDATE
// used raw SQL with quoted-camelCase identifiers (`"appendMsTotal"`,
// `"firstAppendAt"`). The hand-authored ContentManifest.hdbmigrationtable
// declares those columns UNQUOTED, so HANA folds them to UPPERCASE — the
// quoted-camelCase UPDATE never matched a real column and failed every batch
// with "invalid column name: appendMsTotal" (caught, logged non-fatal). The
// timing metric was therefore silently lost on every publish. The fix
// replaces the raw SQL with CQL so CAP emits the correct per-dialect casing.
//
// NOTE ON COVERAGE: this suite runs against in-memory SQLite, whose
// identifier matching is case-INSENSITIVE, so the original buggy raw SQL
// would also "pass" here. This test therefore guards against the update
// being dropped or regressed (appendMsTotal never accumulating,
// firstAppendAt never stamped), NOT the HANA-specific casing failure. The
// real HANA guard is test/hybrid/publish-timings.test.js, which exercises
// the same flow through the real HANA pool where the casing bug reproduces.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import cds from '@sap/cds';
import { gzipSync } from 'node:zlib';
import { createSessionHelpers } from '../../srv/lib/content-publish-session.js';

const NS = 'com.sap.developers.ims';

const project = cds.test('serve', '--project', '.', '--in-memory');

function makeBase64Gzip(html) {
  return gzipSync(Buffer.from(html, 'utf-8')).toString('base64');
}

describe('chunked publish records append timing telemetry (#1667)', () => {
  let helpers;
  let ContentFiles, ContentManifest, PublishTimings, PipelineLog, JobLocks;

  beforeAll(() => {
    helpers = createSessionHelpers({ namespace: NS });
    ({ ContentFiles, ContentManifest, PublishTimings, PipelineLog, JobLocks } = cds.entities(NS));
  });

  beforeEach(async () => {
    await DELETE.from(ContentFiles);
    await DELETE.from(ContentManifest);
    await DELETE.from(PublishTimings);
    await DELETE.from(PipelineLog);
    await DELETE.from(JobLocks);
  });

  it('append stamps firstAppendAt (once) and accumulates appendMsTotal on the manifest', async () => {
    const { sessionId } = await helpers.beginPublishSession({
      trigger: 'unit-test',
      hugoVersion: '0.147.0',
      expectedSlugCount: 2,
      initiator: 'test-suite'
    });

    // On a fresh manifest the timing columns start at their defaults.
    const atBegin = await SELECT.one.from(ContentManifest).where({ sessionId });
    expect(atBegin.appendMsTotal, 'appendMsTotal defaults to 0 at begin').toBe(0);
    expect(atBegin.firstAppendAt, 'firstAppendAt is null until the first append').toBeFalsy();

    // First append: the timing UPDATE must succeed (not silently fail as in
    // #1667). firstAppendAt is the strongest SQLite-observable signal — it
    // defaults null and ONLY the timing UPDATE sets it.
    await helpers.appendToSession({
      sessionId,
      files: { 'unit-test-slug-a': makeBase64Gzip('<html><body>a</body></html>') }
    });

    const afterFirst = await SELECT.one.from(ContentManifest).where({ sessionId });
    expect(afterFirst.firstAppendAt, 'firstAppendAt must be stamped on first append').toBeTruthy();
    expect(afterFirst.appendMsTotal, 'appendMsTotal must be a number after append').toBeTypeOf('number');
    expect(afterFirst.appendMsTotal).toBeGreaterThanOrEqual(0);

    const firstStamp = afterFirst.firstAppendAt;
    const firstTotal = afterFirst.appendMsTotal;

    // Second append: appendMsTotal accumulates (never decreases); firstAppendAt
    // is stamped only once and must not be overwritten.
    await helpers.appendToSession({
      sessionId,
      files: { 'unit-test-slug-b': makeBase64Gzip('<html><body>b</body></html>') }
    });

    const afterSecond = await SELECT.one.from(ContentManifest).where({ sessionId });
    expect(afterSecond.appendMsTotal, 'appendMsTotal must accumulate across batches')
      .toBeGreaterThanOrEqual(firstTotal);
    expect(afterSecond.firstAppendAt, 'firstAppendAt must not be re-stamped on later appends')
      .toBe(firstStamp);
  });

  it('commit writes a PublishTimings row carrying the accumulated appendMsTotal', async () => {
    const { sessionId, version } = await helpers.beginPublishSession({
      trigger: 'unit-test',
      hugoVersion: '0.147.0',
      expectedSlugCount: 1,
      initiator: 'test-suite'
    });

    await helpers.appendToSession({
      sessionId,
      files: { 'unit-test-slug': makeBase64Gzip('<html><body>hi</body></html>') }
    });

    const manifest = await SELECT.one.from(ContentManifest).where({ sessionId });

    await helpers.commitSession({ sessionId });

    const timing = await SELECT.one.from(PublishTimings).where({ sessionId });
    expect(timing, 'a PublishTimings row must be written on commit').toBeTruthy();
    expect(timing.outcome).toBe('committed');
    expect(timing.manifestVersion).toBe(version);
    // The commit copies the manifest's accumulated tally onto the timing row.
    expect(timing.appendMsTotal).toBe(manifest.appendMsTotal);
    expect(timing.appendMsTotal).toBeGreaterThanOrEqual(0);
    expect(timing.beginMs).toBeGreaterThanOrEqual(0);
    expect(timing.commitMs).toBeGreaterThanOrEqual(0);
    expect(timing.totalMs).toBeGreaterThanOrEqual(0);
  });
});
