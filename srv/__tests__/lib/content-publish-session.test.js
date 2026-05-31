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

  it('appendToSession persists files and computes a per-batch hash', async () => {
    const { ContentFiles } = cds.entities(NS);
    const { sessionId, version } = await helpers.beginPublishSession({
      trigger: 't', hugoVersion: 'v1', expectedSlugCount: 1
    });

    const html = '<html><body><main class="tutorial-main">hello</main></body></html>';
    const { gzipSync } = await import('node:zlib');
    const files = { 'demo-slug': gzipSync(Buffer.from(html)).toString('base64') };

    const result = await helpers.appendToSession({ sessionId, files, metadata: {}, bodyTexts: {} });

    expect(result.slugsAccepted).toBe(1);
    expect(result.batchHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.totalSizeBytes).toBe(html.length);

    const row = await SELECT.one.from(ContentFiles).where({ slug: 'demo-slug', version });
    expect(row.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.sizeBytes).toBe(html.length);
  });

  it('appendToSession rejects an unknown sessionId with 404', async () => {
    await expect(
      helpers.appendToSession({
        sessionId: '00000000-0000-0000-0000-000000000000',
        files: {}, metadata: {}, bodyTexts: {}
      })
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('appendToSession bumps lastAppendAt on every call', async () => {
    const { ContentManifest } = cds.entities(NS);
    const { sessionId } = await helpers.beginPublishSession({
      trigger: 't', hugoVersion: 'v1', expectedSlugCount: 0
    });
    const before = (await SELECT.one.from(ContentManifest).where({ sessionId })).lastAppendAt;

    await new Promise(r => setTimeout(r, 50));
    await helpers.appendToSession({ sessionId, files: {}, metadata: {}, bodyTexts: {} });

    const after = (await SELECT.one.from(ContentManifest).where({ sessionId })).lastAppendAt;
    expect(new Date(after).getTime()).toBeGreaterThan(new Date(before).getTime());
  });

  it('appendToSession is idempotent for (sessionId, slug): a second append with the same slugs replaces, not duplicates', async () => {
    const { ContentFiles } = cds.entities(NS);
    const { sessionId, version } = await helpers.beginPublishSession({
      trigger: 't', hugoVersion: 'v1', expectedSlugCount: 1
    });

    const { gzipSync } = await import('node:zlib');
    const html1 = '<html><body><main class="tutorial-main">v1</main></body></html>';
    const html2 = '<html><body><main class="tutorial-main">v2</main></body></html>';

    await helpers.appendToSession({
      sessionId,
      files: { 'idem-slug': gzipSync(Buffer.from(html1)).toString('base64') },
      metadata: {}, bodyTexts: {}
    });

    // Second call with the same slug (simulating a client retry after a transient error)
    // must succeed without a PK violation, and the row must reflect the second payload.
    await helpers.appendToSession({
      sessionId,
      files: { 'idem-slug': gzipSync(Buffer.from(html2)).toString('base64') },
      metadata: {}, bodyTexts: {}
    });

    const rows = await SELECT.from(ContentFiles).where({ slug: 'idem-slug', version });
    expect(rows.length).toBe(1);
    expect(rows[0].sizeBytes).toBe(html2.length);
  });

  it('commitSession flips manifest to ACTIVE and supersedes the previous version', async () => {
    const { ContentManifest } = cds.entities(NS);

    // Seed a previous ACTIVE so we can verify carry-forward and supersede.
    const prev = await helpers.beginPublishSession({ trigger: 'prev', hugoVersion: 'v1', expectedSlugCount: 0 });
    await helpers.commitSession({ sessionId: prev.sessionId });

    const next = await helpers.beginPublishSession({ trigger: 'next', hugoVersion: 'v1', expectedSlugCount: 0 });
    const result = await helpers.commitSession({ sessionId: next.sessionId });

    expect(result.version).toBe(next.version);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    const newRow = await SELECT.one.from(ContentManifest).where({ version: next.version });
    const oldRow = await SELECT.one.from(ContentManifest).where({ version: prev.version });
    expect(newRow.status).toBe('ACTIVE');
    expect(oldRow.status).toBe('SUPERSEDED');
  });

  it('commitSession is idempotent when called on an already-ACTIVE manifest', async () => {
    const { sessionId } = await helpers.beginPublishSession({ trigger: 't', hugoVersion: 'v1', expectedSlugCount: 0 });
    const first = await helpers.commitSession({ sessionId });
    const second = await helpers.commitSession({ sessionId });
    expect(second.version).toBe(first.version);
    expect(second.alreadyActive).toBe(true);
  });

  it('abortSession marks the manifest FAILED and releases the lock', async () => {
    const { ContentManifest } = cds.entities(NS);
    const { sessionId, version } = await helpers.beginPublishSession({ trigger: 't', hugoVersion: 'v1', expectedSlugCount: 0 });

    await helpers.abortSession({ sessionId, reason: 'test' });

    const row = await SELECT.one.from(ContentManifest).where({ version });
    expect(row.status).toBe('FAILED');

    // Lock released — a fresh begin should succeed.
    const next = await helpers.beginPublishSession({ trigger: 't2', hugoVersion: 'v1', expectedSlugCount: 0 });
    expect(next.sessionId).not.toBe(sessionId);
  });

  it('abortSession is idempotent when the manifest is already FAILED', async () => {
    const { sessionId } = await helpers.beginPublishSession({ trigger: 't', hugoVersion: 'v1', expectedSlugCount: 0 });
    await helpers.abortSession({ sessionId, reason: 'first' });
    await expect(helpers.abortSession({ sessionId, reason: 'second' })).resolves.toMatchObject({ aborted: true });
  });

  it('appendToSession metadata upsert matches existing Tutorials row case-insensitively', async () => {
    const { Tutorials } = cds.entities(NS);

    // Seed: a Tutorials row already exists with a MIXED-CASE slug (legacy/seed data
    // shape — the row was created when reference data was imported with the original
    // repo casing, before the lowercase-canonical rule was adopted).
    const seedId = cds.utils.uuid();
    await INSERT.into(Tutorials).entries({
      ID: seedId,
      slug: 'abap-environment-sbpa-workflow-extend-RAP-App',
      title: 'Original mixed-case row',
      stepCount: null,
      status: 'ACTIVE',
    });

    // Begin/append a publish session that includes metadata for the SAME tutorial
    // keyed by the lowercase slug Hugo produces.
    const begin = await helpers.beginPublishSession({
      trigger: 'test', hugoVersion: 'v1', expectedSlugCount: 1,
    });
    await helpers.appendToSession({
      sessionId: begin.sessionId,
      metadata: {
        'abap-environment-sbpa-workflow-extend-rap-app': {
          title: 'Updated title',
          steps: [
            { number: 1, title: 'Step 1' },
            { number: 2, title: 'Step 2' },
            { number: 3, title: 'Step 3' },
            { number: 4, title: 'Step 4' },
          ],
        },
      },
    });

    // Assertion: still exactly ONE Tutorials row for this tutorial, and the original
    // mixed-case row's stepCount is now 4 (not null/0). The publisher must NOT have
    // inserted a second lowercase row.
    const rows = await SELECT.from(Tutorials).where({
      slug: { in: [
        'abap-environment-sbpa-workflow-extend-RAP-App',
        'abap-environment-sbpa-workflow-extend-rap-app',
      ]}
    }).columns('ID', 'slug', 'stepCount', 'title');

    expect(rows).toHaveLength(1);
    expect(rows[0].ID).toBe(seedId);
    expect(rows[0].stepCount).toBe(4);
    expect(rows[0].title).toBe('Updated title');
  });
});
