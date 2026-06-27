import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

cds.test('serve', '--project', '.', '--in-memory');

describe('HomepageShelves CRUD', () => {
  let db;
  beforeAll(async () => { db = await cds.connect.to('db'); });

  it('inserts and retrieves a shelf entry', async () => {
    const { HomepageShelves } = db.entities('com.sap.developers.ims');
    await db.run(INSERT.into(HomepageShelves).entries({
      ID: 'aaaaaaaa-1111-2222-3333-444444444444',
      verb: 'LEARN',
      shelf: 'START_HERE',
      sortOrder: 10,
      title: 'Tutorial navigator',
      url: '/tutorial-navigator/',
      description: 'Catalog of 1,400+ tutorials',
      isExternal: false,
      isActive: true
    }));
    const row = await db.run(SELECT.one.from(HomepageShelves).where({
      ID: 'aaaaaaaa-1111-2222-3333-444444444444'
    }));
    expect(row).toBeTruthy();
    expect(row.verb).toBe('LEARN');
    expect(row.title).toBe('Tutorial navigator');
  });

  it('rejects duplicate URL within same verb (assert.unique)', async () => {
    const { HomepageShelves } = db.entities('com.sap.developers.ims');
    const entry = {
      verb: 'BUILD', shelf: 'REFERENCE', sortOrder: 5,
      title: 'CAP docs', url: 'https://cap.cloud.sap', isActive: true
    };
    await db.run(INSERT.into(HomepageShelves).entries({ ...entry, ID: cds.utils.uuid() }));
    await expect(
      db.run(INSERT.into(HomepageShelves).entries({ ...entry, ID: cds.utils.uuid() }))
    ).rejects.toThrow(/unique|duplicate/i);
  });

  it('persists HomepageConfig as a singleton', async () => {
    const { HomepageConfig } = db.entities('com.sap.developers.ims');
    await db.run(INSERT.into(HomepageConfig).entries({
      ID: 'cccccccc-1111-2222-3333-444444444444',
      developerNewsPlaylistId: 'PLxxxx',
      videoBandEnabled: true
    }));
    const row = await db.run(SELECT.one.from(HomepageConfig));
    expect(row.developerNewsPlaylistId).toBe('PLxxxx');
  });
});
