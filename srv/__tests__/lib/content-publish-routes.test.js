import cds from '@sap/cds';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { gzipSync } from 'node:zlib';
import {
  beginHandler, appendHandler, commitHandler, abortHandler,
  publishHandler
} from '../../lib/content-store.js';

const NS = 'com.sap.developers.ims';

function makeReq(body = {}, headers = {}) {
  return { body, headers, get(k) { return this.headers[k.toLowerCase()]; } };
}
function makeRes() {
  const res = {
    _status: null, _body: null, _headers: {},
    status(code) { this._status = code; return this; },
    json(body)   { this._body = body; return this; },
    setHeader(k, v) { this._headers[k] = v; }
  };
  return res;
}

cds.test('serve', '--project', '.', '--in-memory');

describe('content publish routes', () => {
  beforeAll(async () => {
    await cds.connect.to('db');
    process.env.CONTENT_API_KEY = 'test-key';
  });

  beforeEach(async () => {
    const { ContentManifest, ContentFiles, JobLocks, Tutorials, Steps } = cds.entities(NS);
    await DELETE.from(ContentFiles);
    await DELETE.from(ContentManifest);
    await DELETE.from(JobLocks);
    await DELETE.from(Steps);
    await DELETE.from(Tutorials);
  });

  it('begin → append → commit produces an ACTIVE manifest', async () => {
    const beginReq = makeReq(
      { trigger: 'route-test', hugoVersion: 'v1', expectedSlugCount: 1 },
      { authorization: 'Bearer test-key' }
    );
    const beginRes = makeRes();
    await beginHandler(beginReq, beginRes);
    expect(beginRes._status).toBe(201);
    expect(beginRes._body.sessionId).toMatch(/^[0-9a-f-]{36}$/);

    const html = '<html><body><main class="tutorial-main">x</main></body></html>';
    const appendReq = makeReq(
      {
        sessionId: beginRes._body.sessionId,
        files: { 'route-demo': gzipSync(Buffer.from(html)).toString('base64') },
        metadata: {}, bodyTexts: {}
      },
      { authorization: 'Bearer test-key' }
    );
    const appendRes = makeRes();
    await appendHandler(appendReq, appendRes);
    expect(appendRes._status).toBe(202);
    expect(appendRes._body.slugsAccepted).toBe(1);

    const commitReq = makeReq(
      { sessionId: beginRes._body.sessionId },
      { authorization: 'Bearer test-key' }
    );
    const commitRes = makeRes();
    await commitHandler(commitReq, commitRes);
    expect(commitRes._status).toBe(200);
    expect(commitRes._body.version).toBe(beginRes._body.version);

    const { ContentManifest } = cds.entities(NS);
    const row = await SELECT.one.from(ContentManifest).where({ version: beginRes._body.version });
    expect(row.status).toBe('ACTIVE');
  });

  it('append missing sessionId returns 400', async () => {
    const req = makeReq({}, { authorization: 'Bearer test-key' });
    const res = makeRes();
    await appendHandler(req, res);
    expect(res._status).toBe(400);
  });

  it('abort marks the manifest FAILED', async () => {
    const beginReq = makeReq(
      { trigger: 'abort-test', hugoVersion: 'v1', expectedSlugCount: 0 },
      { authorization: 'Bearer test-key' }
    );
    const beginRes = makeRes();
    await beginHandler(beginReq, beginRes);

    const abortReq = makeReq(
      { sessionId: beginRes._body.sessionId, reason: 'test' },
      { authorization: 'Bearer test-key' }
    );
    const abortRes = makeRes();
    await abortHandler(abortReq, abortRes);
    expect(abortRes._status).toBe(200);
    expect(abortRes._body.aborted).toBe(true);

    const { ContentManifest } = cds.entities(NS);
    const row = await SELECT.one.from(ContentManifest).where({ version: beginRes._body.version });
    expect(row.status).toBe('FAILED');
  });

  it('legacy publishHandler matches existing Tutorials row case-insensitively', async () => {
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

    const html = '<html><body><main class="tutorial-main">x</main></body></html>';
    const req = makeReq(
      {
        trigger: 'legacy-test',
        hugoVersion: 'v1',
        files: {
          'abap-environment-sbpa-workflow-extend-rap-app': gzipSync(Buffer.from(html)).toString('base64'),
        },
        metadata: {
          'abap-environment-sbpa-workflow-extend-rap-app': {
            title: 'Updated via legacy path',
            steps: [
              { number: 1, title: 'Step 1' },
              { number: 2, title: 'Step 2' },
              { number: 3, title: 'Step 3' },
              { number: 4, title: 'Step 4' },
            ],
          },
        },
        bodyTexts: {},
      },
      { authorization: 'Bearer test-key' }
    );
    const res = makeRes();
    await publishHandler(req, res);
    expect(res._status).toBe(201);

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
    expect(rows[0].title).toBe('Updated via legacy path');
    // Regression net: the publisher must NOT rename the slug to lowercase.
    // Mixed-case canonical rows are kept as-is so the repair script can resolve
    // duplicate pairs. See plan 2026-05-31-mixed-case-slug-stepcount.md.
    expect(rows[0].slug).toBe('abap-environment-sbpa-workflow-extend-RAP-App');
  });
});
