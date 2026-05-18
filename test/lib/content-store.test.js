import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import cds from '@sap/cds';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const project = cds.test('serve', '--project', '.', '--in-memory');

function makePayload(files) {
  const result = {};
  for (const [slug, html] of Object.entries(files)) {
    const compressed = gzipSync(Buffer.from(html, 'utf-8'));
    result[slug] = compressed.toString('base64');
  }
  return result;
}

function hashOf(html) {
  return createHash('sha256').update(Buffer.from(html, 'utf-8')).digest('hex');
}

describe('content-store', () => {
  let ContentFiles, ContentManifest, Tutorials;
  const API_KEY = 'test-content-key-12345';

  beforeAll(() => {
    process.env.CONTENT_API_KEY = API_KEY;
    ({ ContentFiles, ContentManifest, Tutorials } = cds.entities('com.sap.developers.ims'));
  });

  beforeEach(async () => {
    await DELETE.from(ContentFiles);
    await DELETE.from(ContentManifest);
    await DELETE.from(Tutorials);
    const { JobLocks } = cds.entities('com.sap.developers.ims');
    await DELETE.from(JobLocks);
  });

  describe('POST /content/publish', () => {
    it('creates manifest and files for a valid payload', async () => {
      const html = '<h1>Hello Tutorial</h1>';
      const res = await project.axios.post('/content/publish', {
        trigger: 'test@abc123',
        hugoVersion: '0.147.0',
        files: makePayload({ 'my-tutorial': html })
      }, { headers: { Authorization: `Bearer ${API_KEY}` } });

      expect(res.status).toBe(201);
      expect(res.data.version).toBe(1);
      expect(res.data.filesWritten).toBe(1);
      expect(res.data.totalSizeBytes).toBe(Buffer.byteLength(html));

      const [manifest] = await SELECT.from(ContentManifest).where({ version: 1 });
      expect(manifest.status).toBe('ACTIVE');
      expect(manifest.fileCount).toBe(1);

      const [file] = await SELECT.from(ContentFiles).where({ slug: 'my-tutorial', version: 1 });
      expect(file.contentHash).toBe(hashOf(html));
      expect(file.sizeBytes).toBe(Buffer.byteLength(html));
    });

    it('publishes multiple files in one batch', async () => {
      const files = {
        'tutorial-a': '<p>A</p>',
        'tutorial-b': '<p>B</p>',
        'tutorial-c': '<p>C</p>'
      };
      const res = await project.axios.post('/content/publish', {
        trigger: 'batch-test',
        files: makePayload(files)
      }, { headers: { Authorization: `Bearer ${API_KEY}` } });

      expect(res.status).toBe(201);
      expect(res.data.filesWritten).toBe(3);

      const rows = await SELECT.from(ContentFiles).where({ version: 1 });
      expect(rows.length).toBe(3);
    });

    it('supersedes previous active version on new publish', async () => {
      await project.axios.post('/content/publish', {
        trigger: 'v1',
        files: makePayload({ 'tut': '<p>v1</p>' })
      }, { headers: { Authorization: `Bearer ${API_KEY}` } });

      await project.axios.post('/content/publish', {
        trigger: 'v2',
        files: makePayload({ 'tut': '<p>v2</p>' })
      }, { headers: { Authorization: `Bearer ${API_KEY}` } });

      const manifests = await SELECT.from(ContentManifest).orderBy('version asc');
      expect(manifests[0].status).toBe('SUPERSEDED');
      expect(manifests[1].status).toBe('ACTIVE');
    });

    it('rejects empty files object', async () => {
      const res = await project.axios.post('/content/publish', {
        trigger: 'empty',
        files: {}
      }, {
        headers: { Authorization: `Bearer ${API_KEY}` },
        validateStatus: () => true
      });

      expect(res.status).toBe(400);
    });

    it('rejects missing authorization', async () => {
      const res = await project.axios.post('/content/publish', {
        files: makePayload({ 'x': '<p>x</p>' })
      }, { validateStatus: () => true });

      expect(res.status).toBe(401);
    });

    it('rejects wrong token', async () => {
      const res = await project.axios.post('/content/publish', {
        files: makePayload({ 'x': '<p>x</p>' })
      }, {
        headers: { Authorization: 'Bearer wrong-token' },
        validateStatus: () => true
      });

      expect(res.status).toBe(403);
    });
  });

  describe('GET /content/tutorials/:slug', () => {
    const html = '<h1>Served Tutorial</h1>';

    beforeEach(async () => {
      await project.axios.post('/content/publish', {
        trigger: 'seed',
        files: makePayload({ 'served-tut': html })
      }, { headers: { Authorization: `Bearer ${API_KEY}` } });
    });

    it('serves decompressed HTML for a published tutorial', async () => {
      const res = await project.axios.get('/content/tutorials/served-tut');

      expect(res.status).toBe(200);
      expect(res.data).toBe(html);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.headers['etag']).toBe(`"${hashOf(html)}"`);
      expect(res.headers['cache-control']).toBe('public, max-age=300');
    });

    it('returns 304 on ETag match', async () => {
      const etag = `"${hashOf(html)}"`;
      const res = await project.axios.get('/content/tutorials/served-tut', {
        headers: { 'If-None-Match': etag },
        validateStatus: () => true
      });

      expect(res.status).toBe(304);
    });

    it('returns 404 for non-existent slug', async () => {
      const res = await project.axios.get('/content/tutorials/does-not-exist', {
        validateStatus: () => true
      });

      expect(res.status).toBe(404);
    });

    it('returns 503 when no active version exists', async () => {
      await DELETE.from(ContentManifest);
      const res = await project.axios.get('/content/tutorials/served-tut', {
        validateStatus: () => true
      });

      expect(res.status).toBe(503);
    });

    it('serves from cache on second request', async () => {
      await project.axios.get('/content/tutorials/served-tut');
      const res = await project.axios.get('/content/tutorials/served-tut');

      expect(res.status).toBe(200);
      expect(res.headers['x-content-source']).toBe('cache');
    });

    it('redirects /tutorials/<slug>.html to canonical /tutorials/<slug> with 301', async () => {
      const res = await project.axios.get('/content/tutorials/served-tut.html', {
        maxRedirects: 0,
        validateStatus: () => true
      });

      expect(res.status).toBe(301);
      expect(res.headers['location']).toBe('/tutorials/served-tut');
      expect(res.headers['cache-control']).toContain('max-age=3600');
    });

    it('preserves query string when redirecting from .html', async () => {
      const res = await project.axios.get('/content/tutorials/served-tut.html?step=2&utm=legacy', {
        maxRedirects: 0,
        validateStatus: () => true
      });

      expect(res.status).toBe(301);
      expect(res.headers['location']).toBe('/tutorials/served-tut?step=2&utm=legacy');
    });

    it('redirects .html for unpublished slugs too (redirect is content-agnostic)', async () => {
      const res = await project.axios.get('/content/tutorials/never-published.html', {
        maxRedirects: 0,
        validateStatus: () => true
      });

      expect(res.status).toBe(301);
      expect(res.headers['location']).toBe('/tutorials/never-published');
    });

    it('rejects .html with an invalid slug shape rather than redirecting', async () => {
      const res = await project.axios.get('/content/tutorials/Bad_Slug.html', {
        maxRedirects: 0,
        validateStatus: () => true
      });

      expect(res.status).toBe(400);
    });

    it('serves latest version of a slug across publishes', async () => {
      const htmlV2 = '<h1>Updated Tutorial</h1>';
      await project.axios.post('/content/publish', {
        trigger: 'update',
        files: makePayload({ 'served-tut': htmlV2 })
      }, { headers: { Authorization: `Bearer ${API_KEY}` } });

      const res = await project.axios.get('/content/tutorials/served-tut');
      expect(res.data).toBe(htmlV2);
    });
  });

  describe('GET /content/hashes', () => {
    it('returns slug-to-hash map', async () => {
      const files = { 'hash-a': '<p>A</p>', 'hash-b': '<p>B</p>' };
      await project.axios.post('/content/publish', {
        trigger: 'hashes',
        files: makePayload(files)
      }, { headers: { Authorization: `Bearer ${API_KEY}` } });

      const res = await project.axios.get('/content/hashes');

      expect(res.status).toBe(200);
      expect(res.data['hash-a']).toBe(hashOf('<p>A</p>'));
      expect(res.data['hash-b']).toBe(hashOf('<p>B</p>'));
    });

    it('returns empty object when no active version', async () => {
      const res = await project.axios.get('/content/hashes');
      expect(res.status).toBe(200);
      expect(res.data).toEqual({});
    });

    it('returns latest hash per slug across versions', async () => {
      await project.axios.post('/content/publish', {
        trigger: 'v1',
        files: makePayload({ 'evolve': '<p>v1</p>' })
      }, { headers: { Authorization: `Bearer ${API_KEY}` } });

      await project.axios.post('/content/publish', {
        trigger: 'v2',
        files: makePayload({ 'evolve': '<p>v2</p>' })
      }, { headers: { Authorization: `Bearer ${API_KEY}` } });

      const res = await project.axios.get('/content/hashes');
      expect(res.data['evolve']).toBe(hashOf('<p>v2</p>'));
    });
  });

  describe('GET /content/nav', () => {
    it('returns tutorial catalog with version and count', async () => {
      await project.axios.post('/content/publish', {
        trigger: 'nav-test',
        files: makePayload({ 'nav-a': '<p>A</p>', 'nav-b': '<p>B</p>' })
      }, { headers: { Authorization: `Bearer ${API_KEY}` } });

      const res = await project.axios.get('/content/nav');

      expect(res.status).toBe(200);
      expect(res.data.version).toBe(1);
      expect(res.data.count).toBe(2);
      expect(res.data.tutorials).toHaveLength(2);
      const slugs = res.data.tutorials.map(t => t.slug).sort();
      expect(slugs).toEqual(['nav-a', 'nav-b']);
    });

    it('serves stored nav metadata when __nav__ entry exists', async () => {
      const navData = JSON.stringify({ tutorials: [
        { slug: 'tut-x', title: 'Tutorial X', description: 'Desc X', time: 20, level: 'Advanced', stepCount: 5, primaryTag: 'HANA', displayTags: ['HANA', 'CAP'] },
        { slug: 'tut-y', title: 'Tutorial Y', description: 'Desc Y', time: 10, level: 'Beginner', stepCount: 3, primaryTag: 'BTP', displayTags: ['BTP'] },
      ]});
      const files = {
        'tut-x': '<p>X</p>',
        'tut-y': '<p>Y</p>',
      };
      const payload = makePayload(files);
      payload['__nav__'] = gzipSync(Buffer.from(navData)).toString('base64');

      await project.axios.post('/content/publish', {
        trigger: 'nav-stored',
        files: payload,
      }, { headers: { Authorization: `Bearer ${API_KEY}` } });

      const res = await project.axios.get('/content/nav');

      expect(res.status).toBe(200);
      expect(res.data.version).toBe(1);
      expect(res.data.count).toBe(2);
      expect(res.data.tutorials).toHaveLength(2);

      const tutX = res.data.tutorials.find(t => t.slug === 'tut-x');
      expect(tutX.title).toBe('Tutorial X');
      expect(tutX.description).toBe('Desc X');
      expect(tutX.time).toBe(20);
      expect(tutX.level).toBe('Advanced');
      expect(tutX.primaryTag).toBe('HANA');
      expect(tutX.displayTags).toEqual(['HANA', 'CAP']);
    });

    it('excludes __nav__ from hashes endpoint', async () => {
      const navData = JSON.stringify({ tutorials: [{ slug: 'h-tut', title: 'H' }] });
      const payload = makePayload({ 'h-tut': '<p>H</p>' });
      payload['__nav__'] = gzipSync(Buffer.from(navData)).toString('base64');

      await project.axios.post('/content/publish', {
        trigger: 'hash-nav',
        files: payload,
      }, { headers: { Authorization: `Bearer ${API_KEY}` } });

      const res = await project.axios.get('/content/hashes');
      expect(res.data['h-tut']).toBeDefined();
      expect(res.data['__nav__']).toBeUndefined();
    });

    it('rejects serving __nav__ as a tutorial', async () => {
      const navData = JSON.stringify({ tutorials: [] });
      const payload = makePayload({ 'real-tut': '<p>Real</p>' });
      payload['__nav__'] = gzipSync(Buffer.from(navData)).toString('base64');

      await project.axios.post('/content/publish', {
        trigger: 'guard-test',
        files: payload,
      }, { headers: { Authorization: `Bearer ${API_KEY}` } });

      const res = await project.axios.get('/content/tutorials/__nav__', {
        validateStatus: () => true
      });
      expect(res.status).toBe(400);
    });

    it('returns empty when no active version', async () => {
      const res = await project.axios.get('/content/nav');
      expect(res.data).toEqual({ version: null, tutorials: [] });
    });
  });

  describe('POST /content/rollback', () => {
    beforeEach(async () => {
      await project.axios.post('/content/publish', {
        trigger: 'v1',
        files: makePayload({ 'rb-tut': '<p>v1</p>' })
      }, { headers: { Authorization: `Bearer ${API_KEY}` } });

      await project.axios.post('/content/publish', {
        trigger: 'v2',
        files: makePayload({ 'rb-tut': '<p>v2</p>' })
      }, { headers: { Authorization: `Bearer ${API_KEY}` } });
    });

    it('rolls back to most recent superseded version by default', async () => {
      const res = await project.axios.post('/content/rollback', {}, {
        headers: { Authorization: `Bearer ${API_KEY}` }
      });

      expect(res.status).toBe(200);
      expect(res.data.rolledBackTo).toBe(1);

      const manifests = await SELECT.from(ContentManifest).orderBy('version asc');
      expect(manifests[0].status).toBe('ACTIVE');
      expect(manifests[1].status).toBe('ROLLED_BACK');
    });

    it('rolls back to a specific target version', async () => {
      const res = await project.axios.post('/content/rollback', {
        targetVersion: 1
      }, { headers: { Authorization: `Bearer ${API_KEY}` } });

      expect(res.status).toBe(200);
      expect(res.data.rolledBackTo).toBe(1);
    });

    it('serves correct content after rollback', async () => {
      await project.axios.post('/content/rollback', {}, {
        headers: { Authorization: `Bearer ${API_KEY}` }
      });

      const res = await project.axios.get('/content/tutorials/rb-tut');
      expect(res.data).toBe('<p>v1</p>');
    });

    it('returns 404 when no rollback target exists', async () => {
      await DELETE.from(ContentManifest);
      const res = await project.axios.post('/content/rollback', {}, {
        headers: { Authorization: `Bearer ${API_KEY}` },
        validateStatus: () => true
      });

      expect(res.status).toBe(404);
    });

    it('requires authentication', async () => {
      const res = await project.axios.post('/content/rollback', {}, {
        validateStatus: () => true
      });

      expect(res.status).toBe(401);
    });
  });

  describe('Lifecycle sequences', () => {
    it('create → update → verify: full publish-serve-hash cycle', async () => {
      const slug = 'lifecycle-tutorial';
      const v1 = '<h1>Version 1</h1>';
      const v2 = '<h1>Version 2</h1><p>New step added</p>';

      // Create
      await project.axios.post('/content/publish', {
        trigger: 'lifecycle-create',
        files: makePayload({ [slug]: v1 })
      }, { headers: { Authorization: `Bearer ${API_KEY}` } });

      // Verify serve
      const r1 = await project.axios.get(`/content/tutorials/${slug}`);
      expect(r1.data).toBe(v1);
      expect(r1.headers['etag']).toBe(`"${hashOf(v1)}"`);

      // Verify hashes
      const h1 = await project.axios.get('/content/hashes');
      expect(h1.data[slug]).toBe(hashOf(v1));

      // Update
      await project.axios.post('/content/publish', {
        trigger: 'lifecycle-update',
        files: makePayload({ [slug]: v2 })
      }, { headers: { Authorization: `Bearer ${API_KEY}` } });

      // Verify serve returns v2
      const r2 = await project.axios.get(`/content/tutorials/${slug}`);
      expect(r2.data).toBe(v2);
      expect(r2.headers['etag']).toBe(`"${hashOf(v2)}"`);

      // Verify hashes updated
      const h2 = await project.axios.get('/content/hashes');
      expect(h2.data[slug]).toBe(hashOf(v2));
    });

    it('create → delete → verify: slug disappears after re-publish without it', async () => {
      const kept = 'kept-slug';
      const removed = 'removed-slug';

      // Create both
      await project.axios.post('/content/publish', {
        trigger: 'both',
        files: makePayload({ [kept]: '<p>K</p>', [removed]: '<p>R</p>' })
      }, { headers: { Authorization: `Bearer ${API_KEY}` } });

      // Both served
      expect((await project.axios.get(`/content/tutorials/${kept}`)).status).toBe(200);
      expect((await project.axios.get(`/content/tutorials/${removed}`)).status).toBe(200);

      // Re-publish without removed slug
      await project.axios.post('/content/publish', {
        trigger: 'delete',
        files: makePayload({ [kept]: '<p>K</p>' })
      }, { headers: { Authorization: `Bearer ${API_KEY}` } });

      // Kept still works
      expect((await project.axios.get(`/content/tutorials/${kept}`)).status).toBe(200);

      // Removed returns 404
      const gone = await project.axios.get(`/content/tutorials/${removed}`, {
        validateStatus: () => true
      });
      expect(gone.status).toBe(404);

      // Hashes and nav reflect the removal
      const h = await project.axios.get('/content/hashes');
      expect(h.data[kept]).toBeDefined();
      expect(h.data[removed]).toBeUndefined();
    });

    it('create → update → rollback → verify: full rollback cycle', async () => {
      const slug = 'rollback-lifecycle';
      const v1 = '<p>original</p>';
      const v2 = '<p>updated</p>';

      await project.axios.post('/content/publish', {
        trigger: 'v1',
        files: makePayload({ [slug]: v1 })
      }, { headers: { Authorization: `Bearer ${API_KEY}` } });

      await project.axios.post('/content/publish', {
        trigger: 'v2',
        files: makePayload({ [slug]: v2 })
      }, { headers: { Authorization: `Bearer ${API_KEY}` } });

      // Confirm v2 active
      expect((await project.axios.get(`/content/tutorials/${slug}`)).data).toBe(v2);

      // Rollback
      await project.axios.post('/content/rollback', {}, {
        headers: { Authorization: `Bearer ${API_KEY}` }
      });

      // Confirm v1 restored
      const res = await project.axios.get(`/content/tutorials/${slug}`);
      expect(res.data).toBe(v1);
      expect(res.headers['etag']).toBe(`"${hashOf(v1)}"`);

      // Hashes reflect v1
      const h = await project.axios.get('/content/hashes');
      expect(h.data[slug]).toBe(hashOf(v1));
    });
  });

  describe('Soft-delete, redirect, and 404 page', () => {
    const notFoundHtml = '<!doctype html><html><body><h1>Tutorial not found</h1></body></html>';

    async function publishWith404(extraFiles = {}) {
      const payload = makePayload(extraFiles);
      payload['__404__'] = gzipSync(Buffer.from(notFoundHtml, 'utf-8')).toString('base64');
      await project.axios.post('/content/publish', {
        trigger: 'with-404',
        files: payload,
      }, { headers: { Authorization: `Bearer ${API_KEY}` } });
    }

    it('excludes __404__ from /content/hashes', async () => {
      await publishWith404({ 'real-tut': '<p>Real</p>' });

      const res = await project.axios.get('/content/hashes');
      expect(res.data['real-tut']).toBeDefined();
      expect(res.data['__404__']).toBeUndefined();
    });

    it('excludes __404__ from /content/nav (fallback path)', async () => {
      // No __nav__ entry, so navHandlerFallback runs
      await publishWith404({ 'visible-tut': '<p>V</p>' });

      const res = await project.axios.get('/content/nav');
      expect(res.status).toBe(200);
      const slugs = res.data.tutorials.map(t => t.slug);
      expect(slugs).toContain('visible-tut');
      expect(slugs).not.toContain('__404__');
    });

    it('rejects serving __404__ as a tutorial slug', async () => {
      await publishWith404({ 'something': '<p>x</p>' });

      const res = await project.axios.get('/content/tutorials/__404__', {
        validateStatus: () => true,
      });
      expect(res.status).toBe(400);
    });

    it('serves __404__ HTML body when a slug is not in ContentFiles', async () => {
      await publishWith404({ 'exists': '<p>here</p>' });

      const res = await project.axios.get('/content/tutorials/totally-missing', {
        validateStatus: () => true,
      });

      expect(res.status).toBe(404);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.data).toContain('Tutorial not found');
      expect(res.headers['cache-control']).toContain('max-age=60');
    });

    it('falls back to JSON 404 when __404__ has not been published', async () => {
      await project.axios.post('/content/publish', {
        trigger: 'no-404',
        files: makePayload({ 'only-tut': '<p>only</p>' }),
      }, { headers: { Authorization: `Bearer ${API_KEY}` } });

      const res = await project.axios.get('/content/tutorials/missing', {
        validateStatus: () => true,
      });

      expect(res.status).toBe(404);
      expect(res.headers['content-type']).toContain('application/json');
      expect(res.data.error).toContain('missing');
    });

    it('returns __404__ HTML for an INACTIVE tutorial without a redirect target', async () => {
      await publishWith404({ 'sunset-tut': '<p>old content</p>' });

      // Soft-delete the tutorial (admin DELETE handler does the same UPDATE)
      const tutId = cds.utils.uuid();
      await INSERT.into(Tutorials).entries({
        ID: tutId,
        slug: 'sunset-tut',
        title: 'Sunset',
        status: 'INACTIVE',
      });

      const res = await project.axios.get('/content/tutorials/sunset-tut', {
        validateStatus: () => true,
      });

      expect(res.status).toBe(404);
      expect(res.data).toContain('Tutorial not found');
    });

    it('301-redirects an INACTIVE tutorial with a valid redirectTo target', async () => {
      await publishWith404({
        'old-slug': '<p>old</p>',
        'new-slug': '<p>new</p>',
      });

      const newId = cds.utils.uuid();
      const oldId = cds.utils.uuid();
      await INSERT.into(Tutorials).entries({
        ID: newId,
        slug: 'new-slug',
        title: 'New',
        status: 'ACTIVE',
      });
      await INSERT.into(Tutorials).entries({
        ID: oldId,
        slug: 'old-slug',
        title: 'Old',
        status: 'INACTIVE',
        redirectTo_ID: newId,
      });

      const res = await project.axios.get('/content/tutorials/old-slug', {
        maxRedirects: 0,
        validateStatus: () => true,
      });

      expect(res.status).toBe(301);
      expect(res.headers['location']).toBe('/tutorials/new-slug');
      expect(res.headers['cache-control']).toContain('max-age=300');
    });

    it('preserves query string on soft-delete redirect', async () => {
      await publishWith404({ 'old-slug': '<p>o</p>', 'new-slug': '<p>n</p>' });

      const newId = cds.utils.uuid();
      const oldId = cds.utils.uuid();
      await INSERT.into(Tutorials).entries({ ID: newId, slug: 'new-slug', title: 'N', status: 'ACTIVE' });
      await INSERT.into(Tutorials).entries({ ID: oldId, slug: 'old-slug', title: 'O', status: 'INACTIVE', redirectTo_ID: newId });

      const res = await project.axios.get('/content/tutorials/old-slug?step=2', {
        maxRedirects: 0,
        validateStatus: () => true,
      });

      expect(res.status).toBe(301);
      expect(res.headers['location']).toBe('/tutorials/new-slug?step=2');
    });

    it('falls through to 404 when redirect target itself is INACTIVE', async () => {
      await publishWith404({ 'old-slug': '<p>o</p>', 'gone-slug': '<p>g</p>' });

      const goneId = cds.utils.uuid();
      const oldId = cds.utils.uuid();
      await INSERT.into(Tutorials).entries({ ID: goneId, slug: 'gone-slug', title: 'Gone', status: 'INACTIVE' });
      await INSERT.into(Tutorials).entries({ ID: oldId, slug: 'old-slug', title: 'Old', status: 'INACTIVE', redirectTo_ID: goneId });

      const res = await project.axios.get('/content/tutorials/old-slug', {
        validateStatus: () => true,
      });

      expect(res.status).toBe(404);
      expect(res.data).toContain('Tutorial not found');
    });

    it('excludes INACTIVE tutorials from /content/nav even when ContentFiles still has them', async () => {
      await publishWith404({
        'kept-tut': '<p>kept</p>',
        'gone-tut': '<p>gone</p>',
      });

      // Mark gone-tut as INACTIVE in admin
      await INSERT.into(Tutorials).entries({
        ID: cds.utils.uuid(),
        slug: 'gone-tut',
        title: 'Gone',
        status: 'INACTIVE',
      });

      const res = await project.axios.get('/content/nav');
      const slugs = res.data.tutorials.map(t => t.slug);

      expect(slugs).toContain('kept-tut');
      expect(slugs).not.toContain('gone-tut');
    });

    it('still serves an ACTIVE tutorial normally even when its row exists in Tutorials', async () => {
      await publishWith404({ 'active-tut': '<p>active</p>' });

      await INSERT.into(Tutorials).entries({
        ID: cds.utils.uuid(),
        slug: 'active-tut',
        title: 'Active',
        status: 'ACTIVE',
      });

      const res = await project.axios.get('/content/tutorials/active-tut');
      expect(res.status).toBe(200);
      expect(res.data).toBe('<p>active</p>');
    });
  });
});
