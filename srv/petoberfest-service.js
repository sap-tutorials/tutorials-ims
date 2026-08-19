// srv/petoberfest-service.js
import cds from '@sap/cds';
import { resolveUserSapId } from './lib/resolve-db-user.js';
import { getNextLegacyId } from './lib/legacy-id.js';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,254}$/;

export async function resolveOrCreatePetUser(db, user) {
  const sapId = resolveUserSapId(user);
  if (!sapId) return null;
  const { Users } = cds.entities('com.sap.developers.ims');
  let row = await db.run(SELECT.one.from(Users).where({ sapId }));
  if (!row) {
    const ID = cds.utils.uuid();
    await db.run(INSERT.into(Users).entries({
      ID,
      uuid: cds.utils.uuid(),  // String(36): user.id is email under XSUAA → overflows on long addresses (#1614)
      sapId,
      legacyId: await getNextLegacyId('Users', db),
      email: user.attr?.email || '',
      firstName: user.attr?.given_name || '',
      lastName: user.attr?.family_name || '',
    }));
    row = { ID, sapId };
  }
  return row;
}

export default class PetoberfestService extends cds.ApplicationService {
  async init() {
    const db = await cds.connect.to('db');
    const { Petoberfests, PetSubmissions } = cds.entities('com.sap.developers.ims');

    async function loadContest(slug) {
      if (!slug || !SLUG_RE.test(String(slug).toLowerCase())) return null;
      return db.run(SELECT.one.from(Petoberfests).where({ slug: String(slug).toLowerCase() }));
    }

    this.on('slideshow', async (req) => {
      const contest = await loadContest(req.data.slug);
      if (!contest) return [];
      const rows = await db.run(
        SELECT.from(PetSubmissions)
          .columns('ID as id', 'petName', 'uploaderName', 'uploadedAt')
          .where({ petoberfest_ID: contest.ID, moderation: 'APPROVED' })
          .orderBy({ uploadedAt: 'desc' }));
      return rows;
    });

    this.on('myUploads', async (req) => {
      const contest = await loadContest(req.data.slug);
      if (!contest) return [];
      const dbUser = await resolveOrCreatePetUser(db, req.user);
      if (!dbUser) return req.reject(401, 'Unauthenticated');
      return db.run(
        SELECT.from(PetSubmissions)
          .columns('ID as id', 'petName', 'moderation', 'uploadedAt')
          .where({ petoberfest_ID: contest.ID, user_ID: dbUser.ID })
          .orderBy({ uploadedAt: 'desc' }));
    });

    this.on('withdraw', async (req) => {
      const { TaskRecords } = cds.entities('com.sap.developers.ims');
      const contest = await loadContest(req.data.slug);
      if (!contest) return req.reject(404, 'Contest not found');
      const dbUser = await resolveOrCreatePetUser(db, req.user);
      if (!dbUser) return req.reject(401, 'Unauthenticated');

      // Owner-scoped hard delete. Deleting the row drops its inline image blobs
      // (photoDisplay/photoThumb). A 0-row delete means the submission is missing
      // or not the caller's — 404 either way, to avoid leaking existence.
      const deleted = await db.run(
        DELETE.from(PetSubmissions).where({
          ID: req.data.id, user_ID: dbUser.ID, petoberfest_ID: contest.ID,
        }));
      if (!deleted) return req.reject(404, 'Submission not found');

      // Revoke credit only if this was the user's last entry for the contest.
      let creditRevoked = false;
      const remaining = await db.run(
        SELECT.one.from(PetSubmissions)
          .columns('ID')
          .where({ petoberfest_ID: contest.ID, user_ID: dbUser.ID }));
      if (!remaining) {
        // SUPERSEDED (not deleted): matches the award idempotency check in
        // petoberfest-upload.js, so a later re-upload re-awards cleanly, and an
        // audit trail is kept. Removes the completion from COMPLETED scoring.
        const updated = await db.run(
          UPDATE(TaskRecords).set({ status: 'SUPERSEDED' }).where({
            user_ID: dbUser.ID, taskLegacyId: contest.legacyId,
            taskType: 'PETOBERFEST', status: { '!=': 'SUPERSEDED' },
          }));
        creditRevoked = updated > 0;
      }

      return { withdrawn: true, creditRevoked };
    });

    await super.init();
  }
}
