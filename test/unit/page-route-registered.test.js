// test/unit/page-route-registered.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
const test = cds.test('serve', '--project', '.', '--in-memory');
const NS = 'com.sap.developers.ims';

describe('/content/pages route', () => {
  beforeAll(async () => {
    // Seed page-index into an ACTIVE manifest so the homepage route test asserts
    // served-from-HANA content (deterministic in CI AND locally, independent of
    // the gitignored srv/page-fallback/* baked snapshots).
    const db = await cds.connect.to('db');
    const { ContentFiles, ContentManifest } = cds.entities(NS);
    const html = '<!doctype html><article class="developer-homepage">HOME-ROUTE-TEST</article>';
    const gz = gzipSync(Buffer.from(html));
    const hash = createHash('sha256').update(html).digest('hex');
    await db.run(INSERT.into(ContentManifest).entries({
      version: 1, status: 'ACTIVE', fileCount: 1, changedSlugs: JSON.stringify(['page-index']),
    }));
    await db.run(INSERT.into(ContentFiles).entries({
      slug: 'page-index', version: 1, content: gz, contentHash: hash,
      mimeType: 'text/html', sizeBytes: html.length, compressedBytes: gz.length,
    }));
  });

  it('is mounted and 404s an unpublished in-scope page (not 500/unhandled)', async () => {
    const res = await test.get('/content/pages/topics/').catch((e) => e.response);
    expect(res.status).toBe(404);
  });

  // #1659 homepage flip: the bare /content/pages/ must reach pageServeHandler and
  // resolve to page-index. The Express `*path` wildcard does NOT match the empty
  // segment, so srv/server.js registers `/content/pages` explicitly.
  it('resolves the bare /content/pages/ to the published page-index', async () => {
    const res = await test.get('/content/pages/').catch((e) => e.response);
    expect(res.status).toBe(200);
    expect(String(res.data)).toContain('HOME-ROUTE-TEST');
  });
});
