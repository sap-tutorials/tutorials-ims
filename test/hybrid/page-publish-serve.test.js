// test/hybrid/page-publish-serve.test.js
import { describe, it, expect, afterAll } from 'vitest';
import cds from '@sap/cds';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const test = cds.test('serve', '--project', '.'); // hybrid: real HANA via cds bind --exec
const NS = 'com.sap.developers.ims';

// Simulate a committed page publish, then serve it back through the route.
describe('page publish→serve round-trip (hybrid)', () => {
  let testVersion;
  let prevActiveVersion;

  it('serves a published sitemap with XML mime from HANA', async () => {
    const db = await cds.connect.to('db');
    const { ContentFiles, ContentManifest } = cds.entities(NS);
    const xml = '<?xml version="1.0"?><urlset><url><loc>https://x/</loc></url></urlset>';
    // SELECT.one returns an object, not an array — drop .one to get an array.
    const [{ maxv } = {}] = await db.run(SELECT.from(ContentManifest).columns({ func: 'max', args: [{ ref: ['version'] }], as: 'maxv' }));
    testVersion = (maxv || 0) + 1;
    // Capture the previously ACTIVE version so afterAll can restore it.
    const [prev] = await db.run(SELECT.from(ContentManifest).where({ status: 'ACTIVE' }).columns('version').limit(1));
    prevActiveVersion = prev?.version ?? null;
    await db.run(INSERT.into(ContentManifest).entries({ version: testVersion, status: 'ACTIVE', fileCount: 1, changedSlugs: JSON.stringify(['page-sitemap.xml']) }));
    await db.run(UPDATE(ContentManifest).set({ status: 'SUPERSEDED' }).where`version < ${testVersion}`);
    const gz = gzipSync(Buffer.from(xml));
    await db.run(INSERT.into(ContentFiles).entries({
      slug: 'page-sitemap.xml', version: testVersion, content: gz,
      contentHash: createHash('sha256').update(xml).digest('hex'),
      mimeType: 'application/xml', sizeBytes: xml.length, compressedBytes: gz.length,
    }));
    const res = await test.get('/content/pages/sitemap.xml');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('xml');
    expect(String(res.data)).toContain('<urlset>');
  });

  afterAll(async () => {
    if (testVersion == null) return;
    const db = await cds.connect.to('db');
    const { ContentFiles, ContentManifest } = cds.entities(NS);
    // Remove the test ContentFiles row and manifest version we created.
    await db.run(DELETE.from(ContentFiles).where({ slug: 'page-sitemap.xml', version: testVersion }));
    await db.run(DELETE.from(ContentManifest).where({ version: testVersion }));
    // Restore the prior ACTIVE manifest that we superseded.
    if (prevActiveVersion != null) {
      await db.run(UPDATE(ContentManifest).set({ status: 'ACTIVE' }).where({ version: prevActiveVersion }));
    }
  });
});
