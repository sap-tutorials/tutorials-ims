// test/hybrid/page-publish-serve.test.js
import { describe, it, expect } from 'vitest';
import cds from '@sap/cds';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const test = cds.test('serve', '--project', '.'); // hybrid: real HANA via cds bind --exec
const NS = 'com.sap.developers.ims';

// Simulate a committed page publish, then serve it back through the route.
describe('page publish→serve round-trip (hybrid)', () => {
  it('serves a published sitemap with XML mime from HANA', async () => {
    const db = await cds.connect.to('db');
    const { ContentFiles, ContentManifest } = cds.entities(NS);
    const xml = '<?xml version="1.0"?><urlset><url><loc>https://x/</loc></url></urlset>';
    const [{ maxv } = {}] = await db.run(SELECT.one.from(ContentManifest).columns({ func: 'max', args: [{ ref: ['version'] }], as: 'maxv' }));
    const version = (maxv || 0) + 1;
    await db.run(INSERT.into(ContentManifest).entries({ version, status: 'ACTIVE', fileCount: 1, changedSlugs: JSON.stringify(['page-sitemap.xml']) }));
    await db.run(UPDATE(ContentManifest).set({ status: 'SUPERSEDED' }).where`version < ${version}`);
    const gz = gzipSync(Buffer.from(xml));
    await db.run(INSERT.into(ContentFiles).entries({
      slug: 'page-sitemap.xml', version, content: gz,
      contentHash: createHash('sha256').update(xml).digest('hex'),
      mimeType: 'application/xml', sizeBytes: xml.length, compressedBytes: gz.length,
    }));
    const res = await test.get('/content/pages/sitemap.xml');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('xml');
    expect(String(res.data)).toContain('<urlset>');
  });
});
