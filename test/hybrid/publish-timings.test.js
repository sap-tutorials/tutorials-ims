// test/hybrid/publish-timings.test.js
// Real-HANA guard for issue #1667 (and the #805 timing telemetry the
// original plan specified but never landed a test for).
//
// The #805 append-timing UPDATE originally used raw SQL with quoted
// camelCase identifiers (`"appendMsTotal"`, `"firstAppendAt"`). The
// hand-authored ContentManifest.hdbmigrationtable declares those columns
// UNQUOTED, so HANA folds them to UPPERCASE (APPENDMSTOTAL/FIRSTAPPENDAT).
// The quoted-camelCase UPDATE therefore never matched a real column and
// failed EVERY append batch with "invalid column name: appendMsTotal"
// (caught + logged non-fatal). Result: firstAppendAt stayed NULL,
// appendMsTotal stayed 0, and publish.append.ms telemetry was silently lost.
//
// This test reproduces the failure mode on the real HANA pool: against the
// buggy code firstAppendAt is never stamped and appendMsTotal never leaves 0;
// against the fixed CQL path both are populated and copied onto PublishTimings.
// SQLite unit tests cannot catch this (SQLite identifier matching is
// case-insensitive) — see test/unit/content-publish-timing.test.js.

import cds from '@sap/cds';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { gzipSync } from 'node:zlib';
import { createSessionHelpers } from '../../srv/lib/content-publish-session.js';
import { isSafeForWrites } from './_guard.js';

const NS = 'com.sap.developers.ims';
const PREFIX = '__TEST__timing-';

describe('content publish append timing telemetry — HANA (#1667)', () => {
  let helpers;
  const sessionIds = [];

  beforeAll(async () => {
    if (process.env.ALLOW_HYBRID_WRITES !== 'true') {
      throw new Error('Hybrid writes require ALLOW_HYBRID_WRITES=true');
    }
    if (!isSafeForWrites()) {
      throw new Error('Refusing to run hybrid writes against production');
    }
    await cds.connect.to('db');
    helpers = createSessionHelpers({ namespace: NS });
  });

  afterAll(async () => {
    const { ContentFiles, ContentManifest, PublishTimings } = cds.entities(NS);
    if (sessionIds.length) {
      await DELETE.from(PublishTimings).where({ sessionId: { in: sessionIds } });
    }
    const stale = await SELECT.from(ContentManifest).where`status = 'PUBLISHING' or status = 'FAILED'`;
    if (stale.length) {
      await DELETE.from(ContentFiles).where({ version: { in: stale.map(r => r.version) } });
      await DELETE.from(ContentManifest).where({ version: { in: stale.map(r => r.version) } });
    }
    await DELETE.from(ContentFiles).where({ slug: { like: `${PREFIX}%` } });
  });

  it('append stamps firstAppendAt + accumulates appendMsTotal, and commit copies it to PublishTimings', async () => {
    const { ContentManifest, PublishTimings } = cds.entities(NS);

    const begin = await helpers.beginPublishSession({
      trigger: 'hybrid-timing', hugoVersion: 'test', expectedSlugCount: 2, initiator: 'hybrid-test'
    });
    sessionIds.push(begin.sessionId);

    const html = (slug) => `<html><body><main class="tutorial-main">${slug}</main></body></html>`;
    const batch = (slugs) => ({
      sessionId: begin.sessionId,
      files: Object.fromEntries(slugs.map(s => [s, gzipSync(Buffer.from(html(s))).toString('base64')])),
    });

    await helpers.appendToSession(batch([`${PREFIX}a`]));

    // The core #1667 assertion: on the buggy quoted-camelCase raw SQL the
    // UPDATE failed on HANA, leaving firstAppendAt NULL and appendMsTotal 0.
    const afterFirst = await SELECT.one.from(ContentManifest).where({ sessionId: begin.sessionId });
    expect(afterFirst.firstAppendAt, 'firstAppendAt must be stamped on HANA after first append').toBeTruthy();
    expect(afterFirst.appendMsTotal).toBeTypeOf('number');
    expect(afterFirst.appendMsTotal).toBeGreaterThanOrEqual(0);
    const firstStamp = afterFirst.firstAppendAt;

    await helpers.appendToSession(batch([`${PREFIX}b`]));
    const afterSecond = await SELECT.one.from(ContentManifest).where({ sessionId: begin.sessionId });
    expect(afterSecond.appendMsTotal).toBeGreaterThanOrEqual(afterFirst.appendMsTotal);
    expect(afterSecond.firstAppendAt, 'firstAppendAt must not be re-stamped').toEqual(firstStamp);

    await helpers.commitSession({ sessionId: begin.sessionId });

    const timing = await SELECT.one.from(PublishTimings).where({ sessionId: begin.sessionId });
    expect(timing, 'PublishTimings row must be written on commit').toBeTruthy();
    expect(timing.outcome).toBe('committed');
    expect(timing.appendMsTotal).toBe(afterSecond.appendMsTotal);
    expect(timing.beginMs).toBeGreaterThanOrEqual(0);
  });
});
