// srv/__tests__/lib/prerelease-nav.test.js
//
// TDD for Task 2: Live gated nav feed for ROLE_GATED tutorials (#3168).
// Tests that preReleaseNavHandler returns ONLY ROLE_GATED tutorials (incl.
// standalone ones not in any published mission), with Cache-Control: private,
// no-store, and the correct item shape.
//
// Also asserts the inverse: the public navHandler fallback excludes ROLE_GATED.

import cds from '@sap/cds';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { gzipSync } from 'node:zlib';
import { preReleaseNavHandler, navHandler } from '../../lib/content-store.js';

const NS = 'com.sap.developers.ims';

// --- Mock Express req/res helpers ---

function mockReq() {
  return {
    url: '/content/tutorials-prerelease/_nav',
    params: {},
    headers: {},
    get(k) { return this.headers[k.toLowerCase()]; },
  };
}

function mockRes() {
  const r = {
    headers: {},
    body: null,
    _status: 200,
    status(code) { r._status = code; return r; },
    setHeader(k, v) { r.headers[k] = v; },
    getHeader(k) { return r.headers[k]; },
    json(b) { r.body = b; return r; },
    send(b) { r.body = b; return r; },
    end(b) { if (b != null) r.body = b; return r; },
  };
  return r;
}

cds.test('serve', '--project', '.', '--in-memory');

// --- Seed helpers ---

async function seedManifestIfNeeded() {
  const { ContentManifest } = cds.entities(NS);
  const existing = await SELECT.one.from(ContentManifest).where({ status: 'ACTIVE' });
  if (!existing) {
    await INSERT.into(ContentManifest).entries({
      version: 1, status: 'ACTIVE', activatedAt: new Date().toISOString(),
    });
  }
}

/**
 * Seed a tutorial with ContentFiles (version 1) + Tutorials row.
 * Uses ContentFiles (not ContentCurrent) because isDeltaRead()=false in the test
 * environment — navHandlerFallback and preReleaseNavHandler fall through to
 * ContentFiles when the flag is off.
 * @param {string} slug
 * @param {{ visibility: string, status?: string }} opts
 */
async function seedTutorial(slug, { visibility = 'LISTED', status = 'ACTIVE' } = {}) {
  const { ContentFiles, Tutorials } = cds.entities(NS);
  const html = `<html><body>Content for ${slug}</body></html>`;

  await seedManifestIfNeeded();

  await INSERT.into(ContentFiles).entries({
    slug, version: 1,
    content: gzipSync(Buffer.from(html)),
    sourceContent: gzipSync(Buffer.from(`---\ntitle: ${slug}\n---\n`)),
    contentHash: `hash-${slug}`, sourceHash: `src-${slug}`,
    mimeType: 'text/html', sizeBytes: html.length,
  });

  await INSERT.into(Tutorials).entries({
    ID: cds.utils.uuid(),
    slug, title: `Title ${slug}`,
    status, visibility,
    experienceTag: 'Beginner',
    averageTimeToComplete: 10,
  });
}

describe('preRelease nav feed', () => {
  beforeAll(async () => {
    await cds.connect.to('db');
  });

  beforeEach(async () => {
    const { ContentManifest, ContentFiles, Tutorials } = cds.entities(NS);
    await DELETE.from(ContentFiles);
    await DELETE.from(ContentManifest);
    await DELETE.from(Tutorials);
  });

  it('gated nav feed returns only ROLE_GATED incl. standalone, no-store', async () => {
    // Seed three tutorials: one LISTED, two ROLE_GATED.
    // `gated-standalone` is explicitly NOT in any published mission —
    // the feed must return it (this is the key regression guard).
    await seedTutorial('listed-a', { visibility: 'LISTED' });
    await seedTutorial('gated-standalone', { visibility: 'ROLE_GATED' });
    await seedTutorial('gated-b', { visibility: 'ROLE_GATED' });

    const res = mockRes();
    await preReleaseNavHandler(mockReq(), res);

    expect(res._status).toBe(200);
    const slugs = res.body.tutorials.map(t => t.slug);

    // Both ROLE_GATED tutorials must appear (incl. standalone).
    expect(slugs).toEqual(expect.arrayContaining(['gated-standalone', 'gated-b']));
    // The LISTED tutorial must NOT appear.
    expect(slugs).not.toContain('listed-a');

    // Cache-Control must be private, no-store (not cacheable publicly).
    expect(res.headers['Cache-Control']).toBe('private, no-store');

    // Response shape check.
    expect(res.body).toHaveProperty('version');
    expect(res.body).toHaveProperty('count');
    expect(typeof res.body.count).toBe('number');

    // Item shape: each entry must have the required fields.
    for (const t of res.body.tutorials) {
      expect(t).toHaveProperty('slug');
      expect(t).toHaveProperty('title');
      expect(t).toHaveProperty('time');
      expect(t).toHaveProperty('level');
      expect(t).toHaveProperty('stepCount');
      expect(t).toHaveProperty('displayTags');
    }
  });

  it('public navHandler fallback excludes ROLE_GATED tutorials', async () => {
    // Seed the same set so we can confirm the public fallback excludes ROLE_GATED.
    // The public navHandler serves the baked __nav__ blob when present; with no
    // blob seeded it falls back to navHandlerFallback which must also exclude.
    await seedTutorial('listed-a', { visibility: 'LISTED' });
    await seedTutorial('gated-standalone', { visibility: 'ROLE_GATED' });
    await seedTutorial('gated-b', { visibility: 'ROLE_GATED' });

    const res = mockRes();
    await navHandler(mockReq(), res);

    expect(res._status).toBe(200);
    const slugs = res.body.tutorials.map(t => t.slug);

    // LISTED must appear.
    expect(slugs).toContain('listed-a');
    // ROLE_GATED must NOT appear in the public feed.
    expect(slugs).not.toContain('gated-standalone');
    expect(slugs).not.toContain('gated-b');
  });

  it('INACTIVE ROLE_GATED tutorials are excluded from gated feed', async () => {
    await seedTutorial('gated-active', { visibility: 'ROLE_GATED', status: 'ACTIVE' });
    await seedTutorial('gated-inactive', { visibility: 'ROLE_GATED', status: 'INACTIVE' });

    const res = mockRes();
    await preReleaseNavHandler(mockReq(), res);

    const slugs = res.body.tutorials.map(t => t.slug);
    expect(slugs).toContain('gated-active');
    expect(slugs).not.toContain('gated-inactive');
  });
});
