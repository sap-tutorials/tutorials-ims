// Hybrid HANA round-trip test for the advocate photo storage path.
//
// Purpose: prove that fetchPhoto() correctly works around HANA's
// LOB-locator expiry on @Core.MediaType columns. Unit tests cover the
// SQLite path; this is the only place where the raw-SQL HANA branch
// actually runs.
//
// Run with: ALLOW_HYBRID_WRITES=true npm run test:hybrid -- test/hybrid/advocates-photo-hana.test.js
// Requires: `cf login` to a HANA-bound CF space first.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import cds from '@sap/cds';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { processUpload, fetchPhoto, _resetCache } from '../../srv/lib/advocate-photo-store.js';
import { isSafeForWrites } from './_guard.js';

cds.test('serve', '--project', '.', '--profile', 'hybrid');

const TEST_SLUG = '__test__photo-' + Date.now().toString(36);

describe.runIf(isSafeForWrites() && process.env.ALLOW_HYBRID_WRITES === 'true')(
  'AdvocatePhotos round-trip on HANA',
  () => {
    let advId;
    let noPhotoAdvId;
    let noPhotoSlug;
    let processed;

    beforeAll(async () => {
      advId = randomUUID();
      noPhotoAdvId = randomUUID();
      noPhotoSlug = '__test__nophoto-' + Date.now().toString(36);
      processed = await processUpload(
        await readFile('test/unit/advocates/fixtures/portrait.jpg'),
        'image/jpeg',
      );

      const db = await cds.connect.to('db');
      const { Advocates, AdvocatePhotos } = cds.entities('com.sap.developers.ims');
      await db.run(
        INSERT.into(Advocates).entries({
          ID: advId,
          slug: TEST_SLUG,
          firstName: '__TEST__',
          lastName: 'PhotoRoundTrip',
          region: 'AMERICAS',
          isActive: true,
          hasPhoto: true,
        }),
      );
      // Second advocate with NO AdvocatePhotos row — used to assert
      // fetchPhoto returns null on an existing advocate that has not
      // uploaded a photo (the "no photo row" semantic, distinct from
      // "advocate not found").
      await db.run(
        INSERT.into(Advocates).entries({
          ID: noPhotoAdvId,
          slug: noPhotoSlug,
          firstName: '__TEST__',
          lastName: 'NoPhoto',
          region: 'EMEA',
          isActive: true,
          hasPhoto: false,
        }),
      );
      await db.run(
        INSERT.into(AdvocatePhotos).entries({
          advocate_ID: advId,
          photo256: processed.photo256,
          photo64: processed.photo64,
          photoMimeType: 'image/webp',
          sha256: processed.sha256,
          sizeBytes: processed.sizeBytes,
          uploadedAt: new Date().toISOString(),
        }),
      );
      _resetCache();
    });

    afterAll(async () => {
      const db = await cds.connect.to('db');
      const { Advocates, AdvocatePhotos } = cds.entities('com.sap.developers.ims');
      if (advId) {
        await db.run(DELETE.from(AdvocatePhotos).where({ advocate_ID: advId }));
        await db.run(DELETE.from(Advocates).where({ ID: advId }));
      }
      if (noPhotoAdvId) {
        await db.run(DELETE.from(Advocates).where({ ID: noPhotoAdvId }));
      }
    });

    it('reads 256 photo back via raw SQL (LOB-locator workaround)', async () => {
      const out = await fetchPhoto(TEST_SLUG, 'full');
      expect(out).toBeTruthy();
      expect(out.mimeType).toBe('image/webp');
      expect(out.etag).toBe('"' + processed.sha256 + '"');
      // Bytes match what we wrote (sha256 already implies this, but be explicit).
      expect(Buffer.compare(out.buffer, processed.photo256)).toBe(0);
    });

    it('reads 64 thumbnail back via raw SQL', async () => {
      const out = await fetchPhoto(TEST_SLUG, 'thumb');
      expect(out).toBeTruthy();
      expect(out.mimeType).toBe('image/webp');
      expect(Buffer.compare(out.buffer, processed.photo64)).toBe(0);
    });

    it('case-insensitive slug lookup (LOWER(SLUG) in raw SQL)', async () => {
      const upper = await fetchPhoto(TEST_SLUG.toUpperCase(), 'full');
      expect(upper).toBeTruthy();
      expect(Buffer.compare(upper.buffer, processed.photo256)).toBe(0);
    });

    it('returns null for an advocate with no photo row', async () => {
      // Uses the fresh '__test__nophoto-*' advocate created in beforeAll
      // (no AdvocatePhotos row). Self-contained — does not depend on any
      // pre-seeded data that the cleanup script may have removed.
      const out = await fetchPhoto(noPhotoSlug, 'full');
      expect(out).toBeNull();
    });
  },
);
