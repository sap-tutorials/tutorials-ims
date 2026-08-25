// test/unit/content-delta-read.test.js
//
// Workstream D (slug-targeted-delta-rebuild) — Option B read cutover guard.
//
// serveStoredSlug serves from the mutable ContentCurrent when
// CONTENT_DELTA_READ_ENABLED=true AND the slug exists there, else falls back to
// the legacy version-pinned ContentFiles snapshot. This keeps a partially-
// populated ContentCurrent (mid-migration) from 404-ing slugs still in
// ContentFiles. X-Content-Source distinguishes the path: 'db-current' vs 'db'.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import cds from '@sap/cds';
import { gzipSync } from 'node:zlib';
import { createSessionHelpers } from '../../srv/lib/content-publish-session.js';
import { createContentHandlers } from '../../srv/lib/content-store.js';

const NS = 'com.sap.developers.ims';
cds.test('serve', '--project', '.', '--in-memory');

function html(s) { return gzipSync(Buffer.from(`<html><body><main class="tutorial-main">${s}</main></body></html>`, 'utf-8')).toString('base64'); }
function source(s) { return gzipSync(Buffer.from(s, 'utf-8')).toString('base64'); }
function makeRes() {
  return {
    _status: null, _headers: {}, _body: null,
    status(c) { this._status = c; return this; },
    setHeader(k, v) { this._headers[k] = v; },
    json(b) { this._body = b; return this; },
    send(b) { this._body = b; return this; },
    end() { return this; },
  };
}
async function publish(helpers, slug, body, { dualWrite }) {
  const prev = process.env.CONTENT_DELTA_WRITE_ENABLED;
  process.env.CONTENT_DELTA_WRITE_ENABLED = dualWrite ? 'true' : 'false';
  try {
    const s = await helpers.beginPublishSession({ trigger: 'ci/test', expectedSlugCount: 1, initiator: 'test' });
    await helpers.appendToSession({ sessionId: s.sessionId, files: { [slug]: html(body) }, sources: { [slug]: source(body) } });
    await helpers.commitSession({ sessionId: s.sessionId });
  } finally {
    if (prev === undefined) delete process.env.CONTENT_DELTA_WRITE_ENABLED;
    else process.env.CONTENT_DELTA_WRITE_ENABLED = prev;
  }
}

describe('Option B read cutover (Workstream D)', () => {
  let helpers, serveHandler;
  let ContentFiles, ContentManifest, ContentCurrent, ContentHistory, PipelineLog, JobLocks;
  const prevRead = process.env.CONTENT_DELTA_READ_ENABLED;

  beforeAll(() => {
    helpers = createSessionHelpers({ namespace: NS });
    ({ serveHandler } = createContentHandlers());
    ({ ContentFiles, ContentManifest, ContentCurrent, ContentHistory, PipelineLog, JobLocks } = cds.entities(NS));
  });
  afterAll(() => {
    if (prevRead === undefined) delete process.env.CONTENT_DELTA_READ_ENABLED;
    else process.env.CONTENT_DELTA_READ_ENABLED = prevRead;
  });
  beforeEach(async () => {
    for (const e of [ContentFiles, ContentManifest, ContentCurrent, ContentHistory, PipelineLog, JobLocks]) await DELETE.from(e);
  });

  async function serve(slug) {
    const res = makeRes();
    await serveHandler({ params: { slug }, url: `/content/tutorials/${slug}`, headers: {} }, res);
    return res;
  }

  it('serves from ContentCurrent when read flag ON and slug is present', async () => {
    await publish(helpers, 'alpha', 'A', { dualWrite: true });
    process.env.CONTENT_DELTA_READ_ENABLED = 'true';
    const res = await serve('alpha');
    expect(res._headers['X-Content-Source']).toBe('db-current');
    expect(gunzipOrText(res._body)).toContain('A');
  });

  it('falls back to ContentFiles when slug is NOT in ContentCurrent (mid-migration)', async () => {
    await publish(helpers, 'beta', 'B', { dualWrite: false }); // ContentFiles only
    process.env.CONTENT_DELTA_READ_ENABLED = 'true';
    expect((await SELECT.from(ContentCurrent).where({ slug: 'beta' })).length).toBe(0);
    const res = await serve('beta');
    expect(res._headers['X-Content-Source']).toBe('db');
    expect(gunzipOrText(res._body)).toContain('B');
  });

  it('uses legacy ContentFiles when read flag is OFF even if slug is in ContentCurrent', async () => {
    await publish(helpers, 'gamma', 'G', { dualWrite: true });
    process.env.CONTENT_DELTA_READ_ENABLED = 'false';
    expect((await SELECT.from(ContentCurrent).where({ slug: 'gamma' })).length).toBe(1);
    const res = await serve('gamma');
    expect(res._headers['X-Content-Source']).toBe('db');
    expect(gunzipOrText(res._body)).toContain('G');
  });
});

function gunzipOrText(body) {
  if (Buffer.isBuffer(body)) return body.toString('utf-8');
  return String(body ?? '');
}
