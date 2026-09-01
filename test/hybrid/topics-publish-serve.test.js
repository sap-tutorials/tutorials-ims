// test/hybrid/topics-publish-serve.test.js
//
// Serve-path regression guard for the /content/topics/:slug route against real HANA.
// This is NOT a publish-pipeline test — rows are hand-inserted so the test stays
// focused on the serve path (route resolution, BLOB decompress, Content-Type,
// afterAll teardown). Mirrors test/hybrid/page-publish-serve.test.js exactly.
//
// Leg A: hand-insert a topic-<slug> ContentFiles row (using a live tag slug
//        drawn from /build/topics-tree so resolveTopicBySlug does NOT redirect),
//        GET /content/topics/<slug> → 200 + HTML body contains marker.
// Leg B: GET /build/topics-tree → 200 + non-empty tree; GET /build/topics/<slug>
//        for a slug from the tree → 200 + non-empty payload.
//
// Invariant check: the route rewrites the URL slug to a `topic-<slug>` ContentFiles
// key before calling serveHandler — confirmed in srv/server.js:584:
//   req.params.slug = `topic-${lower}`;
//   return serveHandler(req, res);
import { describe, it, expect, afterAll } from 'vitest';
import cds from '@sap/cds';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const test = cds.test('serve', '--project', '.'); // hybrid: real HANA via cds bind --exec
const NS = 'com.sap.developers.ims';

// Recursively find the first leaf node that has a slug in the topics tree.
function findLeafSlug(nodes) {
  for (const node of nodes || []) {
    if (node.slug) return node.slug;
    if (Array.isArray(node.children)) {
      const found = findLeafSlug(node.children);
      if (found) return found;
    }
  }
  return null;
}

// Shared state — populated by the serve-path test, consumed by teardown.
const state = { testVersion: null, prevActiveVersion: null, liveSlug: null };

// Leg A: Serve-path round-trip — hand-inserts a committed topic row, then
// verifies the CAP route resolves it correctly from HANA.
describe('topics serve path: HANA regression guard (hybrid)', () => {
  it('serves a published topic page with HTML mime from HANA', async (ctx) => {
    const db = await cds.connect.to('db');
    const { ContentFiles, ContentManifest } = cds.entities(NS);

    // Discover a live tag slug so resolveTopicBySlug returns redirectTo:null.
    // Without a real slug the route would 301-redirect to /topics/ before
    // reaching serveHandler (by design — unknown slugs redirect, per spec).
    const treeRes = await test.get('/build/topics-tree');
    expect(treeRes.status).toBe(200);
    const liveSlug = findLeafSlug(treeRes.data?.tree || []);
    if (!liveSlug) {
      // No live tags in this env — serve-path test is meaningless without one.
      ctx.skip();
      return;
    }
    state.liveSlug = liveSlug;

    const html = `<!DOCTYPE html><html><body data-topic="${liveSlug}">topic:${liveSlug}</body></html>`;
    // SELECT.one returns an object, not an array — drop .one to get an array.
    const [{ maxv } = {}] = await db.run(SELECT.from(ContentManifest).columns({ func: 'max', args: [{ ref: ['version'] }], as: 'maxv' }));
    state.testVersion = (maxv || 0) + 1;
    // Capture the previously ACTIVE version so afterAll can restore it.
    const [prev] = await db.run(SELECT.from(ContentManifest).where({ status: 'ACTIVE' }).columns('version').limit(1));
    state.prevActiveVersion = prev?.version ?? null;
    await db.run(INSERT.into(ContentManifest).entries({ version: state.testVersion, status: 'ACTIVE', fileCount: 1, changedSlugs: JSON.stringify([`topic-${liveSlug}`]) }));
    await db.run(UPDATE(ContentManifest).set({ status: 'SUPERSEDED' }).where`version < ${state.testVersion}`);
    const gz = gzipSync(Buffer.from(html));
    await db.run(INSERT.into(ContentFiles).entries({
      slug: `topic-${liveSlug}`, version: state.testVersion, content: gz,
      contentHash: createHash('sha256').update(html).digest('hex'),
      mimeType: 'text/html', sizeBytes: html.length, compressedBytes: gz.length,
    }));
    const res = await test.get(`/content/topics/${liveSlug}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('html');
    expect(String(res.data)).toContain(`topic:${liveSlug}`);
  });

  afterAll(async () => {
    if (state.testVersion == null) return;
    const db = await cds.connect.to('db');
    const { ContentFiles, ContentManifest } = cds.entities(NS);
    // Remove the test ContentFiles row and manifest version we created.
    if (state.liveSlug) {
      await db.run(DELETE.from(ContentFiles).where({ slug: `topic-${state.liveSlug}`, version: state.testVersion }));
    }
    await db.run(DELETE.from(ContentManifest).where({ version: state.testVersion }));
    // Restore the prior ACTIVE manifest that we superseded.
    if (state.prevActiveVersion != null) {
      await db.run(UPDATE(ContentManifest).set({ status: 'ACTIVE' }).where({ version: state.prevActiveVersion }));
    }
  });
});

// Leg B: Build-feed sanity — /build/topics-tree and /build/topics/:slug return
// non-empty payloads from the live tag + KG data.
describe('topics build feeds (hybrid)', () => {
  it('/build/topics-tree returns 200 and a non-empty tree', async (ctx) => {
    const res = await test.get('/build/topics-tree');
    expect(res.status).toBe(200);
    const body = res.data;
    expect(body).toHaveProperty('tree');
    if (!Array.isArray(body.tree) || body.tree.length === 0) {
      // Visible skip — empty tree in this env (e.g. no TutorialTags data).
      ctx.skip();
      return;
    }
    expect(body.tree.length).toBeGreaterThan(0);
  });

  it('/build/topics/:slug returns 200 for a slug drawn from the tree', async (ctx) => {
    const treeRes = await test.get('/build/topics-tree');
    expect(treeRes.status).toBe(200);
    const { tree } = treeRes.data;
    if (!Array.isArray(tree) || tree.length === 0) {
      ctx.skip();
      return;
    }
    const slug = findLeafSlug(tree);
    if (!slug) {
      ctx.skip();
      return;
    }
    const res = await test.get(`/build/topics/${slug}`);
    expect(res.status).toBe(200);
    const body = res.data;
    expect(body).toHaveProperty('slug');
    expect(body.slug).toBe(slug);
  });
});
