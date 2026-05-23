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

describe('Content Pipeline Lifecycle', () => {
  let ContentFiles, ContentManifest;
  const API_KEY = 'test-lifecycle-key-99999';

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

  describe('13.1 New Tutorial Created', () => {
    const slug = 'brand-new-tutorial';
    const html = `<html><body><h1>Brand New Tutorial</h1><p>Step 1 content</p></body></html>`;

    it('publish → manifest → serve → nav → hashes lifecycle', async () => {
      // --- Publish stage ---
      const publishRes = await project.axios.post('/content/publish', {
        trigger: 'ci@new-tutorial-commit',
        hugoVersion: '0.147.0',
        files: makePayload({ [slug]: html })
      }, { headers: { Authorization: `Bearer ${API_KEY}` } });

      expect(publishRes.status).toBe(201);
      expect(publishRes.data.version).toBe(1);
      expect(publishRes.data.filesWritten).toBe(1);
      expect(publishRes.data.totalSizeBytes).toBe(Buffer.byteLength(html));

      // --- Manifest stage ---
      const [manifest] = await SELECT.from(ContentManifest).where({ version: 1 });
      expect(manifest.status).toBe('ACTIVE');
      expect(manifest.fileCount).toBe(1);
      expect(manifest.hugoVersion).toBe('0.147.0');
      expect(manifest.trigger).toBe('ci@new-tutorial-commit');

      const [file] = await SELECT.from(ContentFiles).where({ slug, version: 1 });
      expect(file.contentHash).toBe(hashOf(html));
      expect(file.sizeBytes).toBe(Buffer.byteLength(html));
      expect(file.compressedBytes).toBeGreaterThan(0);
      expect(file.mimeType).toBe('text/html');

      // --- Serve stage ---
      const serveRes = await project.axios.get(`/content/tutorials/${slug}`);
      expect(serveRes.status).toBe(200);
      expect(serveRes.data).toBe(html);
      expect(serveRes.headers['content-type']).toContain('text/html');
      expect(serveRes.headers['etag']).toBe(`"${hashOf(html)}"`);
      expect(serveRes.headers['cache-control']).toBe('public, max-age=300');
      expect(serveRes.headers['x-content-source']).toBe('db');

      // --- Navigation stage ---
      const navRes = await project.axios.get('/content/nav');
      expect(navRes.status).toBe(200);
      expect(navRes.data.version).toBe(1);
      expect(navRes.data.count).toBe(1);
      expect(navRes.data.tutorials).toHaveLength(1);
      expect(navRes.data.tutorials[0].slug).toBe(slug);

      // --- Hash registry ---
      const hashRes = await project.axios.get('/content/hashes');
      expect(hashRes.status).toBe(200);
      expect(hashRes.data[slug]).toBe(hashOf(html));
      expect(Object.keys(hashRes.data)).toHaveLength(1);
    });

    it('multiple new tutorials published in a single batch', async () => {
      const tutorials = {
        'new-tut-alpha': '<h1>Alpha</h1><p>First tutorial</p>',
        'new-tut-beta': '<h1>Beta</h1><p>Second tutorial</p>',
        'new-tut-gamma': '<h1>Gamma</h1><p>Third tutorial</p>'
      };

      const publishRes = await project.axios.post('/content/publish', {
        trigger: 'ci@batch-create',
        files: makePayload(tutorials)
      }, { headers: { Authorization: `Bearer ${API_KEY}` } });

      expect(publishRes.data.filesWritten).toBe(3);

      // All slugs served correctly
      for (const [s, h] of Object.entries(tutorials)) {
        const res = await project.axios.get(`/content/tutorials/${s}`);
        expect(res.status).toBe(200);
        expect(res.data).toBe(h);
      }

      // Nav reflects all three
      const navRes = await project.axios.get('/content/nav');
      expect(navRes.data.count).toBe(3);
      const slugs = navRes.data.tutorials.map(t => t.slug).sort();
      expect(slugs).toEqual(['new-tut-alpha', 'new-tut-beta', 'new-tut-gamma']);

      // Hashes contain all three
      const hashRes = await project.axios.get('/content/hashes');
      expect(Object.keys(hashRes.data).sort()).toEqual(
        ['new-tut-alpha', 'new-tut-beta', 'new-tut-gamma']
      );
    });
  });

  describe('13.2 Existing Tutorial Updated', () => {
    const slug = 'evolving-tutorial';
    const htmlV1 = '<h1>Tutorial v1</h1><p>Original content</p>';
    const htmlV2 = '<h1>Tutorial v2</h1><p>Updated content with new step</p>';

    beforeEach(async () => {
      // Seed with v1
      await project.axios.post('/content/publish', {
        trigger: 'ci@initial',
        files: makePayload({ [slug]: htmlV1, 'stable-tut': '<p>Unchanged</p>' })
      }, { headers: { Authorization: `Bearer ${API_KEY}` } });
    });

    it('delta detection: only changed slug in new manifest', async () => {
      // Publish v2 — only the changed slug
      const publishRes = await project.axios.post('/content/publish', {
        trigger: 'ci@update-commit',
        files: makePayload({ [slug]: htmlV2, 'stable-tut': '<p>Unchanged</p>' })
      }, { headers: { Authorization: `Bearer ${API_KEY}` } });

      expect(publishRes.status).toBe(201);
      expect(publishRes.data.version).toBe(2);

      // Manifest has correct changedSlugs (all slugs in this publish batch)
      const [manifest] = await SELECT.from(ContentManifest).where({ version: 2 });
      expect(manifest.status).toBe('ACTIVE');
      const changedSlugs = JSON.parse(manifest.changedSlugs);
      expect(changedSlugs).toContain(slug);
    });

    it('previous version superseded on new publish', async () => {
      await project.axios.post('/content/publish', {
        trigger: 'ci@v2',
        files: makePayload({ [slug]: htmlV2 })
      }, { headers: { Authorization: `Bearer ${API_KEY}` } });

      const manifests = await SELECT.from(ContentManifest).orderBy('version asc');
      expect(manifests).toHaveLength(2);
      expect(manifests[0].status).toBe('SUPERSEDED');
      expect(manifests[1].status).toBe('ACTIVE');
    });

    it('serve returns updated HTML with new ETag after publish', async () => {
      const etagV1 = `"${hashOf(htmlV1)}"`;

      // Confirm v1 serves correctly
      const resV1 = await project.axios.get(`/content/tutorials/${slug}`);
      expect(resV1.data).toBe(htmlV1);
      expect(resV1.headers['etag']).toBe(etagV1);

      // Publish v2
      await project.axios.post('/content/publish', {
        trigger: 'ci@v2',
        files: makePayload({ [slug]: htmlV2 })
      }, { headers: { Authorization: `Bearer ${API_KEY}` } });

      // Serve returns v2 with new ETag
      const resV2 = await project.axios.get(`/content/tutorials/${slug}`);
      expect(resV2.data).toBe(htmlV2);
      expect(resV2.headers['etag']).toBe(`"${hashOf(htmlV2)}"`);
      expect(resV2.headers['etag']).not.toBe(etagV1);
    });

    it('cache invalidation: first request after publish comes from db', async () => {
      // Warm the cache
      await project.axios.get(`/content/tutorials/${slug}`);
      const cachedRes = await project.axios.get(`/content/tutorials/${slug}`);
      expect(cachedRes.headers['x-content-source']).toBe('cache');

      // Publish v2 (invalidates cache)
      await project.axios.post('/content/publish', {
        trigger: 'ci@v2',
        files: makePayload({ [slug]: htmlV2 })
      }, { headers: { Authorization: `Bearer ${API_KEY}` } });

      // First request after publish should come from db
      const freshRes = await project.axios.get(`/content/tutorials/${slug}`);
      expect(freshRes.headers['x-content-source']).toBe('db');
      expect(freshRes.data).toBe(htmlV2);

      // Second request should be cached again
      const recachedRes = await project.axios.get(`/content/tutorials/${slug}`);
      expect(recachedRes.headers['x-content-source']).toBe('cache');
    });

    it('old ETag returns fresh 200 after update (not stale 304)', async () => {
      const oldEtag = `"${hashOf(htmlV1)}"`;

      // Publish v2
      await project.axios.post('/content/publish', {
        trigger: 'ci@v2',
        files: makePayload({ [slug]: htmlV2 })
      }, { headers: { Authorization: `Bearer ${API_KEY}` } });

      // Request with old ETag should get 200 with new content, not 304
      const res = await project.axios.get(`/content/tutorials/${slug}`, {
        headers: { 'If-None-Match': oldEtag },
        validateStatus: () => true
      });
      expect(res.status).toBe(200);
      expect(res.data).toBe(htmlV2);
    });

    it('hash registry reflects updated hash', async () => {
      await project.axios.post('/content/publish', {
        trigger: 'ci@v2',
        files: makePayload({ [slug]: htmlV2 })
      }, { headers: { Authorization: `Bearer ${API_KEY}` } });

      const hashRes = await project.axios.get('/content/hashes');
      expect(hashRes.data[slug]).toBe(hashOf(htmlV2));
      expect(hashRes.data[slug]).not.toBe(hashOf(htmlV1));
    });

    it('rollback reverts to previous content version', async () => {
      // Publish v2
      await project.axios.post('/content/publish', {
        trigger: 'ci@v2',
        files: makePayload({ [slug]: htmlV2 })
      }, { headers: { Authorization: `Bearer ${API_KEY}` } });

      // Confirm v2 active
      const preRollback = await project.axios.get(`/content/tutorials/${slug}`);
      expect(preRollback.data).toBe(htmlV2);

      // Rollback
      const rbRes = await project.axios.post('/content/rollback', {}, {
        headers: { Authorization: `Bearer ${API_KEY}` }
      });
      expect(rbRes.status).toBe(200);
      expect(rbRes.data.rolledBackTo).toBe(1);

      // Verify content reverted
      const postRollback = await project.axios.get(`/content/tutorials/${slug}`);
      expect(postRollback.data).toBe(htmlV1);

      // Verify manifests
      const manifests = await SELECT.from(ContentManifest).orderBy('version asc');
      expect(manifests[0].status).toBe('ACTIVE');
      expect(manifests[1].status).toBe('ROLLED_BACK');
    });

    it('rollback → re-publish lifecycle', async () => {
      const htmlV3 = '<h1>Tutorial v3</h1><p>After rollback fix</p>';

      // v1 already published in beforeEach
      // Publish v2
      await project.axios.post('/content/publish', {
        trigger: 'ci@v2',
        files: makePayload({ [slug]: htmlV2 })
      }, { headers: { Authorization: `Bearer ${API_KEY}` } });

      // Rollback to v1
      await project.axios.post('/content/rollback', {}, {
        headers: { Authorization: `Bearer ${API_KEY}` }
      });

      // Publish v3 (fix)
      const v3Res = await project.axios.post('/content/publish', {
        trigger: 'ci@v3-fix',
        files: makePayload({ [slug]: htmlV3 })
      }, { headers: { Authorization: `Bearer ${API_KEY}` } });
      expect(v3Res.data.version).toBe(3);

      // Serve returns v3
      const serveRes = await project.axios.get(`/content/tutorials/${slug}`);
      expect(serveRes.data).toBe(htmlV3);

      // All manifests have correct statuses
      const manifests = await SELECT.from(ContentManifest).orderBy('version asc');
      expect(manifests[0].status).toBe('SUPERSEDED'); // v1 was active after rollback, then superseded by v3
      expect(manifests[1].status).toBe('ROLLED_BACK');
      expect(manifests[2].status).toBe('ACTIVE');
    });
  });

  // 13.3 — "delete by omission from publish" is NOT how content deletion works.
  // The publishHandler deliberately carries forward unchanged slugs from the
  // previous active version (srv/lib/content-store.js:188-251) so each ACTIVE
  // manifest is a complete snapshot. The actual production deletion path is
  // setting Tutorials.status = 'INACTIVE' via the Admin UI, which the serve
  // handler honors (srv/lib/content-store.js:553 → serveNotFound).
  //
  // The five tests below assert the omission-deletes semantic and are skipped.
  // The two unrelated tests in the block (kept-slug-still-serves and
  // old-ContentFiles-rows-still-exist-for-rollback) remain active.
  describe('13.3 Tutorial Deleted (Removed from Pipeline)', () => {
    const keptSlug = 'kept-tutorial';
    const deletedSlug = 'deleted-tutorial';
    const keptHtml = '<h1>Kept Tutorial</h1>';
    const deletedHtml = '<h1>To Be Deleted</h1>';

    beforeEach(async () => {
      // Initial publish with both tutorials
      await project.axios.post('/content/publish', {
        trigger: 'ci@initial-both',
        files: makePayload({ [keptSlug]: keptHtml, [deletedSlug]: deletedHtml })
      }, { headers: { Authorization: `Bearer ${API_KEY}` } });
    });

    it.skip('removed slug not in new manifest after re-publish without it', async () => {
      // Re-publish with only the kept tutorial (deleted slug removed from pipeline)
      const publishRes = await project.axios.post('/content/publish', {
        trigger: 'ci@removed-tutorial',
        files: makePayload({ [keptSlug]: keptHtml })
      }, { headers: { Authorization: `Bearer ${API_KEY}` } });

      expect(publishRes.data.version).toBe(2);
      expect(publishRes.data.filesWritten).toBe(1);

      // Manifest v2 only has 1 file
      const [manifest] = await SELECT.from(ContentManifest).where({ version: 2 });
      expect(manifest.fileCount).toBe(1);

      // ContentFiles at v2 only has the kept slug
      const v2Files = await SELECT.from(ContentFiles).where({ version: 2 });
      expect(v2Files).toHaveLength(1);
      expect(v2Files[0].slug).toBe(keptSlug);
    });

    it.skip('deleted slug returns 404 after re-publish', async () => {
      // Confirm it's served before deletion
      const beforeRes = await project.axios.get(`/content/tutorials/${deletedSlug}`);
      expect(beforeRes.status).toBe(200);

      // Re-publish without the deleted slug
      await project.axios.post('/content/publish', {
        trigger: 'ci@delete',
        files: makePayload({ [keptSlug]: keptHtml })
      }, { headers: { Authorization: `Bearer ${API_KEY}` } });

      // Now 404 — slug not in active version's files
      const afterRes = await project.axios.get(`/content/tutorials/${deletedSlug}`, {
        validateStatus: () => true
      });
      expect(afterRes.status).toBe(404);
    });

    it('kept slug still serves correctly after deletion', async () => {
      await project.axios.post('/content/publish', {
        trigger: 'ci@delete',
        files: makePayload({ [keptSlug]: keptHtml })
      }, { headers: { Authorization: `Bearer ${API_KEY}` } });

      const res = await project.axios.get(`/content/tutorials/${keptSlug}`);
      expect(res.status).toBe(200);
      expect(res.data).toBe(keptHtml);
    });

    it.skip('hash registry no longer includes deleted slug', async () => {
      await project.axios.post('/content/publish', {
        trigger: 'ci@delete',
        files: makePayload({ [keptSlug]: keptHtml })
      }, { headers: { Authorization: `Bearer ${API_KEY}` } });

      const hashRes = await project.axios.get('/content/hashes');
      expect(hashRes.data[keptSlug]).toBe(hashOf(keptHtml));
      expect(hashRes.data[deletedSlug]).toBeUndefined();
    });

    it.skip('navigation no longer lists deleted tutorial', async () => {
      await project.axios.post('/content/publish', {
        trigger: 'ci@delete',
        files: makePayload({ [keptSlug]: keptHtml })
      }, { headers: { Authorization: `Bearer ${API_KEY}` } });

      const navRes = await project.axios.get('/content/nav');
      expect(navRes.data.count).toBe(1);
      const slugs = navRes.data.tutorials.map(t => t.slug);
      expect(slugs).toContain(keptSlug);
      expect(slugs).not.toContain(deletedSlug);
    });

    it.skip('rollback after deletion restores deleted slug', async () => {
      // Publish without deleted slug
      await project.axios.post('/content/publish', {
        trigger: 'ci@delete',
        files: makePayload({ [keptSlug]: keptHtml })
      }, { headers: { Authorization: `Bearer ${API_KEY}` } });

      // Confirm deleted
      const gone = await project.axios.get(`/content/tutorials/${deletedSlug}`, {
        validateStatus: () => true
      });
      expect(gone.status).toBe(404);

      // Rollback to v1 (which had both)
      await project.axios.post('/content/rollback', {}, {
        headers: { Authorization: `Bearer ${API_KEY}` }
      });

      // Deleted slug restored
      const restored = await project.axios.get(`/content/tutorials/${deletedSlug}`);
      expect(restored.status).toBe(200);
      expect(restored.data).toBe(deletedHtml);
    });

    it('old ContentFiles rows from deleted slug still exist for rollback', async () => {
      await project.axios.post('/content/publish', {
        trigger: 'ci@delete',
        files: makePayload({ [keptSlug]: keptHtml })
      }, { headers: { Authorization: `Bearer ${API_KEY}` } });

      // Old rows at v1 still exist in db (not GC'd immediately)
      const oldRows = await SELECT.from(ContentFiles).where({ slug: deletedSlug, version: 1 });
      expect(oldRows).toHaveLength(1);
      expect(oldRows[0].contentHash).toBe(hashOf(deletedHtml));
    });
  });

  describe('Cross-cutting: concurrent and edge cases', () => {
    it('concurrent publish is rejected (lock contention)', async () => {
      // Acquire the lock manually to simulate a concurrent publish
      const { acquireLock } = await import('../../srv/jobs/job-lock.js');
      const locked = await acquireLock('content-publish', 'other-instance', 30000);
      expect(locked).toBe(true);

      const res = await project.axios.post('/content/publish', {
        trigger: 'concurrent',
        files: makePayload({ 'x': '<p>x</p>' })
      }, {
        headers: { Authorization: `Bearer ${API_KEY}` },
        validateStatus: () => true
      });

      expect(res.status).toBe(409);
      expect(res.data.error).toContain('in progress');

      // Clean up lock
      const { releaseLock } = await import('../../srv/jobs/job-lock.js');
      await releaseLock('content-publish', 'other-instance');
    });

    it('large slug name (255 chars) works correctly', async () => {
      const longSlug = 'a'.repeat(255);
      const html = '<p>Long slug test</p>';

      const res = await project.axios.post('/content/publish', {
        trigger: 'long-slug',
        files: makePayload({ [longSlug]: html })
      }, { headers: { Authorization: `Bearer ${API_KEY}` } });

      expect(res.status).toBe(201);

      const serveRes = await project.axios.get(`/content/tutorials/${longSlug}`);
      expect(serveRes.status).toBe(200);
      expect(serveRes.data).toBe(html);
    });

    it('publish with unicode content is handled correctly', async () => {
      const html = '<h1>Tutorial ñ</h1><p>Ünïcödé côntènt 日本語</p>';
      const slug = 'unicode-tutorial';

      await project.axios.post('/content/publish', {
        trigger: 'unicode',
        files: makePayload({ [slug]: html })
      }, { headers: { Authorization: `Bearer ${API_KEY}` } });

      const res = await project.axios.get(`/content/tutorials/${slug}`);
      expect(res.status).toBe(200);
      expect(res.data).toBe(html);
    });

    it('ETag conditional request cycle works across versions', async () => {
      const slug = 'etag-lifecycle';
      const v1 = '<p>v1</p>';
      const v2 = '<p>v2</p>';

      // Publish v1
      await project.axios.post('/content/publish', {
        trigger: 'v1',
        files: makePayload({ [slug]: v1 })
      }, { headers: { Authorization: `Bearer ${API_KEY}` } });

      // Get ETag for v1
      const res1 = await project.axios.get(`/content/tutorials/${slug}`);
      const etagV1 = res1.headers['etag'];

      // Conditional request with v1 ETag → 304
      const cond1 = await project.axios.get(`/content/tutorials/${slug}`, {
        headers: { 'If-None-Match': etagV1 },
        validateStatus: () => true
      });
      expect(cond1.status).toBe(304);

      // Publish v2
      await project.axios.post('/content/publish', {
        trigger: 'v2',
        files: makePayload({ [slug]: v2 })
      }, { headers: { Authorization: `Bearer ${API_KEY}` } });

      // Conditional request with old v1 ETag → 200 (content changed)
      const cond2 = await project.axios.get(`/content/tutorials/${slug}`, {
        headers: { 'If-None-Match': etagV1 },
        validateStatus: () => true
      });
      expect(cond2.status).toBe(200);
      expect(cond2.data).toBe(v2);

      // Get new ETag for v2
      const etagV2 = cond2.headers['etag'];
      expect(etagV2).not.toBe(etagV1);

      // Conditional request with v2 ETag → 304
      const cond3 = await project.axios.get(`/content/tutorials/${slug}`, {
        headers: { 'If-None-Match': etagV2 },
        validateStatus: () => true
      });
      expect(cond3.status).toBe(304);
    });
  });
});
