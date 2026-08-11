// test/unit/page-serve-handler.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

// In-memory CAP bootstrap (the repo-standard pattern; bare cds.deploy is broken here).
const test = cds.test('serve', '--project', '.', '--in-memory');

const NS = 'com.sap.developers.ims';

async function seedPage(key, html, mimeType = 'text/html') {
  const db = await cds.connect.to('db');
  const { ContentFiles, ContentManifest } = cds.entities(NS);
  const gz = gzipSync(Buffer.from(html));
  const hash = createHash('sha256').update(html).digest('hex');
  await db.run(INSERT.into(ContentManifest).entries({
    version: 1, status: 'ACTIVE', fileCount: 1, changedSlugs: JSON.stringify([key]),
  }));
  await db.run(INSERT.into(ContentFiles).entries({
    slug: key, version: 1, content: gz, contentHash: hash,
    mimeType, sizeBytes: html.length, compressedBytes: gz.length,
  }));
}

describe('pageServeHandler', () => {
  let pageServeHandler;
  beforeAll(async () => {
    ({ pageServeHandler } = await import('../../srv/lib/content-store.js'));
    await seedPage('page-browse', '<!doctype html><title>Browse</title>');
  });

  function mockReqRes(path) {
    const req = { path, url: path, headers: {} };
    const res = {
      statusCode: 200, headers: {}, body: null,
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      status(c) { this.statusCode = c; return this; },
      send(b) { this.body = b; return this; },
      end(b) { if (b) this.body = b; return this; },
    };
    return { req, res };
  }

  it('serves a stored page BLOB with content + edge headers', async () => {
    const { req, res } = mockReqRes('/content/pages/browse/');
    await pageServeHandler(req, res);
    expect(res.statusCode).toBe(200);
    expect(String(res.body)).toContain('Browse');
    expect(res.headers['cache-control']).toContain('s-maxage=86400');
    expect(res.headers['edge-cache-tag']).toContain('page-browse');
  });

  it('404s an out-of-scope page path (fail-open, short TTL)', async () => {
    const { req, res } = mockReqRes('/content/pages/not-a-page/');
    await pageServeHandler(req, res);
    expect(res.statusCode).toBe(404);
    expect(res.headers['cache-control']).toContain('max-age=60');
  });

  it('404s an in-scope page that has not been published yet', async () => {
    const { req, res } = mockReqRes('/content/pages/topics/');
    await pageServeHandler(req, res);
    expect(res.statusCode).toBe(404);
  });
});
