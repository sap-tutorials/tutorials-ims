import cds from '@sap/cds';
import { processPetUpload, findDuplicate, insertSubmission } from './petoberfest-photo-store.js';
import { resolveOrCreatePetUser } from '../petoberfest-service.js';
import { getNextLegacyId } from './legacy-id.js';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,254}$/;

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
    await db.run(INSERT.into(TaskRecords).entries({
      user_ID: dbUser.ID,
      taskLegacyId: contest.legacyId,
      taskType: 'PETOBERFEST',
      status: 'COMPLETED',
      progress: 100,
      completionDate: new Date().toISOString(),
      titleSnapshot: contest.title,
      legacyId: await getNextLegacyId('TaskRecords', db),
      attemptNumber: 1,
    }));
    awarded = true;
  }
  return { id, awarded, moderation: 'PENDING', duplicate: false };
}
