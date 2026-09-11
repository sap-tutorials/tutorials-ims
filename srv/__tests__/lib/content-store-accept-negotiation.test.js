import cds from '@sap/cds';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { gzipSync } from 'node:zlib';
import { serveHandler } from '../../lib/content-store.js';

const NS = 'com.sap.developers.ims';

function makeReq(slug, accept) {
  return {
    url: `/content/tutorials/${slug}`,
    params: { slug },
    headers: {
      host: 'developers.sap.com',
      'x-forwarded-proto': 'https',
      ...(accept != null ? { accept } : {}),
    },
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

async function seed(slug, { html = '<html><body>HTML content</body></html>', markdown = '---\ntitle: Demo\n---\n\n# Heading\n' } = {}) {
  const { ContentManifest, ContentFiles, Tutorials } = cds.entities(NS);
  await INSERT.into(ContentManifest).entries({
    version: 1, status: 'ACTIVE', activatedAt: new Date().toISOString(),
  });
  await INSERT.into(ContentFiles).entries({
    slug, version: 1,
    content: gzipSync(Buffer.from(html)),
    sourceContent: gzipSync(Buffer.from(markdown)),
    contentHash: 'h', sourceHash: 's',
    mimeType: 'text/html', sizeBytes: html.length,
  });
  await INSERT.into(Tutorials).entries({
    ID: cds.utils.uuid(), slug, title: 'Demo', status: 'ACTIVE',
  });
}

describe('serveHandler Accept negotiation', () => {
  beforeAll(async () => { await cds.connect.to('db'); });

  beforeEach(async () => {
    const { ContentManifest, ContentFiles, Tutorials } = cds.entities(NS);
    await DELETE.from(ContentFiles);
    await DELETE.from(ContentManifest);
    await DELETE.from(Tutorials);
  });

  it('serves markdown when Accept prefers text/markdown', async () => {
    await seed('neg-md-slug');
    const res = makeRes();
    await serveHandler(makeReq('neg-md-slug', 'text/markdown'), res);

    expect(res._status).toBe(200);
    expect(res._headers['Content-Type']).toMatch(/text\/markdown/);
    expect(res._headers['Vary']).toMatch(/Accept/);
    const body = res._body?.toString?.() ?? '';
    expect(body).toContain('# Heading');
    expect(body).toContain('slug: neg-md-slug');
  });

  it('serves HTML for a browser Accept header and still sets Vary: Accept', async () => {
    await seed('neg-html-slug');
    const res = makeRes();
    await serveHandler(makeReq('neg-html-slug', 'text/html,application/xhtml+xml,*/*;q=0.8'), res);

    expect(res._status).toBe(200);
    expect(res._headers['Content-Type']).toMatch(/text\/html/);
    expect(res._headers['Vary']).toMatch(/Accept/);
    const body = res._body?.toString?.() ?? '';
    expect(body).toContain('HTML content');
  });

  it('does NOT negotiate markdown for non-tutorial slugs (concept-*)', async () => {
    await seed('concept-foo');
    const res = makeRes();
    await serveHandler(makeReq('concept-foo', 'text/markdown'), res);

    expect(res._status).toBe(200);
    expect(res._headers['Content-Type']).toMatch(/text\/html/);
    const body = res._body?.toString?.() ?? '';
    expect(body).toContain('HTML content');
  });
});
