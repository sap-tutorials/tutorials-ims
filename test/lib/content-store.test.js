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
  let ContentFiles, ContentManifest;
  const API_KEY = 'test-content-key-12345';

  beforeAll(() => {
    process.env.CONTENT_API_KEY = API_KEY;
    ({ ContentFiles, ContentManifest } = cds.entities('com.sap.developers.ims'));
  });

  beforeEach(async () => {
    await DELETE.from(ContentFiles);
    await DELETE.from(ContentManifest);
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
});
