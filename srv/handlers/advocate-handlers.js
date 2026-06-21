// CDS handlers for Advocates entities, registered onto AdminService at init time.

import { deriveSlug, suffixOnCollision } from '../lib/advocate-slug.js';
import { processUpload, toBuffer } from '../lib/advocate-photo-store.js';

/**
 * Build the public REST URL for an advocate's photo.
 *
 * The same path served by srv/routes/advocates-public.js (`GET
 * /api/advocates/:slug/photo`). Centralized here so all
 * `hasPhoto`-toggling code paths emit consistent URLs and the route
 * shape lives in one place — if we ever rename the route, only one
 * spot + a backfill SQL needs to change.
 *
 * Lowercase the slug to match the route's `LOWER(SLUG)` lookup in
 * advocate-photo-store.js (HANA SLUG column preserves case).
 */
export function urlForSlug(slug) {
  if (!slug) return null;
  return `/api/advocates/${String(slug).toLowerCase()}/photo`;
}

/**
 * Photo upload pipeline. Mutates `data` in place — replaces incoming bytes
 * with the processed 256/64 WebP outputs and stamps sha256/size/uploadedAt.
 * Exported separately so unit tests can exercise it without going through
 * the draft layer.
 */
export async function processPhotoUpload(req) {
  const data = req.data;
  if (!data.photo256) return;
  const buf = await toBuffer(data.photo256);
  const mime = data.photoMimeType
    || req.headers?.['content-type']
    || 'image/jpeg';
  const out = await processUpload(buf, mime);
  data.photo256      = out.photo256;
  data.photo64       = out.photo64;
  data.photoMimeType = out.photoMimeType;
  data.sha256        = out.sha256;
  data.sizeBytes     = out.sizeBytes;
  data.uploadedAt    = new Date().toISOString();
}

/**
 * Wire CDS handlers for Advocates entities onto the AdminService instance.
 * Caller passes `this` from inside AdminService.init().
 */
export function register(srv) {
  const { Advocates, AdvocatePhotos } = srv.entities;

  // Slug auto-derivation.
  //
  // Fiori draft lifecycle on @odata.draft.enabled entities:
  //   - 'NEW' on Advocates.drafts — initial draft creation from Fiori UI
  //     (POST /admin/Advocates with firstName/lastName in the body).
  //   - 'CREATE' on Advocates — programmatic non-draft writes (tests, scripts).
  //
  // We derive on draft-create because firstName/lastName ARE present in the
  // initial payload, and the draft response immediately reflects the slug
  // for assertions. Collision check queries both active and draft rows.
  const deriveAdvocateSlug = async (req) => {
    const data = req.data;
    if (!data.slug) {
      const base = deriveSlug(data.firstName, data.lastName);
      const [activeRows, draftRows] = await Promise.all([
        SELECT.from(Advocates).columns('slug'),
        SELECT.from(Advocates.drafts).columns('slug'),
      ]);
      const taken = new Set(
        [...activeRows, ...draftRows].map((r) => r.slug).filter(Boolean),
      );
      data.slug = suffixOnCollision(base, taken);
    } else {
      data.slug = String(data.slug).toLowerCase();
    }
  };

  srv.before('NEW',    'Advocates.drafts', deriveAdvocateSlug);
  srv.before('CREATE', Advocates,          deriveAdvocateSlug);

  // Photo upload pipeline.
  //
  // Fiori UploadSet PUTs the binary against AdvocatePhotos.photo256 per the
  // @Core.MediaType contract. Whether that arrives as CREATE or UPDATE
  // depends on whether a row already exists for the advocate (1:1 enforced
  // by the schema-level key). AdvocatePhotos is draft-enabled because it's
  // a composition under draft-enabled Advocates, so we also wire NEW/PATCH
  // on the .drafts companion.
  //
  // Only fire when the caller actually sent new photo bytes — otherwise an
  // unrelated metadata PATCH would re-process the existing photo.
  srv.before(['CREATE', 'UPDATE'], AdvocatePhotos, processPhotoUpload);
  if (AdvocatePhotos.drafts) {
    srv.before(['NEW', 'PATCH'], AdvocatePhotos.drafts, processPhotoUpload);
  }

  // Flip Advocates.hasPhoto + photoUpdatedAt after a successful photo write.
  // Also sets photoUrl so the OP HeaderInfo.ImageUrl can resolve without a
  // virtual element (issue #415).
  // CAP gives us the inserted/updated row in `data`; the FK column is
  // 'advocate_ID' (because the schema declared `key advocate : Association`).
  const flipHasPhoto = async (data) => {
    const advId = data?.advocate_ID || data?.advocate?.ID;
    if (!advId) return;
    // Look up slug so we can compute the URL — the photo handler didn't
    // see slug (it only knows the FK).
    const adv = await SELECT.one.from(Advocates).columns('slug').where({ ID: advId });
    await UPDATE(Advocates)
      .set({
        hasPhoto: true,
        photoUpdatedAt: new Date().toISOString(),
        photoUrl: urlForSlug(adv?.slug),
      })
      .where({ ID: advId });
  };

  srv.after(['CREATE', 'UPDATE'], AdvocatePhotos, flipHasPhoto);

  // On photo delete, flip the flag back to false AND clear photoUrl so the
  // OP header avatar disappears in lockstep.
  srv.after('DELETE', AdvocatePhotos, async (_unused, req) => {
    const advId = req.data?.advocate_ID;
    if (!advId) return;
    await UPDATE(Advocates)
      .set({
        hasPhoto: false,
        photoUpdatedAt: new Date().toISOString(),
        photoUrl: null,
      })
      .where({ ID: advId });
  });

  // Slug rename: when an Advocates UPDATE changes slug AND hasPhoto is true,
  // photoUrl must be recomputed so the OP header points at the right route.
  // Only fires if the incoming payload includes a 'slug' field (skips
  // partial-updates that don't touch slug); reads the current row to get
  // the latest hasPhoto state.
  srv.after('UPDATE', Advocates, async (_unused, req) => {
    const incomingSlug = req.data?.slug;
    const advId = req.data?.ID || req.params?.[0]?.ID || req.params?.[0];
    if (!incomingSlug || !advId) return;
    const current = await SELECT.one.from(Advocates)
      .columns('hasPhoto', 'photoUrl')
      .where({ ID: advId });
    if (!current?.hasPhoto) return;
    const newUrl = urlForSlug(incomingSlug);
    if (current.photoUrl === newUrl) return; // already in sync
    await UPDATE(Advocates).set({ photoUrl: newUrl }).where({ ID: advId });
  });

  // Bound action: uploadPhoto. Admins call this from the Object Page
  // (or via $batch) with base64-encoded photo bytes + a MIME type. We
  // run the same sharp pipeline the public path uses, upsert the
  // AdvocatePhotos row directly, and stamp hasPhoto + photoUpdatedAt
  // so the public /api/advocates JSON immediately surfaces the photo.
  //
  // Why a bound action (not the Fiori UploadSet on the photo composition):
  // the draft-enabled `Composition of one` whose key IS the parent
  // association doesn't carry uploaded bytes through to our before-CREATE
  // handler — the upload silently drops on activation. This action is
  // the direct, working path.
  srv.on('uploadPhoto', Advocates, async (req) => {
    const advocateID = req.params?.[0]?.ID || req.params?.[0];
    if (!advocateID) {
      return req.error(400, 'uploadPhoto: missing advocate key in path');
    }
    const { photoBase64, mimeType } = req.data || {};
    if (!photoBase64 || typeof photoBase64 !== 'string') {
      return req.error(400, 'uploadPhoto: photoBase64 (string) is required');
    }
    let buffer;
    try {
      // Strip optional `data:image/...;base64,` prefix if a browser sent it.
      const cleaned = photoBase64.replace(/^data:[^,]+,/, '');
      buffer = Buffer.from(cleaned, 'base64');
    } catch {
      return req.error(400, 'uploadPhoto: photoBase64 must be valid base64');
    }
    let processed;
    try {
      processed = await processUpload(buffer, mimeType || 'image/jpeg');
    } catch (e) {
      return req.error(400, 'uploadPhoto: ' + e.message);
    }
    const db = await cds.connect.to('db');
    const now = new Date().toISOString();
    const { AdvocatePhotos: AP } = cds.entities('com.sap.developers.ims');
    const existing = await db.run(
      SELECT.one.from(AP).columns('advocate_ID').where({ advocate_ID: advocateID }),
    );
    if (existing) {
      await db.run(
        UPDATE(AP).set({
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
        INSERT.into(AP).entries({
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
    await db.run(
      UPDATE(Advocates).set({
        hasPhoto: true,
        photoUpdatedAt: now,
        // photoUrl mirrors the public route shape; advocate's slug is already
        // committed by the time uploadPhoto fires (it's set at draft-NEW).
        // Fetch slug here rather than threading it through — keeps the
        // invariant maintained in a single SQL even if the call site is
        // racing with a slug rename (the slug-rename handler runs after).
        photoUrl: urlForSlug(
          (await db.run(SELECT.one.from(Advocates).columns('slug').where({ ID: advocateID })))?.slug,
        ),
      }).where({ ID: advocateID }),
    );
    // Return the refreshed advocate so Fiori re-renders the header avatar.
    return SELECT.one.from(Advocates).where({ ID: advocateID });
  });

  // clearPhoto: drop the AdvocatePhotos row + flip hasPhoto=false.
  srv.on('clearPhoto', Advocates, async (req) => {
    const advocateID = req.params?.[0]?.ID || req.params?.[0];
    if (!advocateID) {
      return req.error(400, 'clearPhoto: missing advocate key in path');
    }
    const db = await cds.connect.to('db');
    const { AdvocatePhotos: AP } = cds.entities('com.sap.developers.ims');
    await db.run(DELETE.from(AP).where({ advocate_ID: advocateID }));
    await db.run(
      UPDATE(Advocates)
        .set({
          hasPhoto: false,
          photoUpdatedAt: new Date().toISOString(),
          photoUrl: null,
        })
        .where({ ID: advocateID }),
    );
    return SELECT.one.from(Advocates).where({ ID: advocateID });
  });
}
