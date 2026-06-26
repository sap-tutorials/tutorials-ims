import cds from '@sap/cds';
import { describe, it, expect, beforeEach } from 'vitest';

const project = cds.test('serve', '--project', '.', '--in-memory');
const auth = { auth: { username: 'admin', password: 'admin' } };

async function seed(entity) {
  const { Changes } = cds.entities('sap.changelog');
  await INSERT.into(Changes).entries({
    ID: cds.utils.uuid(),
    entity,
    entityKey: 'k1',
    attribute: 'x',
    valueDataType: 'cds.String',
    modification: 'update',
    createdAt: new Date().toISOString(),
    createdBy: 'system',
  });
}

describe('AdminService.purgeNoiseChangeLog', () => {
  beforeEach(async () => {
    const { Changes } = cds.entities('sap.changelog');
    await DELETE.from(Changes);
  });

  it('purges only the supplied entity list', async () => {
    await seed('com.sap.developers.ims.Concepts');
    await seed('com.sap.developers.ims.Advocates'); // control

    const { data, status } = await project.post(
      '/admin/purgeNoiseChangeLog',
      { entities: ['com.sap.developers.ims.Concepts'] },
      { ...auth, validateStatus: () => true },
    );

    expect(status).toBe(200);
    expect(data.deleted).toBe(1);
  });

  it('falls back to NOISE_ENTITIES when entities is empty', async () => {
    await seed('com.sap.developers.ims.Concepts');
    await seed('com.sap.developers.ims.ChatSettings');
    await seed('com.sap.developers.ims.Advocates'); // control

    const { data, status } = await project.post(
      '/admin/purgeNoiseChangeLog',
      { entities: [] },
      { ...auth, validateStatus: () => true },
    );

    expect(status).toBe(200);
    expect(data.deleted).toBe(2);
  });
});
