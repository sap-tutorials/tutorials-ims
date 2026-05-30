import cds from '@sap/cds';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { gzipSync } from 'node:zlib';
import { createSessionHelpers } from '../../srv/lib/content-publish-session.js';
import { isSafeForWrites } from './_guard.js';

const NS = 'com.sap.developers.ims';
const PREFIX = '__TEST__chunked-';

describe('content publish chunked — HANA', () => {
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
    const { ContentFiles, ContentManifest } = cds.entities(NS);
    const stale = await SELECT.from(ContentManifest).where`status = 'PUBLISHING' or status = 'FAILED'`;
    if (stale.length) {
      await DELETE.from(ContentFiles).where({ version: { in: stale.map(r => r.version) } });
      await DELETE.from(ContentManifest).where({ version: { in: stale.map(r => r.version) } });
    }
    // Also clean any test slugs that leaked into ACTIVE during a failed test.
    await DELETE.from(ContentFiles).where({ slug: { like: `${PREFIX}%` } });
  });

  it('runs begin → 3 parallel appends → commit and produces an ACTIVE manifest', async () => {
    const { ContentFiles, ContentManifest } = cds.entities(NS);

    const begin = await helpers.beginPublishSession({
      trigger: 'hybrid-test', hugoVersion: 'test', expectedSlugCount: 9
    });

    const html = (slug) => `<html><body><main class="tutorial-main">${slug}</main></body></html>`;
    const buildBatch = (slugs) => ({
      sessionId: begin.sessionId,
      files: Object.fromEntries(slugs.map(s => [s, gzipSync(Buffer.from(html(s))).toString('base64')])),
      metadata: {}, bodyTexts: {},
    });

    const slugBatches = [
      [`${PREFIX}a1`, `${PREFIX}a2`, `${PREFIX}a3`],
      [`${PREFIX}b1`, `${PREFIX}b2`, `${PREFIX}b3`],
      [`${PREFIX}c1`, `${PREFIX}c2`, `${PREFIX}c3`],
    ];

    await Promise.all(slugBatches.map(b => helpers.appendToSession(buildBatch(b))));

    const result = await helpers.commitSession({ sessionId: begin.sessionId });
    expect(result.version).toBe(begin.version);

    const manifest = await SELECT.one.from(ContentManifest).where({ version: begin.version });
    expect(manifest.status).toBe('ACTIVE');

    const writtenCount = await SELECT.one.from(ContentFiles)
      .columns('count(*) as c')
      .where({ version: begin.version, slug: { like: `${PREFIX}%` } });
    expect(writtenCount.c).toBe(9);
  });

  it('abort marks the manifest FAILED and releases the lock', async () => {
    const { ContentManifest } = cds.entities(NS);

    const begin = await helpers.beginPublishSession({
      trigger: 'hybrid-abort', hugoVersion: 'test', expectedSlugCount: 0
    });
    await helpers.abortSession({ sessionId: begin.sessionId, reason: 'hybrid-test' });

    const row = await SELECT.one.from(ContentManifest).where({ version: begin.version });
    expect(row.status).toBe('FAILED');

    // Lock is free → another begin works.
    const next = await helpers.beginPublishSession({
      trigger: 'hybrid-after-abort', hugoVersion: 'test', expectedSlugCount: 0
    });
    expect(next.sessionId).not.toBe(begin.sessionId);
    await helpers.abortSession({ sessionId: next.sessionId, reason: 'cleanup' });
  });

  it('idempotent commit returns alreadyActive=true on second call', async () => {
    const begin = await helpers.beginPublishSession({
      trigger: 'hybrid-idempotent', hugoVersion: 'test', expectedSlugCount: 0
    });
    const first = await helpers.commitSession({ sessionId: begin.sessionId });
    const second = await helpers.commitSession({ sessionId: begin.sessionId });
    expect(first.version).toBe(second.version);
    expect(second.alreadyActive).toBe(true);
  });
});
