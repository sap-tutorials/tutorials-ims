// test/unit/cleanup-change-log.test.js
// Tests for the new cleanupChangeLog helper added 2026-06-22 to address
// 74k+ rows of migration-trigger noise observed on DEV.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import cds from '@sap/cds';
import { cleanupChangeLog } from '../../srv/jobs/cleanup.js';

const project = cds.test('serve', '--project', '.', '--in-memory');

describe('cleanupChangeLog', () => {
  let Changes;

  beforeAll(() => {
    Changes = cds.entities('sap.changelog').Changes;
  });

  beforeEach(async () => {
    await DELETE.from(Changes);
  });

  async function seedChange({ id, createdAt, createdBy = 'admin@test', modification = 'update' }) {
    await INSERT.into(Changes).entries({
      ID: id || cds.utils.uuid(),
      createdAt,
      createdBy,
      modification,
      entity: 'AdminService.Missions',
      entityKey: cds.utils.uuid(),
      attribute: 'title',
      valueChangedFrom: 'old',
      valueChangedTo: 'new',
    });
  }

  it('deletes only rows older than the retentionDays cutoff', async () => {
    const now = Date.now();
    await seedChange({ createdAt: new Date(now - 100 * 86400000).toISOString() }); // 100d
    await seedChange({ createdAt: new Date(now - 95  * 86400000).toISOString() }); // 95d
    await seedChange({ createdAt: new Date(now - 10  * 86400000).toISOString() }); // 10d
    await seedChange({ createdAt: new Date(now - 1   * 86400000).toISOString() }); // 1d

    const before = await SELECT.from(Changes).columns('count(*) as c');
    expect(before[0].c).toBe(4);

    await cleanupChangeLog({ retentionDays: 90 });

    const after = await SELECT.from(Changes).columns('count(*) as c');
    expect(after[0].c).toBe(2); // the 10d + 1d rows survive
  });

  it('migrationOnly=true scopes deletion to createdBy=migration', async () => {
    const oldDate = new Date(Date.now() - 100 * 86400000).toISOString();
    await seedChange({ createdAt: oldDate, createdBy: 'migration' });
    await seedChange({ createdAt: oldDate, createdBy: 'admin@test' });
    await seedChange({ createdAt: oldDate, createdBy: 'system' });

    await cleanupChangeLog({ retentionDays: 90, migrationOnly: true });

    const survivors = await SELECT.from(Changes).columns('createdBy');
    expect(survivors.map(r => r.createdBy).sort()).toEqual(['admin@test', 'system']);
  });

  it('retentionDays=0 + migrationOnly=true purges ALL migration rows regardless of age', async () => {
    const now = Date.now();
    await seedChange({ createdAt: new Date(now - 1 * 86400000).toISOString(), createdBy: 'migration' });
    await seedChange({ createdAt: new Date(now - 100 * 86400000).toISOString(), createdBy: 'migration' });
    await seedChange({ createdAt: new Date(now - 1 * 86400000).toISOString(), createdBy: 'admin@test' });

    await cleanupChangeLog({ retentionDays: 0, migrationOnly: true });

    const survivors = await SELECT.from(Changes).columns('createdBy');
    // Both migration rows deleted (their createdAt < cutoff = now-0d = now).
    // The admin@test row is also <now so it would have matched the date
    // predicate, BUT migrationOnly=true excludes it via createdBy filter.
    expect(survivors).toEqual([{ createdBy: 'admin@test' }]);
  });

  it('with no params, defaults to retentionDays=90 + migrationOnly=false', async () => {
    const now = Date.now();
    await seedChange({ createdAt: new Date(now - 100 * 86400000).toISOString(), createdBy: 'migration' });
    await seedChange({ createdAt: new Date(now - 100 * 86400000).toISOString(), createdBy: 'admin@test' });
    await seedChange({ createdAt: new Date(now - 10  * 86400000).toISOString(), createdBy: 'migration' });

    await cleanupChangeLog();

    // Both 100d rows deleted regardless of createdBy; the 10d row survives.
    const survivors = await SELECT.from(Changes).columns('createdBy', 'createdAt');
    expect(survivors.length).toBe(1);
    expect(survivors[0].createdBy).toBe('migration');
  });
});
