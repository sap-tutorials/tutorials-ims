import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import cds from '@sap/cds';
import { isSafeForWrites } from './_guard.js';

const TEST_TITLE_PREFIX = '__TEST__759_';

describe.runIf(isSafeForWrites())('HomepageShelves new fields on HANA (#759 PR 1)', () => {
  let db;
  beforeAll(async () => { db = await cds.connect.to('db'); });

  afterEach(async () => {
    await db.run(
      DELETE.from('com.sap.developers.ims.HomepageShelves')
        .where("title LIKE '" + TEST_TITLE_PREFIX + "%'")
    );
  });

  afterAll(async () => {
    // Defensive — make sure no __TEST__759_ rows leaked through afterEach
    await db.run(
      DELETE.from('com.sap.developers.ims.HomepageShelves')
        .where("title LIKE '" + TEST_TITLE_PREFIX + "%'")
    );
  });

  it('authoringStatus defaults to BLANK when omitted', async () => {
    await db.run(INSERT.into('com.sap.developers.ims.HomepageShelves').entries({
      verb: 'LEARN', shelf: 'START_HERE',
      title: TEST_TITLE_PREFIX + 'default-status',
      url: 'https://example.com/759-test-1',
      sortOrder: 999,
    }));
    const row = await db.run(SELECT.one.from('com.sap.developers.ims.HomepageShelves')
      .where({ title: TEST_TITLE_PREFIX + 'default-status' }));
    expect(row.authoringStatus).toBe('BLANK');
    expect(row.tagline).toBeNull();
    expect(row.whyItMatters).toBeNull();
  });

  it('accepts tagline up to 140 chars', async () => {
    const ok140 = 'x'.repeat(140);
    await db.run(INSERT.into('com.sap.developers.ims.HomepageShelves').entries({
      verb: 'BUILD', shelf: 'REFERENCE',
      title: TEST_TITLE_PREFIX + 'tagline-140',
      url: 'https://example.com/759-test-2',
      tagline: ok140,
    }));
    const row = await db.run(SELECT.one.from('com.sap.developers.ims.HomepageShelves')
      .where({ title: TEST_TITLE_PREFIX + 'tagline-140' }));
    expect(row.tagline).toBe(ok140);
  });

  it('@assert.range rejects bogus authoringStatus', async () => {
    await expect(
      db.run(INSERT.into('com.sap.developers.ims.HomepageShelves').entries({
        verb: 'AI', shelf: 'TOOLS',
        title: TEST_TITLE_PREFIX + 'bad-status',
        url: 'https://example.com/759-test-3',
        authoringStatus: 'NOPE',
      }))
    ).rejects.toThrow();
  });

  it('status transition BLANK → AI_SEEDED → REVIEWED persists', async () => {
    await db.run(INSERT.into('com.sap.developers.ims.HomepageShelves').entries({
      verb: 'CONNECT', shelf: 'KEEP_CURRENT',
      title: TEST_TITLE_PREFIX + 'transitions',
      url: 'https://example.com/759-test-4',
    }));
    await db.run(UPDATE('com.sap.developers.ims.HomepageShelves')
      .set({ authoringStatus: 'AI_SEEDED', tagline: 'auto-tagline' })
      .where({ title: TEST_TITLE_PREFIX + 'transitions' }));
    let row = await db.run(SELECT.one.from('com.sap.developers.ims.HomepageShelves')
      .where({ title: TEST_TITLE_PREFIX + 'transitions' }));
    expect(row.authoringStatus).toBe('AI_SEEDED');
    expect(row.tagline).toBe('auto-tagline');

    await db.run(UPDATE('com.sap.developers.ims.HomepageShelves')
      .set({ authoringStatus: 'REVIEWED' })
      .where({ title: TEST_TITLE_PREFIX + 'transitions' }));
    row = await db.run(SELECT.one.from('com.sap.developers.ims.HomepageShelves')
      .where({ title: TEST_TITLE_PREFIX + 'transitions' }));
    expect(row.authoringStatus).toBe('REVIEWED');
  });
});
