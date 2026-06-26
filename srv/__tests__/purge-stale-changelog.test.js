import cds from '@sap/cds';
import { describe, it, expect, beforeEach } from 'vitest';
import { purgeStaleChangelog, autoPurgeOnce, NOISE_ENTITIES } from '../lib/purge-stale-changelog.js';

cds.test('serve', '--project', '.', '--in-memory');

async function seedChange(entity, attribute = 'test', createdBy = 'system') {
  const { Changes } = cds.entities('sap.changelog');
  await INSERT.into(Changes).entries({
    ID: cds.utils.uuid(),
    entity,
    entityKey: 'k1',
    attribute,
    valueDataType: 'cds.String',
    valueChangedFrom: 'a',
    valueChangedTo: 'b',
    modification: 'update',
    createdAt: new Date().toISOString(),
    createdBy,
  });
}

async function countChanges(entity) {
  const { Changes } = cds.entities('sap.changelog');
  const rows = await SELECT.from(Changes).where({ entity });
  return rows.length;
}

describe('purgeStaleChangelog', () => {
  beforeEach(async () => {
    const { Changes } = cds.entities('sap.changelog');
    await DELETE.from(Changes);
  });

  it('deletes rows only for the supplied entity list', async () => {
    await seedChange('com.sap.developers.ims.Concepts');
    await seedChange('com.sap.developers.ims.Advocates');

    const { deleted } = await purgeStaleChangelog({
      entities: ['com.sap.developers.ims.Concepts'],
    });

    expect(deleted).toBe(1);
    expect(await countChanges('com.sap.developers.ims.Concepts')).toBe(0);
    expect(await countChanges('com.sap.developers.ims.Advocates')).toBe(1);
  });

  it('uses NOISE_ENTITIES when entities arg is empty', async () => {
    for (const ent of NOISE_ENTITIES) await seedChange(ent);
    await seedChange('com.sap.developers.ims.Advocates'); // control

    const { deleted } = await purgeStaleChangelog({ entities: [] });

    expect(deleted).toBe(NOISE_ENTITIES.length);
    expect(await countChanges('com.sap.developers.ims.Advocates')).toBe(1);
  });

  it('uses NOISE_ENTITIES when entities arg is undefined', async () => {
    await seedChange('com.sap.developers.ims.Concepts');
    await seedChange('com.sap.developers.ims.Advocates'); // control

    const { deleted } = await purgeStaleChangelog();

    expect(deleted).toBe(1);
    expect(await countChanges('com.sap.developers.ims.Advocates')).toBe(1);
  });
});

describe('autoPurgeOnce', () => {
  beforeEach(async () => {
    const { Changes } = cds.entities('sap.changelog');
    const { JobLocks } = cds.entities('com.sap.developers.ims');
    await DELETE.from(Changes);
    await DELETE.from(JobLocks).where({
      jobName: { like: 'changelog-noise-purge-%' },
    });
  });

  it('runs the purge on first call, no-ops on the second', async () => {
    // Seed one noise row so the first call has something to delete.
    const { Changes } = cds.entities('sap.changelog');
    await INSERT.into(Changes).entries({
      ID: cds.utils.uuid(),
      entity: 'com.sap.developers.ims.Concepts',
      entityKey: 'k1',
      attribute: 'x',
      valueDataType: 'cds.String',
      modification: 'update',
      createdAt: new Date().toISOString(),
      createdBy: 'system',
    });

    const first = await autoPurgeOnce({ version: 'test-v1' });
    expect(first).toMatchObject({ deleted: 1, alreadyRan: false });

    const second = await autoPurgeOnce({ version: 'test-v1' });
    expect(second).toMatchObject({ deleted: 0, alreadyRan: true });
  });
});
