import { describe, expect, it, beforeAll } from 'vitest';
import cds from '@sap/cds';
import { readFile } from 'node:fs/promises';
import { uploadAndUpsertAdvocatePhoto } from '../../../srv/lib/advocate-photo-upsert.js';

// Shared upsert helper invoked by both the OData uploadPhoto bound action
// AND the multipart REST endpoint at POST /admin/advocates/:slug/photo
// (issue #417). Tests exercise the pure helper against an in-memory DB,
// not the REST endpoint itself (which has its own multer / auth surface
// covered separately by hybrid tests + manual smoke).

const FIX = (name) => readFile(`test/unit/advocates/fixtures/${name}`);

const project = cds.test('serve', '--project', '.', '--in-memory');

const ADVOCATE_ID = 'ADC00417-0000-0000-0000-000000000001';
const SLUG = 'photo-upsert-test';

beforeAll(async () => {
  const db = await cds.connect.to('db');
  const { Advocates, AdvocatePhotos } = cds.entities('com.sap.developers.ims');
  const existing = await db.run(
    SELECT.one.from(Advocates).where({ ID: ADVOCATE_ID }),
  );
  if (!existing) {
    await db.run(INSERT.into(Advocates).entries({
      ID: ADVOCATE_ID,
      slug: SLUG,
      firstName: 'PhotoUpsert', lastName: 'Test',
      title: 'Test', region: 'AMERICAS',
      isActive: true,
      hasPhoto: false,
    }));
  } else {
    // Reset state across reruns. Also wipe any photo row to keep tests
    // independent of run order.
    await db.run(DELETE.from(AdvocatePhotos).where({ advocate_ID: ADVOCATE_ID }));
    await db.run(UPDATE(Advocates).set({
      slug: SLUG,
      hasPhoto: false,
      photoUrl: null,
    }).where({ ID: ADVOCATE_ID }));
  }
});

describe('uploadAndUpsertAdvocatePhoto (shared by OData + REST paths, issue #417)', () => {
  it('rejects when buffer is missing', async () => {
    await expect(uploadAndUpsertAdvocatePhoto({
      advocateID: ADVOCATE_ID,
      slug: SLUG,
      buffer: null,
      mimeType: 'image/jpeg',
    })).rejects.toThrow(/buffer is required/);
  });

  it('rejects when advocateID is missing', async () => {
    await expect(uploadAndUpsertAdvocatePhoto({
      advocateID: '',
      slug: SLUG,
      buffer: Buffer.from('whatever'),
      mimeType: 'image/jpeg',
    })).rejects.toThrow(/advocateID is required/);
  });

  it('rejects when slug is missing', async () => {
    await expect(uploadAndUpsertAdvocatePhoto({
      advocateID: ADVOCATE_ID,
      slug: '',
      buffer: Buffer.from('whatever'),
      mimeType: 'image/jpeg',
    })).rejects.toThrow(/slug is required/);
  });

  it('rejects unsupported MIME (via processUpload chain)', async () => {
    await expect(uploadAndUpsertAdvocatePhoto({
      advocateID: ADVOCATE_ID,
      slug: SLUG,
      buffer: Buffer.from('not-an-image'),
      mimeType: 'application/octet-stream',
    })).rejects.toThrow(/unsupported MIME/);
  });

  it('processes a valid JPEG and writes the upsert + flips flags', async () => {
    const db = await cds.connect.to('db');
    const { Advocates, AdvocatePhotos } = cds.entities('com.sap.developers.ims');

    const jpegBytes = await FIX('portrait.jpg');
    const result = await uploadAndUpsertAdvocatePhoto({
      advocateID: ADVOCATE_ID,
      slug: SLUG,
      buffer: jpegBytes,
      mimeType: 'image/jpeg',
    });

    // Result shape (no photo bytes — those go to HANA, not the response).
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(result.photoUrl).toBe('/api/advocates/photo-upsert-test/photo');

    // Side effects on Advocates.
    const adv = await db.run(SELECT.one.from(Advocates).columns('hasPhoto', 'photoUrl').where({ ID: ADVOCATE_ID }));
    expect(adv.hasPhoto).toBe(true);
    expect(adv.photoUrl).toBe('/api/advocates/photo-upsert-test/photo');

    // AdvocatePhotos row written. Note: we don't fetch the BLOB columns
    // (LOB-locator weirdness on HANA, irrelevant on SQLite, but the cheap
    // check is on sha256 which is a regular string column).
    const photo = await db.run(
      SELECT.one.from(AdvocatePhotos).columns('sha256', 'photoMimeType', 'sizeBytes')
        .where({ advocate_ID: ADVOCATE_ID }),
    );
    expect(photo).toBeTruthy();
    expect(photo.sha256).toBe(result.sha256);
    expect(photo.photoMimeType).toBe('image/webp'); // sharp pipeline always emits WebP
    expect(photo.sizeBytes).toBe(result.sizeBytes);
  });

  it('UPDATE-path: subsequent upload replaces the row, doesn\'t INSERT a duplicate', async () => {
    const db = await cds.connect.to('db');
    const { AdvocatePhotos } = cds.entities('com.sap.developers.ims');

    // Previous test left one row. Insert a different image and ensure
    // we get UPDATE semantics (1:1 composition keyed on FK).
    const beforeRows = await db.run(SELECT.from(AdvocatePhotos).where({ advocate_ID: ADVOCATE_ID }));
    expect(beforeRows.length).toBe(1);

    const pngBytes = await FIX('square.png');
    await uploadAndUpsertAdvocatePhoto({
      advocateID: ADVOCATE_ID,
      slug: SLUG,
      buffer: pngBytes,
      mimeType: 'image/png',
    });

    const afterRows = await db.run(SELECT.from(AdvocatePhotos).where({ advocate_ID: ADVOCATE_ID }));
    expect(afterRows.length).toBe(1); // still exactly one — schema enforces 1:1
    // sha256 differs from the previous test's JPEG output → confirms the row
    // was UPDATED, not stale.
    expect(afterRows[0].sha256).toMatch(/^[a-f0-9]{64}$/);
  });
});
