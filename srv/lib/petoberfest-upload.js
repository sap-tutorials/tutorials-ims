import cds from '@sap/cds';
import { processPetUpload, findDuplicate, insertSubmission } from './petoberfest-photo-store.js';
import { resolveOrCreatePetUser } from '../petoberfest-service.js';
import { getNextLegacyId } from './legacy-id.js';
import { stampSubmissionId } from './task-record-submission-id.js';
import { rollUpParentsForCompletion } from './completion-rollup.js';
import * as alerting from './alerting.js';

const LOG = cds.log('petoberfest-upload');

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,254}$/;

/** Decoded-image size cap (mirrors the former multer limit). */
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

// Pure alert builder (mirrors buildChannelSubmissionAlert in
// channel-submission-service.js): takes the freshly-inserted submission facts
// and returns the ANS alert envelope to raise, or null when there is nothing to
// announce. No I/O, so subject/body are testable in isolation (#2597). A new
// pet-photo submission awaiting moderation is informational, not urgent →
// NOTICE, which routes to the devrel-deploys channel only, never paging on-call.
export function buildPetoberfestSubmissionAlert(submission = {}) {
  const id = submission.id || submission.ID;
  if (!id) return null;
  const contest = submission.contestTitle || submission.contestSlug || 'a contest';
  const uploader = (submission.uploaderName || '').trim() || submission.uploaderEmail || 'an entrant';
  const petName = (submission.petName || '').trim();
  const bodyLines = [
    `A new Petoberfest photo submission${petName ? ` ("${petName}")` : ''} from ${uploader} for ${contest} is awaiting approval.`,
    'Review it in the admin moderation queue: /admin-ui/#Petoberfest-manage',
  ];
  return {
    eventType: 'PetoberfestSubmissionPending',
    severity: 'NOTICE',
    subject: `Petoberfest submission awaiting approval: ${petName || contest}`,
    body: bodyLines.join(' '),
  };
}


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

  // #2597: notify DevRel that a new submission landed in the moderation queue.
  // Fire-and-forget beside the persisted row — alerting.raise is itself
  // fail-open (DB-gated via ChatSettings.alertsEnabled, 5s-capped, never
  // throws), so a degraded ANS path can never break or slow the entrant's
  // upload. Mirrors channel-submission-service.js. A per-ID resourceName keeps
  // each distinct submission outside the plugin's dedup window. uploaderName is
  // often null (token lacks given_name/family_name), so the builder falls back
  // to the email for a useful alert body.
  const alert = buildPetoberfestSubmissionAlert({
    id,
    petName,
    uploaderName,
    uploaderEmail: user.attr?.email,
    contestTitle: contest.title,
    contestSlug: contest.slug,
  });
  if (alert) {
    alerting
      .raise({ ...alert, category: 'ALERT', resource: { resourceName: `petoberfest-submission-${id}`, resourceType: 'moderation-queue' } })
      .catch((err) => LOG.warn('petoberfest submission alert raise failed (swallowed):', err?.message ?? err));
  }

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
