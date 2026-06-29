import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import cds from '@sap/cds';

const ADMIN_AUTH = { auth: { username: 'admin', password: 'admin' } };

describe('AdminService.mark*ExplainerReviewed actions (#759 PR 3b)', () => {
  const project = cds.test('serve', '--project', '.', '--in-memory');

  beforeAll(async () => {
    await project;
  });

  beforeEach(async () => {
    const db = await cds.connect.to('db');
    await db.run(DELETE.from('com.sap.developers.ims.VerbDefinitions'));
    // Trigger auto-init via AdminService projection.
    await project.get('/admin/VerbDefinitions', ADMIN_AUTH);
  });

  it('markVerbExplainerReviewed flips AI_SEEDED → REVIEWED', async () => {
    const db = await cds.connect.to('db');
    const learn = await db.run(
      SELECT.one.from('com.sap.developers.ims.VerbDefinitions').where({ verbKey: 'LEARN' })
    );
    await db.run(
      UPDATE('com.sap.developers.ims.VerbDefinitions')
        .set({ authoringStatus: 'AI_SEEDED' })
        .where({ ID: learn.ID })
    );
    const res = await project.post(
      '/admin/markVerbExplainerReviewed',
      { id: learn.ID },
      ADMIN_AUTH
    );
    expect(res.data.processed).toBe(1);
    const after = await db.run(
      SELECT.one.from('com.sap.developers.ims.VerbDefinitions').where({ ID: learn.ID })
    );
    expect(after.authoringStatus).toBe('REVIEWED');
  });

  it('returns HTTP 404 on missing id', async () => {
    const res = await project
      .post('/admin/markVerbExplainerReviewed', { id: 'nonexistent-id' }, ADMIN_AUTH)
      .catch((err) => err.response);
    expect(res.status).toBe(404);
  });
});
