import { describe, expect, it, beforeAll } from 'vitest';
import cds from '@sap/cds';
import { readFile } from 'node:fs/promises';
import {
  processUpload,
  fetchPhoto,
  _resetCache,
} from '../../../srv/lib/advocate-photo-store.js';

cds.test('serve', '--project', '.', '--in-memory');

// Seed the two advocates these tests rely on. The CSVs were removed from
// db/data so prod deploys don't clobber admin edits — tests now create
// their own fixtures.
beforeAll(async () => {
  const db = await cds.connect.to('db');
  const { Advocates } = cds.entities('com.sap.developers.ims');
  const existing = await db.run(SELECT.from(Advocates).columns('slug'));
  const slugs = new Set(existing.map((r) => r.slug));
  const rows = [];
  // NOTE: seed rows use 'Fixture*' firstNames, NOT '__TEST__*'. The slug
  // already carries the anti-shadow safety marker (no real advocate could
  // get '__test__advocate-link-*'). firstName intentionally stays out of
  // the '__TEST__%' namespace for cross-file consistency with
  // api.test.js, whose afterAll cleanup deletes firstName LIKE
  // '__TEST__%' — if both files ever run in the same vitest worker,
  // shared IDs/slugs and shared firstName conventions matter.
  if (!slugs.has('__test__advocate-link-amer-1')) {
    rows.push({
      ID: 'ADC00001-0000-0000-0000-000000000001',
      slug: '__test__advocate-link-amer-1',
      firstName: 'FixtureAmer', lastName: 'One',
      region: 'AMERICAS', isActive: true,
    });
  }
  if (!slugs.has('__test__advocate-link-emea-1')) {
    rows.push({
      ID: 'ADC00001-0000-0000-0000-000000000002',
      slug: '__test__advocate-link-emea-1',
      firstName: 'FixtureEmea', lastName: 'One',
      region: 'EMEA', isActive: true,
    });
  }
  if (rows.length) await db.run(INSERT.into(Advocates).entries(rows));
});

describe('fetchPhoto (read path)', () => {
  beforeAll(async () => {
    _resetCache();
  });

  it('returns null when slug does not exist', async () => {
    const out = await fetchPhoto('absolutely-no-such-slug', 'full');
    expect(out).toBeNull();
  });

  it('returns null when advocate exists but has no photo row', async () => {
    // The seeded amer fixture row has hasPhoto=false initially and no
    // AdvocatePhotos row exists for it before any test inserts one.
    // Run this BEFORE the round-trip test below.
    const out = await fetchPhoto('__test__advocate-link-emea-1', 'full');
    expect(out).toBeNull();
  });

  it('returns 256 WebP bytes after processUpload + insert (round-trip)', async () => {
    _resetCache();
    const buf = await readFile('test/unit/advocates/fixtures/portrait.jpg');
    const processed = await processUpload(buf, 'image/jpeg');

    const db = await cds.connect.to('db');
    const { Advocates, AdvocatePhotos } = cds.entities('com.sap.developers.ims');
    const advocate = await db.run(
      SELECT.one.from(Advocates).where({ slug: '__test__advocate-link-amer-1' }),
    );
    expect(advocate).toBeTruthy();

    // Idempotent test: delete any prior photo row for this advocate first
    // so re-runs in the same session don't hit a unique-key violation.
    await db.run(DELETE.from(AdvocatePhotos).where({ advocate_ID: advocate.ID }));

    await db.run(
      INSERT.into(AdvocatePhotos).entries({
        advocate_ID: advocate.ID,
        photo256: processed.photo256,
        photo64: processed.photo64,
        photoMimeType: 'image/webp',
        sizeBytes: processed.sizeBytes,
        sha256: processed.sha256,
        uploadedAt: new Date().toISOString(),
      }),
    );

    const out = await fetchPhoto('__test__advocate-link-amer-1', 'full');
    expect(out).toBeTruthy();
    expect(out.mimeType).toBe('image/webp');
    expect(out.etag).toBe('"' + processed.sha256 + '"');
    expect(Buffer.compare(out.buffer, processed.photo256)).toBe(0);
  });

  it('returns 64 WebP bytes for size=thumb', async () => {
    const out = await fetchPhoto('__test__advocate-link-amer-1', 'thumb');
    expect(out).toBeTruthy();
    expect(out.mimeType).toBe('image/webp');
    // 64x64 WebP for our solid-color fixture is well under 1 KB.
    expect(out.buffer.length).toBeLessThan(2_000);
  });

  it('serves cached results on the second call (LRU)', async () => {
    // First call already cached the entry above. The second call should
    // return the SAME object reference (Map.get returns the stored object).
    const a = await fetchPhoto('__test__advocate-link-amer-1', 'full');
    const b = await fetchPhoto('__test__advocate-link-amer-1', 'full');
    expect(b).toBe(a);
  });

  it('treats unknown size values as full (defensive default)', async () => {
    const full = await fetchPhoto('__test__advocate-link-amer-1', 'full');
    const thumb = await fetchPhoto('__test__advocate-link-amer-1', 'thumb');
    const fallback = await fetchPhoto('__test__advocate-link-amer-1', 'gibberish');
    expect(fallback).toBeTruthy();
    // 'gibberish' must route to the same column as 'full', not 'thumb'.
    expect(Buffer.compare(fallback.buffer, full.buffer)).toBe(0);
    expect(Buffer.compare(fallback.buffer, thumb.buffer)).not.toBe(0);
  });
});
