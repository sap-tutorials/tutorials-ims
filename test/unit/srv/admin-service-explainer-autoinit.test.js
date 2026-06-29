import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

const ADMIN_AUTH = { auth: { username: 'admin', password: 'admin' } };

describe('AdminService — VerbDefinitions/ShelfDefinitions auto-init (#759 PR 1)', () => {
  let db;
  beforeAll(async () => {
    db = await cds.connect.to('db');
  });

  it('auto-creates 6 VerbDefinitions rows when reading an empty table', async () => {
    await db.run(DELETE.from('com.sap.developers.ims.VerbDefinitions'));
    const res = await project.get('/admin/VerbDefinitions', ADMIN_AUTH);
    expect(res.status).toBe(200);
    const rows = res.data.value;
    expect(rows.length).toBe(6);
    const keys = rows.map(r => r.verbKey).sort();
    expect(keys).toEqual(['AI', 'BUILD', 'CONNECT', 'INTEGRATE', 'LEARN', 'OPERATE']);
    expect(rows.every(r => r.authoringStatus === 'BLANK')).toBe(true);
  });

  it('auto-creates 4 ShelfDefinitions rows when reading an empty table', async () => {
    await db.run(DELETE.from('com.sap.developers.ims.ShelfDefinitions'));
    const res = await project.get('/admin/ShelfDefinitions', ADMIN_AUTH);
    expect(res.status).toBe(200);
    const rows = res.data.value;
    expect(rows.length).toBe(4);
    const keys = rows.map(r => r.shelfKey).sort();
    expect(keys).toEqual(['KEEP_CURRENT', 'REFERENCE', 'START_HERE', 'TOOLS']);
  });

  it('idempotent — second read does not duplicate', async () => {
    await project.get('/admin/VerbDefinitions', ADMIN_AUTH);
    await project.get('/admin/VerbDefinitions', ADMIN_AUTH);
    const count = await db.run(
      SELECT.from('com.sap.developers.ims.VerbDefinitions').columns('count(*) as n')
    );
    expect(count[0].n).toBe(6);
  });
});
