// test/unit/content-delta-carryforward-skip.test.js
//
// Workstream D 8.4 — the payoff step: with CONTENT_DELTA_SKIP_CARRYFORWARD on,
// a publish writes ONLY the changed slugs to ContentFiles (no O(corpus) carry-
// forward); ContentCurrent (mutable) stays complete via dual-write; and rollback
// replays ContentHistory into ContentCurrent to restore the exact prior state.
//
// This is the safety-critical path — it asserts (a) publish is O(changed),
// (b) serving stays complete from ContentCurrent, and (c) rollback restores the
// byte-correct state across multiple versions.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import cds from '@sap/cds';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createSessionHelpers } from '../../srv/lib/content-publish-session.js';
import { createContentHandlers, invalidateContentCache } from '../../srv/lib/content-store.js';
import {
  refreshContentDeltaFlags, bustContentDeltaFlagsCache,
  DELTA_WRITE_KEY, DELTA_READ_KEY, DELTA_SKIP_CARRYFORWARD_KEY,
} from '../../srv/lib/content-delta-flags.js';

const NS = 'com.sap.developers.ims';
cds.test('serve', '--project', '.', '--in-memory');

const html = (s) => gzipSync(Buffer.from(`<html><body><main class="tutorial-main">${s}</main></body></html>`, 'utf-8')).toString('base64');
const src = (s) => gzipSync(Buffer.from(s, 'utf-8')).toString('base64');
function makeRes() {
  return { _status: null, _headers: {}, _body: null,
    status(c) { this._status = c; return this; }, setHeader(k, v) { this._headers[k] = v; },
    json(b) { this._body = b; return this; }, send(b) { this._body = b; return this; }, end() { return this; } };
}

describe('Option B carry-forward skip + rollback replay (Workstream D 8.4)', () => {
  let helpers, serveHandler, rollbackHandler;
  let ContentFiles, ContentManifest, ContentCurrent, ContentHistory, PipelineLog, JobLocks, ImsConfig;
  const DELTA_KEYS = [DELTA_WRITE_KEY, DELTA_READ_KEY, DELTA_SKIP_CARRYFORWARD_KEY];

  // All three delta flags ON for this suite. Seed ImsConfig then warm the cache.
  async function enableAllDeltaFlags() {
    for (const key of DELTA_KEYS) {
      const existing = await SELECT.one.from(ImsConfig).where({ key });
      if (existing) await UPDATE(ImsConfig, existing.ID).set({ value: 'true' });
      else await INSERT.into(ImsConfig).entries({ key, value: 'true' });
    }
    await refreshContentDeltaFlags();
  }

  beforeAll(() => {
    helpers = createSessionHelpers({ namespace: NS });
    ({ ContentFiles, ContentManifest, ContentCurrent, ContentHistory, PipelineLog, JobLocks, ImsConfig } = cds.entities(NS));
  });
  afterAll(() => { bustContentDeltaFlagsCache(); });
  beforeEach(async () => {
    for (const e of [ContentFiles, ContentManifest, ContentCurrent, ContentHistory, PipelineLog, JobLocks]) await DELETE.from(e);
    await DELETE.from(ImsConfig).where({ key: { in: DELTA_KEYS } });
    bustContentDeltaFlagsCache();
    await enableAllDeltaFlags();
    // Fresh handlers per test → fresh in-memory content cache (in prod a publish
    // busts it via the cache-generation token; the test calls commitSession directly).
    ({ serveHandler, rollbackHandler } = createContentHandlers());
  });

  async function publish(files) {
    const slugs = Object.keys(files);
    const s = await helpers.beginPublishSession({ trigger: 'ci/test', expectedSlugCount: slugs.length, initiator: 'test' });
    const payload = {}, sources = {};
    for (const [slug, body] of Object.entries(files)) { payload[slug] = html(body); sources[slug] = src(body); }
    await helpers.appendToSession({ sessionId: s.sessionId, files: payload, sources });
    const version = (await helpers.commitSession({ sessionId: s.sessionId })).version;
    invalidateContentCache(); // prod busts via cache-generation token on publish
    return version;
  }
  async function serveBody(slug) {
    const res = makeRes();
    await serveHandler({ params: { slug }, url: `/content/tutorials/${slug}`, headers: {} }, res);
    return Buffer.isBuffer(res._body) ? res._body.toString('utf-8') : String(res._body ?? '');
  }

  it('publish is O(changed): ContentFiles(version) holds only changed slugs, ContentCurrent stays complete', async () => {
    const v1 = await publish({ a: 'A1', b: 'B1', c: 'C1' });
    const v2 = await publish({ a: 'A2' });

    // Carry-forward skipped → ContentFiles(v2) has ONLY 'a'.
    const v2files = (await SELECT.from(ContentFiles).columns('slug').where({ version: v2 })).map(r => r.slug).sort();
    expect(v2files).toEqual(['a']);
    // ...but ContentCurrent stays complete (a updated, b/c intact).
    const cur = (await SELECT.from(ContentCurrent).columns('slug')).map(r => r.slug).sort();
    expect(cur).toEqual(['a', 'b', 'c']);

    // Serving is complete from ContentCurrent.
    expect(await serveBody('a')).toContain('A2');
    expect(await serveBody('b')).toContain('B1');
    expect(await serveBody('c')).toContain('C1');
    expect(v1).toBeLessThan(v2);
  });

  it('rollback replays ContentHistory into ContentCurrent — byte-correct across versions', async () => {
    const v1 = await publish({ a: 'A1', b: 'B1', c: 'C1' });
    await publish({ a: 'A2' });   // v2
    await publish({ b: 'B3' });   // v3
    // Pre-rollback current state: a=A2, b=B3, c=C1.
    expect(await serveBody('a')).toContain('A2');
    expect(await serveBody('b')).toContain('B3');

    const rb = makeRes();
    await rollbackHandler({ body: { targetVersion: v1 } }, rb);
    expect(rb._body.rolledBackTo).toBe(v1);

    // ContentCurrent replayed to the v1 state: a=A1, b=B1, c=C1.
    const cur = (await SELECT.from(ContentCurrent).columns('slug')).map(r => r.slug).sort();
    expect(cur).toEqual(['a', 'b', 'c']);
    expect(await serveBody('a')).toContain('A1');
    expect(await serveBody('b')).toContain('B1');
    expect(await serveBody('c')).toContain('C1');
  });
});
