import cds from '@sap/cds';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { gzipSync } from 'node:zlib';
import {
  beginHandler, appendHandler, commitHandler, abortHandler
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
    const { ContentManifest, ContentFiles, JobLocks } = cds.entities(NS);
    await DELETE.from(ContentFiles);
    await DELETE.from(ContentManifest);
    await DELETE.from(JobLocks);
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
});
