import cds from '@sap/cds';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { gzipSync } from 'node:zlib';
import { markdownServeHandler } from '../../lib/content-store.js';

const NS = 'com.sap.developers.ims';

function makeMdReq(slug, headers = {}) {
  return {
    url: `/content/tutorials/${slug}.md`,
    params: { slug },
    headers: { host: 'developers.sap.com', 'x-forwarded-proto': 'https', ...headers },
    get(k) { return this.headers[k.toLowerCase()]; },
  };
}
function makeRes() {
  return {
    _status: 200, _headers: {}, _body: null,
    status(code) { this._status = code; return this; },
    setHeader(k, v) { this._headers[k] = v; },
    send(b) { this._body = b; return this; },
    json(b) { this._body = b; return this; },
    end() { return this; },
  };
}

cds.test('serve', '--project', '.', '--in-memory');

async function seedTutorial(slug, markdown, { html = '<html><body>x</body></html>' } = {}) {
  const { ContentManifest, ContentFiles, Tutorials } = cds.entities(NS);
  const version = 1;
  await INSERT.into(ContentManifest).entries({
    version, status: 'ACTIVE', activatedAt: new Date().toISOString(),
  });
  await INSERT.into(ContentFiles).entries({
    slug, version,
    content: gzipSync(Buffer.from(html)),
    sourceContent: gzipSync(Buffer.from(markdown)),
    contentHash: 'h', sourceHash: 's',
    mimeType: 'text/html', sizeBytes: html.length,
  });
  await INSERT.into(Tutorials).entries({
    ID: cds.utils.uuid(), slug, title: 'Demo', status: 'ACTIVE',
  });
}

describe('markdownServeHandler', () => {
  beforeAll(async () => { await cds.connect.to('db'); });

  beforeEach(async () => {
    const { ContentManifest, ContentFiles, Tutorials } = cds.entities(NS);
    await DELETE.from(ContentFiles);
    await DELETE.from(ContentManifest);
    await DELETE.from(Tutorials);
  });

  it('serves normalized source markdown as text/markdown with 200', async () => {
    const md = ['---', 'title: Demo Tutorial', '---', '', '# Heading', '', 'Body prose.'].join('\n');
    await seedTutorial('demo-slug', md);

    const res = makeRes();
    await markdownServeHandler(makeMdReq('demo-slug'), res);

    expect(res._status).toBe(200);
    expect(res._headers['Content-Type']).toMatch(/text\/markdown/);
    const body = res._body?.toString?.() ?? '';
    expect(body).toContain('# Heading');
    expect(body).toContain('Body prose.');
    expect(body).toContain('title: Demo Tutorial');
    expect(body).toContain('slug: demo-slug');
    expect(body).toContain('canonical_url: https://developers.sap.com/tutorials/demo-slug');
  });

  it('404s for a slug with no captured source markdown', async () => {
    const res = makeRes();
    await markdownServeHandler(makeMdReq('never-published'), res);
    expect(res._status).toBe(404);
  });

  it('tolerates a trailing .md in the slug param', async () => {
    await seedTutorial('demo-slug', '---\ntitle: T\n---\n\nx');
    const res = makeRes();
    await markdownServeHandler(makeMdReq('demo-slug.md'), res);
    expect(res._status).toBe(200);
    expect((res._body?.toString?.() ?? '')).toContain('slug: demo-slug');
  });
});
