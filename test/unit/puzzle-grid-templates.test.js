// test/unit/puzzle-grid-templates.test.js
// Task 3 — GridTemplates entity (puzzle-designer parity).
// Verifies: built-in seed rows are readable via OData, and a user template
// can be created via draft flow and deleted.
import { describe, it, expect } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');
const ADMIN_AUTH = { auth: { username: 'admin', password: 'admin' } };

describe('AdminService.GridTemplates', () => {
  it('exposes built-in templates seeded from CSV', async () => {
    const res = await project.get('/admin/GridTemplates?$filter=isBuiltin eq true', ADMIN_AUTH);
    expect(res.status).toBe(200);
    expect(res.data.value.length).toBeGreaterThan(0);
    const t = res.data.value[0];
    expect(t).toHaveProperty('name');
    expect(t).toHaveProperty('blacks');
    expect(JSON.parse(t.blacks)).toBeInstanceOf(Array);
  });

  it('creates and activates a user template via draft flow', async () => {
    const draftRes = await project.post('/admin/GridTemplates', {
      name: 'My Grid', rows: 15, cols: 15, blacks: JSON.stringify([[0,0],[14,14]]), isBuiltin: false
    }, ADMIN_AUTH);
    expect(draftRes.status).toBe(201);
    const id = draftRes.data.ID;

    const activateRes = await project.post(
      `/admin/GridTemplates(ID=${id},IsActiveEntity=false)/AdminService.draftActivate`,
      {}, ADMIN_AUTH
    );
    expect([200, 201]).toContain(activateRes.status);
    expect(activateRes.data.IsActiveEntity).toBe(true);

    const delRes = await project.delete(
      `/admin/GridTemplates(ID=${id},IsActiveEntity=true)`,
      ADMIN_AUTH
    );
    expect(delRes.status).toBe(204);
  });
});
