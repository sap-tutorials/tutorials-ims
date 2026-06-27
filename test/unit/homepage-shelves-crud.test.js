import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

cds.test('serve', '--project', '.', '--in-memory');

// Test data uses a __TEST__ URL prefix to avoid colliding with seed CSV
// content (db/data/com.sap.developers.ims-HomepageShelves.csv was added in
// Task 2 and contains LEARN /tutorial-navigator/ + BUILD cap.cloud.sap).
// Matches the project's hybrid-test isolation convention (test/hybrid/_guard.js).

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
      title: '__TEST__ Tutorial navigator',
      url: 'https://example.test/__test__/tutorial-navigator',
      description: 'Catalog of 1,400+ tutorials',
      isExternal: true,
      isActive: true
    }));
    const row = await db.run(SELECT.one.from(HomepageShelves).where({
      ID: 'aaaaaaaa-1111-2222-3333-444444444444'
    }));
    expect(row).toBeTruthy();
    expect(row.verb).toBe('LEARN');
    expect(row.title).toBe('__TEST__ Tutorial navigator');
  });

  it('rejects duplicate URL within same verb (assert.unique)', async () => {
    const { HomepageShelves } = db.entities('com.sap.developers.ims');
    const entry = {
      verb: 'BUILD', shelf: 'REFERENCE', sortOrder: 5,
      title: '__TEST__ Unique-constraint probe',
      url: 'https://example.test/__test__/unique-probe',
      isActive: true
    };
    await db.run(INSERT.into(HomepageShelves).entries({ ...entry, ID: cds.utils.uuid() }));
    await expect(
      db.run(INSERT.into(HomepageShelves).entries({ ...entry, ID: cds.utils.uuid() }))
    ).rejects.toThrow(/unique|duplicate/i);
  });

  it('persists HomepageConfig as a singleton', async () => {
    const { HomepageConfig } = db.entities('com.sap.developers.ims');
    // Clear any seed row (Task 2 seeds one) so this test exercises the
    // post-insert read against a controlled state.
    await db.run(DELETE.from(HomepageConfig));
    await db.run(INSERT.into(HomepageConfig).entries({
      ID: 'cccccccc-1111-2222-3333-444444444444',
      developerNewsPlaylistId: 'PLxxxx',
      videoBandEnabled: true
    }));
    const row = await db.run(SELECT.one.from(HomepageConfig));
    expect(row.developerNewsPlaylistId).toBe('PLxxxx');
  });
});
