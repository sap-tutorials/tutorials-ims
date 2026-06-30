/**
 * Verifies GET /content/source-hashes excludes Tutorials.status='INACTIVE'
 * rows from the returned map.
 *
 * Carry-forward keeps INACTIVE rows in the manifest for snapshot integrity;
 * this filter only affects the external-facing endpoint so the daily drift
 * workflow stops re-reporting purged slugs forever.
 *
 * Spec: docs/superpowers/specs/2026-06-30-orphan-purge-design.md §Architecture-1
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

describe('GET /content/source-hashes — INACTIVE filter', () => {
  const namespace = 'com.sap.developers.ims';
  const testManifestVersion = 99999;
  const ts = Date.now();
  const activeSlug = `test-active-${ts}`;
  const inactiveSlug = `test-inactive-${ts}`;

  beforeAll(async () => {
    const { ContentFiles, ContentManifest, Tutorials } = cds.entities(namespace);
    await UPDATE(ContentManifest).where({ status: 'ACTIVE' }).set({ status: 'SUPERSEDED' });
    await INSERT.into(ContentManifest).entries({
      version: testManifestVersion,
      status: 'ACTIVE',
      trigger: 'test',
      hugoVersion: 'test'
    });
    await INSERT.into(ContentFiles).entries([
      { slug: activeSlug,   version: testManifestVersion, sourceHash: 'aaa', content: Buffer.from('x'), contentHash: 'h1', sizeBytes: 1, compressedBytes: 1, mimeType: 'text/html' },
      { slug: inactiveSlug, version: testManifestVersion, sourceHash: 'bbb', content: Buffer.from('y'), contentHash: 'h2', sizeBytes: 1, compressedBytes: 1, mimeType: 'text/html' },
    ]);
    await INSERT.into(Tutorials).entries([
      { slug: activeSlug,   status: 'ACTIVE',   title: 'Active test' },
      { slug: inactiveSlug, status: 'INACTIVE', title: 'Inactive test' },
    ]);
  });

  afterAll(async () => {
    const { ContentFiles, ContentManifest, Tutorials } = cds.entities(namespace);
    await DELETE.from(ContentFiles).where({ version: testManifestVersion });
    await DELETE.from(ContentManifest).where({ version: testManifestVersion });
    await DELETE.from(Tutorials).where({ slug: { in: [activeSlug, inactiveSlug] } });
  });

  it('includes ACTIVE-status slug in the response map', async () => {
    const res = await project.get('/content/source-hashes');
    expect(res.status).toBe(200);
    expect(res.data[activeSlug]).toBe('aaa');
  });

  it('excludes INACTIVE-status slug from the response map', async () => {
    const res = await project.get('/content/source-hashes');
    expect(res.status).toBe(200);
    expect(res.data[inactiveSlug]).toBeUndefined();
  });
});
