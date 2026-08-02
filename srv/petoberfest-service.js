// srv/petoberfest-service.js
import cds from '@sap/cds';
import { resolveUserSapId } from './lib/resolve-db-user.js';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,254}$/;

export async function resolveOrCreatePetUser(db, user) {
  const sapId = resolveUserSapId(user);
  if (!sapId) return null;
  const { Users } = cds.entities('com.sap.developers.ims');
  let row = await db.run(SELECT.one.from(Users).where({ sapId }));
  if (!row) {
    const ID = cds.utils.uuid();
    await db.run(INSERT.into(Users).entries({
      ID, sapId,
      email: user.attr?.email || null,
      firstName: user.attr?.given_name || null,
      lastName: user.attr?.family_name || null,
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

    await super.init();
  }
}
