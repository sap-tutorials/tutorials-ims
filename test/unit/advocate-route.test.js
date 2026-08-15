// test/unit/advocate-route.test.js
// #1659 Phase C.2a — /content/developer-advocates/:slug serves an
// advocate-<slug> detail BLOB from HANA (the /developer-advocates/ INDEX is the
// separate page-developer-advocates key).
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
const test = cds.test('serve', '--project', '.', '--in-memory');
const NS = 'com.sap.developers.ims';

describe('/content/developer-advocates/:slug route', () => {
  beforeAll(async () => {
    const db = await cds.connect.to('db');
    const { ContentFiles, ContentManifest } = cds.entities(NS);
    const html = '<!doctype html><title>DJ Adams</title><main>ADVOCATE-ROUTE-TEST</main>';
    const gz = gzipSync(Buffer.from(html));
    const hash = createHash('sha256').update(html).digest('hex');
    await db.run(INSERT.into(ContentManifest).entries({
      version: 1, status: 'ACTIVE', fileCount: 1, changedSlugs: JSON.stringify(['advocate-dj-adams']),
    }));
    await db.run(INSERT.into(ContentFiles).entries({
      slug: 'advocate-dj-adams', version: 1, content: gz, contentHash: hash,
      mimeType: 'text/html', sizeBytes: html.length, compressedBytes: gz.length,
    }));
  });

  it('serves a published advocate detail page from HANA', async () => {
    const res = await test.get('/content/developer-advocates/dj-adams').catch((e) => e.response);
    expect(res.status).toBe(200);
    expect(String(res.data)).toContain('ADVOCATE-ROUTE-TEST');
  });

  it('lowercases a mixed-case slug', async () => {
    const res = await test.get('/content/developer-advocates/DJ-Adams').catch((e) => e.response);
    expect(res.status).toBe(200);
    expect(String(res.data)).toContain('ADVOCATE-ROUTE-TEST');
  });

  it('404s an unpublished advocate (fail-open, not 500/unhandled)', async () => {
    const res = await test.get('/content/developer-advocates/nobody').catch((e) => e.response);
    expect(res.status).toBe(404);
  });
});
