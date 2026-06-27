// test/hybrid/content-publish-guard.test.js
// #672 — hybrid (HANA) verification of the publish staleness guard.
//
// SQLite covers the algorithm exhaustively in test/unit/content-publish-guard.test.js;
// this file confirms HANA-specific concerns: the SELECT against ContentFiles
// with `version: { '<': X }` works under HANA's SqlScript, BLOB columns aren't
// touched accidentally during the guard read, and ContentManifest.initiator
// round-trips through the real wire.
//
// Two cases:
//   1. Canonical regression: H1 → H2 → H1-revert is rejected; H2 stays ACTIVE.
//   2. Initiator round-trip: begin with 'bob@laptop', verify both columns.
//
// Cleanup follows the pattern in test/hybrid/content-publish-chunked.test.js:
// __TEST__ slug prefix + afterAll wipe.

import cds from '@sap/cds';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { createSessionHelpers } from '../../srv/lib/content-publish-session.js';
import { isSafeForWrites } from './_guard.js';

const NS = 'com.sap.developers.ims';
const PREFIX = '__TEST__guard-';

function html(s) {
  return gzipSync(Buffer.from(`<html><body><main class="tutorial-main">${s}</main></body></html>`, 'utf-8')).toString('base64');
}
function source(s) {
  return gzipSync(Buffer.from(s, 'utf-8')).toString('base64');
}
function sha256(s) {
  return createHash('sha256').update(Buffer.from(s, 'utf-8')).digest('hex');
}

describe('#672 publish staleness guard — HANA', () => {
  let helpers;

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
    const { ContentFiles, ContentManifest, PipelineLog } = cds.entities(NS);
    // Clean stale PUBLISHING/FAILED manifests (and their ContentFiles).
    const stale = await SELECT.from(ContentManifest).where`status = 'PUBLISHING' or status = 'FAILED'`;
    if (stale.length) {
      await DELETE.from(ContentFiles).where({ version: { in: stale.map((r) => r.version) } });
      await DELETE.from(ContentManifest).where({ version: { in: stale.map((r) => r.version) } });
    }
    // Wipe any rows the tests created.
    await DELETE.from(ContentFiles).where({ slug: { like: `${PREFIX}%` } });
    // PipelineLog rows for test sessions — sessionId IS the PipelineLog.ID,
    // so wipe by initiator prefix.
    await DELETE.from(PipelineLog).where({ initiator: { like: '__TEST__%' } });
  });

  async function publishOne(slug, label, initiator = '__TEST__guard-suite') {
    const { sessionId } = await helpers.beginPublishSession({
      trigger: 'hybrid-test', hugoVersion: 'test', expectedSlugCount: 1, initiator,
    });
    await helpers.appendToSession({
      sessionId,
      files: { [slug]: html(label) },
      sources: { [slug]: source(label) },
    });
    return helpers.commitSession({ sessionId });
  }

  it('rejects a revert: H1 → H2 → H1 leaves ACTIVE on H2 (canonical regression)', async () => {
    const slug = `${PREFIX}canonical`;
    await publishOne(slug, 'H1');
    await publishOne(slug, 'H2');
    const v3 = await publishOne(slug, 'H1');

    expect(v3.rejectedReverts).toContain(slug);

    const { ContentManifest, ContentFiles } = cds.entities(NS);
    const active = await SELECT.one.from(ContentManifest).where({ status: 'ACTIVE' });
    const row = await SELECT.one.from(ContentFiles).where({ slug, version: active.version });
    expect(row.sourceHash, 'ACTIVE row should still hold H2').toBe(sha256('H2'));
  });

  it('initiator round-trips through real HANA wire to ContentManifest + PipelineLog', async () => {
    const slug = `${PREFIX}initiator`;
    const result = await publishOne(slug, 'X', '__TEST__bob@laptop');

    const { ContentManifest, PipelineLog } = cds.entities(NS);
    const manifest = await SELECT.one.from(ContentManifest).where({ version: result.version });
    expect(manifest.initiator).toBe('__TEST__bob@laptop');

    const log = await SELECT.one.from(PipelineLog).where({ ID: manifest.sessionId });
    expect(log.initiator).toBe('__TEST__bob@laptop');
  });
});
