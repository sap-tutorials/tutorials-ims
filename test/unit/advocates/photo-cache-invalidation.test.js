import { describe, expect, it, beforeAll } from 'vitest';
import cds from '@sap/cds';
import { readFile } from 'node:fs/promises';
import { fetchPhoto, _resetCache } from '../../../srv/lib/advocate-photo-store.js';
import { uploadAndUpsertAdvocatePhoto } from '../../../srv/lib/advocate-photo-upsert.js';

// Regression for the "uploaded photo doesn't change" bug (Tom, 2026-08-12):
// fetchPhoto() memoizes bytes in a module-level LRU keyed by slug:size. The
// write path (uploadAndUpsertAdvocatePhoto) persisted new bytes to the DB but
// NEVER invalidated that cache, so /api/advocates/:slug/photo kept serving the
// previously-cached image from process memory — defeating browser hard-refresh
// AND direct-approuter access. This test drives the invalidation contract.

const FIX = (name) => readFile(`test/unit/advocates/fixtures/${name}`);

cds.test('serve', '--project', '.', '--in-memory');

const ADVOCATE_ID = 'ADCACHE1-0000-0000-0000-000000000001';
const SLUG = 'photo-cache-invalidation-test';

beforeAll(async () => {
  _resetCache();
  const db = await cds.connect.to('db');
  const { Advocates, AdvocatePhotos } = cds.entities('com.sap.developers.ims');
  const existing = await db.run(SELECT.one.from(Advocates).where({ ID: ADVOCATE_ID }));
  if (!existing) {
    await db.run(INSERT.into(Advocates).entries({
      ID: ADVOCATE_ID,
      slug: SLUG,
      firstName: 'PhotoCache', lastName: 'Test',
      region: 'AMERICAS', isActive: true, hasPhoto: false,
    }));
  } else {
    await db.run(DELETE.from(AdvocatePhotos).where({ advocate_ID: ADVOCATE_ID }));
    await db.run(UPDATE(Advocates).set({ slug: SLUG, hasPhoto: false, photoUrl: null }).where({ ID: ADVOCATE_ID }));
  }
});

describe('advocate photo cache invalidation on re-upload', () => {
  it('serves the NEW image bytes after a re-upload (not the stale cached ones)', async () => {
    // 1) Upload image A and read it once — this populates the LRU cache.
    const first = await uploadAndUpsertAdvocatePhoto({
      advocateID: ADVOCATE_ID, slug: SLUG,
      buffer: await FIX('portrait.jpg'), mimeType: 'image/jpeg',
    });
    const readA = await fetchPhoto(SLUG, 'full');
    expect(readA.etag).toBe('"' + first.sha256 + '"');

    // 2) Upload a DIFFERENT image B (different sha256 out of the sharp pipeline).
    const second = await uploadAndUpsertAdvocatePhoto({
      advocateID: ADVOCATE_ID, slug: SLUG,
      buffer: await FIX('square.png'), mimeType: 'image/png',
    });
    expect(second.sha256).not.toBe(first.sha256); // guards the fixtures actually differ

    // 3) The read path must now surface image B — NOT the cached image A.
    const readB = await fetchPhoto(SLUG, 'full');
    expect(readB.etag).toBe('"' + second.sha256 + '"');
    expect(Buffer.compare(readB.buffer, readA.buffer)).not.toBe(0);
  });
});
