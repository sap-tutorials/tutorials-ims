// test/unit/page-serve-handler.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

// In-memory CAP bootstrap (the repo-standard pattern; bare cds.deploy is broken here).
const test = cds.test('serve', '--project', '.', '--in-memory');

const NS = 'com.sap.developers.ims';

// Seed a content page: inserts ContentManifest (version 1) + ContentFiles row.
// Use only once per test suite — subsequent rows share the same manifest version.
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

// Seed an additional ContentFiles row into the existing version 1 manifest.
// Strings are gzip-compressed (normal content path).
// Buffers are stored raw — pass a non-gzip Buffer to trigger a serve-time error.
async function seedContent(key, content, mimeType = 'text/html') {
  const db = await cds.connect.to('db');
  const { ContentFiles } = cds.entities(NS);
  const isRawBuffer = Buffer.isBuffer(content);
  const gz = isRawBuffer ? content : gzipSync(Buffer.from(content));
  const src = isRawBuffer ? content : Buffer.from(content);
  const hash = createHash('sha256').update(src).digest('hex');
  await db.run(INSERT.into(ContentFiles).entries({
    slug: key, version: 1, content: gz, contentHash: hash,
    mimeType, sizeBytes: src.length, compressedBytes: gz.length,
  }));
}

describe('pageServeHandler', () => {
  let pageServeHandler;
  beforeAll(async () => {
    ({ pageServeHandler } = await import('../../srv/lib/content-store.js'));
    // Seed the primary page and the styled __404__ page so serveNotFound
    // serves the HTML 404 page (and sets Cache-Control: public, max-age=60)
    // rather than falling back to res.json().
    await seedPage('page-browse', '<!doctype html><title>Browse</title>');
    await seedContent('__404__', '<!doctype html><title>Not Found</title>');
  });

  function mockReqRes(path) {
    const req = { path, url: path, headers: {} };
    const res = {
      statusCode: 200, headers: {}, body: null,
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      status(c) { this.statusCode = c; return this; },
      send(b) { this.body = b; return this; },
      end(b) { if (b) this.body = b; return this; },
      json(b) { this.body = JSON.stringify(b); return this; },
    };
    return { req, res };
  }

  it('serves a stored page BLOB with content + edge headers', async () => {
    const { req, res } = mockReqRes('/content/pages/browse/');
    await pageServeHandler(req, res);
    expect(res.statusCode).toBe(200);
    expect(String(res.body)).toContain('Browse');
    expect(res.headers['cache-control']).toContain('s-maxage=600');
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

  describe('catch-path 503 (fail-open on serve error)', () => {
    beforeAll(async () => {
      // Seed an in-scope page with corrupt (non-gzip) bytes so gunzipSync
      // throws inside serveStoredSlug, exercising the pageServeHandler catch path.
      await seedContent('page-devtoberfest', Buffer.from('not-valid-gzip-data'));
    });

    it('returns 503 with short TTL when serveStoredSlug throws', async () => {
      const { req, res } = mockReqRes('/content/pages/devtoberfest/');
      await pageServeHandler(req, res);
      expect(res.statusCode).toBe(503);
      expect(res.headers['cache-control']).toContain('max-age=60');
    });
  });
});
