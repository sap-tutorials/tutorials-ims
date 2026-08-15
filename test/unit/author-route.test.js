// test/unit/author-route.test.js
// #1659 Phase C — /content/authors/:login serves an author-<login> BLOB from HANA.
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
const test = cds.test('serve', '--project', '.', '--in-memory');
const NS = 'com.sap.developers.ims';

describe('/content/authors/:login route', () => {
  beforeAll(async () => {
    const db = await cds.connect.to('db');
    const { ContentFiles, ContentManifest } = cds.entities(NS);
    const html = '<!doctype html><title>Tutorials by Test Author</title><main>AUTHOR-ROUTE-TEST</main>';
    const gz = gzipSync(Buffer.from(html));
    const hash = createHash('sha256').update(html).digest('hex');
    await db.run(INSERT.into(ContentManifest).entries({
      version: 1, status: 'ACTIVE', fileCount: 1, changedSlugs: JSON.stringify(['author-testauthor']),
    }));
    await db.run(INSERT.into(ContentFiles).entries({
      slug: 'author-testauthor', version: 1, content: gz, contentHash: hash,
      mimeType: 'text/html', sizeBytes: html.length, compressedBytes: gz.length,
    }));
  });

  it('serves a published author page from HANA', async () => {
    const res = await test.get('/content/authors/testauthor').catch((e) => e.response);
    expect(res.status).toBe(200);
    expect(String(res.data)).toContain('AUTHOR-ROUTE-TEST');
  });

  it('lowercases a mixed-case login to the canonical author- slug', async () => {
    const res = await test.get('/content/authors/TestAuthor').catch((e) => e.response);
    expect(res.status).toBe(200);
    expect(String(res.data)).toContain('AUTHOR-ROUTE-TEST');
  });

  it('404s an unpublished author (fail-open, not 500/unhandled)', async () => {
    const res = await test.get('/content/authors/nobody').catch((e) => e.response);
    expect(res.status).toBe(404);
  });

  it('404s an invalid login (rejects path tricks)', async () => {
    const res = await test.get('/content/authors/..%2f..%2fetc').catch((e) => e.response);
    expect([400, 404]).toContain(res.status);
  });
});
