// test/unit/content-delta-read.test.js
//
// Workstream D (slug-targeted-delta-rebuild) — Option B read cutover guard.
//
// serveStoredSlug serves from the mutable ContentCurrent when the
// content.delta.read ImsConfig flag is 'true' AND the slug exists there, else
// falls back to the legacy version-pinned ContentFiles snapshot. This keeps a
// partially-populated ContentCurrent (mid-migration) from 404-ing slugs still in
// ContentFiles. X-Content-Source distinguishes the path: 'db-current' vs 'db'.
//
// The flags moved from process.env.* to ImsConfig (DB-driven config); the tests
// seed the ImsConfig row and warm the cached getter via refreshContentDeltaFlags().

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import cds from '@sap/cds';
import { gzipSync } from 'node:zlib';
import { createSessionHelpers } from '../../srv/lib/content-publish-session.js';
import { createContentHandlers } from '../../srv/lib/content-store.js';
import {
  refreshContentDeltaFlags, bustContentDeltaFlagsCache, DELTA_WRITE_KEY, DELTA_READ_KEY,
} from '../../srv/lib/content-delta-flags.js';

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

describe('Option B read cutover (Workstream D)', () => {
  let helpers, serveHandler, rollbackHandler;
  let ContentFiles, ContentManifest, ContentCurrent, ContentHistory, PipelineLog, JobLocks, ImsConfig;

  // Upsert a content.delta.* ImsConfig flag then warm the cached getter so the
  // synchronous getters in content-store.js observe the new value.
  async function setDelta(key, on) {
    const value = String(Boolean(on));
    const existing = await SELECT.one.from(ImsConfig).where({ key });
    if (existing) await UPDATE(ImsConfig, existing.ID).set({ value });
    else await INSERT.into(ImsConfig).entries({ key, value });
    await refreshContentDeltaFlags();
  }

  async function publish(slug, body, { dualWrite }) {
    await setDelta(DELTA_WRITE_KEY, dualWrite);
    const s = await helpers.beginPublishSession({ trigger: 'ci/test', expectedSlugCount: 1, initiator: 'test' });
    await helpers.appendToSession({ sessionId: s.sessionId, files: { [slug]: html(body) }, sources: { [slug]: source(body) } });
    const res = await helpers.commitSession({ sessionId: s.sessionId });
    return res.version;
  }

  beforeAll(() => {
    helpers = createSessionHelpers({ namespace: NS });
    ({ serveHandler, rollbackHandler } = createContentHandlers());
    ({ ContentFiles, ContentManifest, ContentCurrent, ContentHistory, PipelineLog, JobLocks, ImsConfig } = cds.entities(NS));
  });
  afterAll(() => { bustContentDeltaFlagsCache(); });
  beforeEach(async () => {
    for (const e of [ContentFiles, ContentManifest, ContentCurrent, ContentHistory, PipelineLog, JobLocks]) await DELETE.from(e);
    await DELETE.from(ImsConfig).where({ key: { in: [DELTA_WRITE_KEY, DELTA_READ_KEY] } });
    bustContentDeltaFlagsCache();
  });

  async function serve(slug) {
    const res = makeRes();
    await serveHandler({ params: { slug }, url: `/content/tutorials/${slug}`, headers: {} }, res);
    return res;
  }

  it('serves from ContentCurrent when read flag ON and slug is present', async () => {
    await publish('alpha', 'A', { dualWrite: true });
    await setDelta(DELTA_READ_KEY, true);
    const res = await serve('alpha');
    expect(res._headers['X-Content-Source']).toBe('db-current');
    expect(gunzipOrText(res._body)).toContain('A');
  });

  it('falls back to ContentFiles when slug is NOT in ContentCurrent (mid-migration)', async () => {
    await publish('beta', 'B', { dualWrite: false }); // ContentFiles only
    await setDelta(DELTA_READ_KEY, true);
    expect((await SELECT.from(ContentCurrent).where({ slug: 'beta' })).length).toBe(0);
    const res = await serve('beta');
    expect(res._headers['X-Content-Source']).toBe('db');
    expect(gunzipOrText(res._body)).toContain('B');
  });

  it('uses legacy ContentFiles when read flag is OFF even if slug is in ContentCurrent', async () => {
    await publish('gamma', 'G', { dualWrite: true });
    await setDelta(DELTA_READ_KEY, false);
    expect((await SELECT.from(ContentCurrent).where({ slug: 'gamma' })).length).toBe(1);
    const res = await serve('gamma');
    expect(res._headers['X-Content-Source']).toBe('db');
    expect(gunzipOrText(res._body)).toContain('G');
  });

  it('rollback clears ContentCurrent so reads fall back to the restored ContentFiles(V)', async () => {
    const v1 = await publish('delta', 'D1', { dualWrite: true }); // version 1
    await publish('delta', 'D2', { dualWrite: true });            // version 2 (active)
    expect((await SELECT.from(ContentCurrent).where({ slug: 'delta' })).length).toBe(1);

    const rb = makeRes();
    await rollbackHandler({ body: { targetVersion: v1 } }, rb);
    expect(rb._body.rolledBackTo).toBe(v1);
    // ContentCurrent cleared → reads fall back to ContentFiles(active=v1)=D1.
    expect((await SELECT.from(ContentCurrent)).length).toBe(0);

    await setDelta(DELTA_READ_KEY, true);
    const s = await serve('delta');
    expect(s._headers['X-Content-Source']).toBe('db');
    expect(gunzipOrText(s._body)).toContain('D1');
  });
});

function gunzipOrText(body) {
  if (Buffer.isBuffer(body)) return body.toString('utf-8');
  return String(body ?? '');
}
