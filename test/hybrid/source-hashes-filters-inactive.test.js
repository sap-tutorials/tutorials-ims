/**
 * Hybrid coverage for the /content/source-hashes companion fix.
 *
 * Independent of orphan-purge.test.js so a regression in the filter
 * surfaces here even when the purge endpoint test is green.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';
import { isSafeForWrites } from './_guard.js';

cds.test('serve', '--project', '.', '--profile', 'hybrid');

const writesAllowed = process.env.ALLOW_HYBRID_WRITES === 'true' && isSafeForWrites();
const describeIf = writesAllowed ? describe : describe.skip;

describeIf('/content/source-hashes — INACTIVE filter (hybrid)', () => {
  const ns = 'com.sap.developers.ims';
  const ts = Date.now();
  const slugInactive    = `__test__sourcehashes-inactive-${ts}`;
  const slugActiveSanity = `__test__sourcehashes-active-${ts}`;
  let srvUrl;

  beforeAll(async () => {
    srvUrl = process.env.CAP_BASE_URL || cds.server?.url || `http://localhost:${cds.server?.address?.()?.port ?? 4004}`;

    // Read the ACTIVE manifest version so seeded ContentFiles rows
    // actually show up in /content/source-hashes (which filters by the
    // current active version). Without seeding ContentFiles, the
    // assertion below would pass vacuously — the slug wouldn't be in
    // the response set regardless of the INACTIVE filter clause.
    const { ContentManifest, ContentFiles, Tutorials } = cds.entities(ns);
    const [activeManifest] = await SELECT.from(ContentManifest)
      .where({ status: 'ACTIVE' })
      .columns('version')
      .orderBy('version desc')
      .limit(1);
    if (!activeManifest) throw new Error('No ACTIVE ContentManifest found in DEV — cannot seed test fixtures');
    const activeVersion = activeManifest.version;

    await INSERT.into(Tutorials).entries([
      { slug: slugInactive,    status: 'INACTIVE', title: '__TEST__ Inactive'      },
      { slug: slugActiveSanity, status: 'ACTIVE',   title: '__TEST__ Active sanity' },
    ]);
    await INSERT.into(ContentFiles).entries([
      {
        slug: slugInactive,
        version: activeVersion,
        content: Buffer.from('test'),
        contentHash: 'e'.repeat(64),
        sizeBytes: 4,
        compressedBytes: 4,
        mimeType: 'text/html',
        sourceContent: Buffer.from('# test'),
        sourceHash: 'f'.repeat(64),
      },
      {
        slug: slugActiveSanity,
        version: activeVersion,
        content: Buffer.from('test'),
        contentHash: '1'.repeat(64),
        sizeBytes: 4,
        compressedBytes: 4,
        mimeType: 'text/html',
        sourceContent: Buffer.from('# test'),
        sourceHash: '2'.repeat(64),
      },
    ]);
  });

  afterAll(async () => {
    const { ContentFiles, Tutorials } = cds.entities(ns);
    await DELETE.from(ContentFiles).where({ slug: { in: [slugInactive, slugActiveSanity] } });
    await DELETE.from(Tutorials).where({ slug: { in: [slugInactive, slugActiveSanity] } });
  });

  it('does not return an INACTIVE slug from /content/source-hashes (filter is non-vacuous)', async () => {
    const res = await fetch(`${srvUrl}/content/source-hashes`);
    expect(res.status).toBe(200);
    const map = await res.json();

    // Real coverage of the filter clause: ContentFiles row exists for
    // slugInactive at the active version, but its parent Tutorials row
    // is INACTIVE — the LEFT JOIN's status filter MUST drop it.
    expect(map[slugInactive]).toBeUndefined();

    // Sanity: an ACTIVE Tutorials row WITH a matching ContentFiles row
    // IS returned. This proves the endpoint is producing data and the
    // INACTIVE absence above isn't because the endpoint is empty.
    expect(map[slugActiveSanity]).toBe('2'.repeat(64));
  });
});
