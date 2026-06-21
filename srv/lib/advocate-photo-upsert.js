// Shared upload-and-upsert logic for advocate photos.
//
// Two call sites use this:
//   1. AdminService.uploadPhoto bound action (srv/handlers/advocate-handlers.js)
//      — base64 + OData $batch envelope. Original v1 path, kept for back-compat
//      until the FE V4 controller migrates fully to the REST endpoint.
//   2. POST /admin/advocates/:slug/photo (srv/server.js)
//      — multipart/form-data REST endpoint. Issue #417 — the canonical shape
//      for binary uploads going forward.
//
// Both share the sharp pipeline, the AdvocatePhotos UPSERT semantics, and the
// Advocates.hasPhoto/photoUrl/photoUpdatedAt flip. Centralized so the
// invariants stay consistent across paths.

import cds from '@sap/cds';
import { processUpload } from './advocate-photo-store.js';
import { urlForSlug } from '../handlers/advocate-handlers.js';

/**
 * Run the sharp pipeline on raw image bytes and upsert the AdvocatePhotos
 * row + flip the Advocates flags. Returns the processed photo's hash + size
 * so the caller can echo back to the client.
 *
 * @param {object} args
 * @param {string} args.advocateID    UUID of the advocate to attach the photo to
 * @param {string} args.slug          Advocate slug (for photoUrl computation)
 * @param {Buffer} args.buffer        Raw image bytes
 * @param {string} args.mimeType      Content-Type from the upload (e.g. 'image/jpeg')
 * @returns {Promise<{ sizeBytes: number, sha256: string, photoUrl: string }>}
 *   The processed output metadata (NOT the bytes — those go to HANA).
 *   `photoUrl` is the new value written to Advocates.photoUrl.
 *
 * Throws if processUpload rejects (oversized / wrong MIME / unparseable
 * bytes). Caller should map to HTTP 400.
 */
export async function uploadAndUpsertAdvocatePhoto({ advocateID, slug, buffer, mimeType }) {
  if (!advocateID) throw new Error('uploadAndUpsertAdvocatePhoto: advocateID is required');
  if (!slug) throw new Error('uploadAndUpsertAdvocatePhoto: slug is required');
  if (!Buffer.isBuffer(buffer)) throw new Error('uploadAndUpsertAdvocatePhoto: buffer is required');

  // sharp pipeline: validate + resize to 256/64 WebP. Throws on any failure.
  const processed = await processUpload(buffer, mimeType || 'image/jpeg');

  const db = await cds.connect.to('db');
  const { Advocates, AdvocatePhotos } = cds.entities('com.sap.developers.ims');
  const now = new Date().toISOString();
  const photoUrl = urlForSlug(slug);

  // Upsert the photo row. The composition is 1:1 keyed on the FK, so we
  // explicitly check existence + INSERT or UPDATE rather than rely on a
  // database-specific UPSERT.
  const existing = await db.run(
    SELECT.one.from(AdvocatePhotos).columns('advocate_ID').where({ advocate_ID: advocateID }),
  );
  if (existing) {
    await db.run(
      UPDATE(AdvocatePhotos).set({
        photo256: processed.photo256,
        photo64: processed.photo64,
        photoMimeType: processed.photoMimeType,
        sha256: processed.sha256,
        sizeBytes: processed.sizeBytes,
        uploadedAt: now,
      }).where({ advocate_ID: advocateID }),
    );
  } else {
    await db.run(
      INSERT.into(AdvocatePhotos).entries({
        advocate_ID: advocateID,
        photo256: processed.photo256,
        photo64: processed.photo64,
        photoMimeType: processed.photoMimeType,
        sha256: processed.sha256,
        sizeBytes: processed.sizeBytes,
        uploadedAt: now,
      }),
    );
  }

  // Flip the Advocates flags AND maintain photoUrl invariant (issue #415).
  await db.run(
    UPDATE(Advocates).set({
      hasPhoto: true,
      photoUpdatedAt: now,
      photoUrl,
    }).where({ ID: advocateID }),
  );

  return {
    sizeBytes: processed.sizeBytes,
    sha256: processed.sha256,
    photoUrl,
  };
}
