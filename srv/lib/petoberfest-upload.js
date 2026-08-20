import cds from '@sap/cds';
import { processPetUpload, findDuplicate, insertSubmission } from './petoberfest-photo-store.js';
import { resolveOrCreatePetUser } from '../petoberfest-service.js';
import { getNextLegacyId } from './legacy-id.js';
import { stampSubmissionId } from './task-record-submission-id.js';
import { rollUpParentsForCompletion } from './completion-rollup.js';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,254}$/;

/** Decoded-image size cap (mirrors the former multer limit). */
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

/**
 * Decode a JSON upload payload into a raw image Buffer.
 * Accepts a bare base64 string or a `data:<mime>;base64,<...>` URL.
 * Throws typed errors (`MISSING_FIELD` / `BAD_IMAGE` / `TOO_LARGE`) so the route can
 * map them to the same 400 codes the multipart path used. Image content itself is
 * validated downstream by `processPetUpload` (MIME, animated, dimensions, real image).
 */
export function decodePhotoUpload(body) {
  const { photoBase64, mimeType } = body || {};
  if (!photoBase64 || typeof photoBase64 !== 'string') {
    const e = new Error("missing 'photoBase64' field"); e.code = 'MISSING_FIELD'; throw e;
  }
  const b64 = photoBase64.startsWith('data:')
    ? photoBase64.slice(photoBase64.indexOf(',') + 1)
    : photoBase64;
  const buffer = Buffer.from(b64, 'base64');
  if (buffer.length === 0) {
    const e = new Error('empty or invalid base64 photo'); e.code = 'BAD_IMAGE'; throw e;
  }
  if (buffer.length > MAX_PHOTO_BYTES) {
    const e = new Error('photo too large (max 10 MB)'); e.code = 'TOO_LARGE'; throw e;
  }
  return { buffer, mimeType: typeof mimeType === 'string' ? mimeType : undefined };
}

export async function uploadPetSubmission(db, { slug, user, buffer, mimeType, petName }) {
  const s = String(slug || '').toLowerCase();
  if (!SLUG_RE.test(s)) throw new Error('uploadPetSubmission: bad slug');

  const { Petoberfests, TaskRecords } = cds.entities('com.sap.developers.ims');
  // slug-canonical: pre-canonicalized
  const contest = await db.run(SELECT.one.from(Petoberfests).where({ slug: s }));
  if (!contest) { const e = new Error('contest not found'); e.code = 'NOT_FOUND'; throw e; }

  const dbUser = await resolveOrCreatePetUser(db, user);
  if (!dbUser) { const e = new Error('unauthenticated'); e.code = 'UNAUTHENTICATED'; throw e; }

  const processed = await processPetUpload(buffer, mimeType);   // throws on bad/animated/oversize

  if (await findDuplicate(db, { petoberfestID: contest.ID, userID: dbUser.ID, sha256: processed.sha256 })) {
    return { id: null, awarded: false, moderation: null, duplicate: true };
  }

  const uploaderName = [user.attr?.given_name, user.attr?.family_name].filter(Boolean).join(' ').trim() || null;
  const { id } = await insertSubmission(db, {
    petoberfestID: contest.ID, userID: dbUser.ID,
    petName: petName ? String(petName).slice(0, 120) : null,
    uploaderName, ...processed,
  });

  // Idempotent award: skip if a non-SUPERSEDED PETOBERFEST record already exists for this user+contest.
  const existing = await db.run(SELECT.one.from(TaskRecords).where({
    user_ID: dbUser.ID, taskLegacyId: contest.legacyId, taskType: 'PETOBERFEST', status: { '!=': 'SUPERSEDED' },
  }));
  let awarded = false;
  if (!existing) {
    await db.run(INSERT.into(TaskRecords).entries(stampSubmissionId({
      user_ID: dbUser.ID,
      taskLegacyId: contest.legacyId,
      taskType: 'PETOBERFEST',
      status: 'COMPLETED',
      progress: 100,
      completionDate: new Date().toISOString(),
      titleSnapshot: contest.title,
      legacyId: await getNextLegacyId('TaskRecords', db),
      attemptNumber: 1,
    })));
    awarded = true;
    // Recompute parent missions (a petoberfest can be a mission item). Never throws.
    await rollUpParentsForCompletion({ dbUser, task: { taskType: 'PETOBERFEST', taskLegacyId: contest.legacyId }, db });
  }
  return { id, awarded, moderation: 'PENDING', duplicate: false };
}
