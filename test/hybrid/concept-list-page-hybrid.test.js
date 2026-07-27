// test/hybrid/concept-list-page-hybrid.test.js
//
// #1327 Task 2 — verifies GET /content/concepts-index against real HANA.
//
// Unit tests (test/unit/concept-list-page.test.js) cover the model + body
// shaping with injected fakes. This file confirms the HANA-specific concerns:
//   1. buildConceptListModel over the real PublishedConcepts + ConceptRank
//      returns a card count matching live published concepts.
//   2. The full handler composes into the real __shell__ BLOB, gzips, and
//      stamps an ETag from the active ContentManifest version.
//   3. The version-keyed cache serves X-Content-Source: memcache on the 2nd
//      call with a stable ETag (no re-render).
//
// Read-only — no writes, so no ALLOW_HYBRID_WRITES gate. Exercises the handler
// directly with mock req/res (same "logic against real HANA, no HTTP server"
// pattern as content-publish-guard.test.js) to avoid booting an approuter.

import cds from '@sap/cds';
import { describe, it, expect, beforeAll } from 'vitest';
import { gunzipSync } from 'node:zlib';
import { createConceptListPage, buildConceptListModel } from '../../srv/lib/concept-list-page.js';

cds.test('serve', '--project', '.', '--profile', 'hybrid');

const NS = 'com.sap.developers.ims';

// Minimal Express res double capturing status/headers/body.
function mockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    status(c) { this.statusCode = c; return this; },
    send(b) { this.body = b; return this; },
    end() { this.ended = true; return this; },
  };
}

describe('GET /content/concepts-index [hybrid]', () => {
  let isHana = false;

  beforeAll(async () => {
    const db = await cds.connect.to('db');
    isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
  });

  it('model card count matches live PublishedConcepts', async () => {
    if (!isHana) { console.warn('skip: not HANA'); return; }
    const db = await cds.connect.to('db');
    const { PublishedConcepts } = cds.entities('KnowledgeGraphService');
    const [{ n }] = await db.run(
      SELECT.from(PublishedConcepts).columns('count(*) as n'),
    );
    const model = await buildConceptListModel(db);
    expect(model.count).toBe(Number(n));
    expect(model.cards.length).toBe(Number(n));
    // top capped at 100 (or fewer if the corpus is smaller)
    expect(model.top.length).toBe(Math.min(100, Number(n)));
    // every card carries the slim shape
    for (const c of model.cards.slice(0, 5)) {
      expect(c).toHaveProperty('slug');
      expect(c).toHaveProperty('name');
      expect(c).toHaveProperty('tutorialCount');
      expect(c).toHaveProperty('firstLetter');
    }
  }, 60000);

  it('handler returns gzipped HTML with the concepts-index shell + embedded JSON', async () => {
    if (!isHana) { console.warn('skip: not HANA'); return; }
    const { conceptsIndexHandler } = createConceptListPage({ namespace: NS });
    const res = mockRes();
    await conceptsIndexHandler({ headers: {} }, res);

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.headers['etag']).toBeTruthy();

    const html = gunzipSync(res.body).toString('utf-8');
    expect(html).toContain('id="concepts-filter-root"');
    expect(html).toContain('id="concepts-filter-list"');
    // Embedded JSON present and parseable (unless the corpus is empty).
    const m = html.match(/<script type="application\/json" id="concepts-data">([\s\S]*?)<\/script>/);
    if (m) {
      const arr = JSON.parse(m[1]);
      expect(Array.isArray(arr)).toBe(true);
    }
  }, 60000);

  it('second call is a version-keyed cache hit (memcache, stable ETag)', async () => {
    if (!isHana) { console.warn('skip: not HANA'); return; }
    const { conceptsIndexHandler } = createConceptListPage({ namespace: NS });

    const res1 = mockRes();
    await conceptsIndexHandler({ headers: {} }, res1);
    const etag1 = res1.headers['etag'];
    expect(res1.headers['x-content-source']).toBe('fresh');

    const res2 = mockRes();
    await conceptsIndexHandler({ headers: {} }, res2);
    expect(res2.headers['x-content-source']).toBe('memcache');
    expect(res2.headers['etag']).toBe(etag1);

    // If-None-Match with the same ETag → 304.
    const res3 = mockRes();
    await conceptsIndexHandler({ headers: { 'if-none-match': etag1 } }, res3);
    expect(res3.statusCode).toBe(304);
  }, 60000);
});
