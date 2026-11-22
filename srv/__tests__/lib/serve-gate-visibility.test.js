// srv/__tests__/lib/serve-gate-visibility.test.js
//
// TDD for Task 6: fail-closed serve gate for ROLE_GATED tutorials (#3099).
// Tests the four required cases:
//   (a) public route + ROLE_GATED slug → 404
//   (b) gated mount + ROLE_GATED slug → 200
//   (c) public route + UNLISTED slug → 200 (hide-only, NOT gated)
//   (d) gated-route response does NOT populate shared cache; subsequent
//       public hit still 404s (no cross-route cache leak)

import cds from '@sap/cds';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { gzipSync } from 'node:zlib';
import { serveHandler, gatedServeHandler, invalidateContentCache } from '../../lib/content-store.js';

const NS = 'com.sap.developers.ims';

function makeReq(slug) {
  return {
    url: `/content/tutorials/${slug}`,
    params: { slug },
    headers: {},
    get(k) { return this.headers[k.toLowerCase()]; },
  };
}

function makeRes() {
  return {
    _status: 200, _headers: {}, _body: null,
    status(code) { this._status = code; return this; },
    setHeader(k, v) { this._headers[k] = v; },
    getHeader(k) { return this._headers[k]; },
    send(b) { this._body = b; return this; },
    json(b) { this._body = b; return this; },
    end(b) { if (b != null) this._body = b; return this; },
  };
}

cds.test('serve', '--project', '.', '--in-memory');

async function seed(slug, { visibility = 'LISTED' } = {}) {
  const NS_ENT = cds.entities(NS);
  const { ContentManifest, ContentFiles, Tutorials } = NS_ENT;
  const html = `<html><body>Content for ${slug}</body></html>`;
  // Ensure we have an ACTIVE manifest; skip if one already exists.
  const existing = await SELECT.one.from(ContentManifest).where({ status: 'ACTIVE' });
  if (!existing) {
    await INSERT.into(ContentManifest).entries({
      version: 1, status: 'ACTIVE', activatedAt: new Date().toISOString(),
    });
  }
  await INSERT.into(ContentFiles).entries({
    slug, version: 1,
    content: gzipSync(Buffer.from(html)),
    sourceContent: gzipSync(Buffer.from(`---\ntitle: ${slug}\n---\n`)),
    contentHash: `hash-${slug}`, sourceHash: `src-${slug}`,
    mimeType: 'text/html', sizeBytes: html.length,
  });
  await INSERT.into(Tutorials).entries({
    ID: cds.utils.uuid(), slug, title: slug, status: 'ACTIVE', visibility,
  });
}

describe('serve gate: visibility enforcement', () => {
  beforeAll(async () => { await cds.connect.to('db'); });

  beforeEach(async () => {
    // Clear per-test to avoid slug collisions and stale cache entries.
    const { ContentManifest, ContentFiles, Tutorials } = cds.entities(NS);
    await DELETE.from(ContentFiles);
    await DELETE.from(ContentManifest);
    await DELETE.from(Tutorials);
    // Flush the in-process content cache between tests.
    invalidateContentCache();
  });

  // (a) public route + ROLE_GATED → 404
  it('(a) public serveHandler returns 404 for ROLE_GATED slug', async () => {
    await seed('private-tutorial', { visibility: 'ROLE_GATED' });
    const res = makeRes();
    await serveHandler(makeReq('private-tutorial'), res);
    expect(res._status).toBe(404);
  });

  // (b) gated mount + ROLE_GATED → 200
  it('(b) gatedServeHandler returns 200 for ROLE_GATED slug', async () => {
    await seed('private-tutorial-b', { visibility: 'ROLE_GATED' });
    const res = makeRes();
    await gatedServeHandler(makeReq('private-tutorial-b'), res);
    expect(res._status).toBe(200);
    const body = res._body?.toString?.() ?? '';
    expect(body).toContain('private-tutorial-b');
  });

  // (c) public route + UNLISTED → 200 (UNLISTED is hide-only, not access-gated)
  it('(c) public serveHandler returns 200 for UNLISTED slug', async () => {
    await seed('unlisted-tutorial', { visibility: 'UNLISTED' });
    const res = makeRes();
    await serveHandler(makeReq('unlisted-tutorial'), res);
    expect(res._status).toBe(200);
    const body = res._body?.toString?.() ?? '';
    expect(body).toContain('unlisted-tutorial');
  });

  // (d) no cross-route cache leak: gated hit must NOT populate the shared cache
  //     for a subsequent public request.
  it('(d) gated hit does not populate shared cache; public hit after gated hit still 404s', async () => {
    await seed('private-tutorial-d', { visibility: 'ROLE_GATED' });

    // First: gated hit (should serve 200).
    const resGated = makeRes();
    await gatedServeHandler(makeReq('private-tutorial-d'), resGated);
    expect(resGated._status).toBe(200);

    // Gated response must carry private, no-store.
    const cc = resGated._headers?.['Cache-Control'] ?? '';
    expect(cc).toMatch(/private/);
    expect(cc).toMatch(/no-store/);

    // Second: public hit on the same slug — must still 404.
    const resPub = makeRes();
    await serveHandler(makeReq('private-tutorial-d'), resPub);
    expect(resPub._status).toBe(404);
  });
});
