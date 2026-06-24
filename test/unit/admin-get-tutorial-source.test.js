// test/unit/admin-get-tutorial-source.test.js
//
// Tests for the AdminService.getTutorialSource(slug) action wired by
// PR-2 of spec 2026-06-24-tutorials-admin-tile-expansion-design.
//
// Verifies:
//   - Action returns decompressed markdown + sourceHash + contentHash
//   - Returns null markdown for legacy rows (sourceContent=null)
//   - Returns empty result when no active ContentManifest exists
//   - Handles slug case-insensitively

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import cds from '@sap/cds';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

cds.test('serve', '--project', '.', '--in-memory');

const ADMIN = { id: 'admin@test', roles: ['Admin'] };

function sha256(s) {
  return createHash('sha256').update(s).digest('hex');
}

describe('AdminService.getTutorialSource', () => {
  let ContentFiles, ContentManifest;
  let srv;

  beforeAll(async () => {
    ({ ContentFiles, ContentManifest } = cds.entities('com.sap.developers.ims'));
    srv = await cds.connect.to('AdminService');
  });

  beforeEach(async () => {
    await DELETE.from(ContentFiles);
    await DELETE.from(ContentManifest);
  });

  it('returns decompressed markdown + hashes for an active row', async () => {
    const md = '# Hello\n\nThis is the source.';
    const html = '<h1>Hello</h1>\n\n<p>This is the source.</p>';
    const srcHash = sha256(md);
    const contentHash = sha256(html);

    await INSERT.into(ContentManifest).entries({ version: 7, status: 'ACTIVE' });
    await INSERT.into(ContentFiles).entries({
      version: 7,
      slug: 'test-tutorial',
      content: gzipSync(Buffer.from(html, 'utf8')),
      contentHash,
      sourceContent: gzipSync(Buffer.from(md, 'utf8')),
      sourceHash: srcHash,
      sizeBytes: html.length,
      compressedBytes: 0,
      mimeType: 'text/html'
    });

    const result = await srv.tx({ user: ADMIN }, (tx) =>
      tx.send('getTutorialSource', { slug: 'test-tutorial' })
    );

    expect(result.markdown).toBe(md);
    expect(result.sourceHash).toBe(srcHash);
    expect(result.contentHash).toBe(contentHash);
  });

  it('returns null markdown for legacy rows where sourceContent is null', async () => {
    await INSERT.into(ContentManifest).entries({ version: 1, status: 'ACTIVE' });
    await INSERT.into(ContentFiles).entries({
      version: 1,
      slug: 'legacy-tutorial',
      content: gzipSync(Buffer.from('<h1>x</h1>', 'utf8')),
      contentHash: sha256('x'),
      sourceContent: null,
      sourceHash: null,
      sizeBytes: 10,
      compressedBytes: 0,
      mimeType: 'text/html'
    });

    const result = await srv.tx({ user: ADMIN }, (tx) =>
      tx.send('getTutorialSource', { slug: 'legacy-tutorial' })
    );

    expect(result.markdown).toBeNull();
    expect(result.sourceHash).toBeNull();
  });

  it('returns empty result when no active manifest exists', async () => {
    const result = await srv.tx({ user: ADMIN }, (tx) =>
      tx.send('getTutorialSource', { slug: 'anything' })
    );
    expect(result.markdown).toBeNull();
    expect(result.sourceHash).toBeNull();
  });

  it('returns empty result when slug not found in active version', async () => {
    await INSERT.into(ContentManifest).entries({ version: 1, status: 'ACTIVE' });
    const result = await srv.tx({ user: ADMIN }, (tx) =>
      tx.send('getTutorialSource', { slug: 'missing-slug' })
    );
    expect(result.markdown).toBeNull();
  });

  it('matches slug case-insensitively (mirrors serveHandler behaviour)', async () => {
    const md = '# Mixed case test';
    await INSERT.into(ContentManifest).entries({ version: 1, status: 'ACTIVE' });
    await INSERT.into(ContentFiles).entries({
      version: 1,
      slug: 'my-tutorial',
      content: gzipSync(Buffer.from('<h1>x</h1>', 'utf8')),
      contentHash: sha256('x'),
      sourceContent: gzipSync(Buffer.from(md, 'utf8')),
      sourceHash: sha256(md),
      sizeBytes: 10,
      compressedBytes: 0,
      mimeType: 'text/html'
    });

    const result = await srv.tx({ user: ADMIN }, (tx) =>
      tx.send('getTutorialSource', { slug: 'MY-Tutorial' })
    );
    expect(result.markdown).toBe(md);
  });

  it('400 errors when slug parameter is missing', async () => {
    await expect(
      srv.tx({ user: ADMIN }, (tx) => tx.send('getTutorialSource', {}))
    ).rejects.toThrow(/slug parameter is required/);
  });
});
