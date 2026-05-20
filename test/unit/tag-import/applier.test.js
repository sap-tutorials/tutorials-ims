import cds from '@sap/cds';
import { describe, it, expect, beforeEach } from 'vitest';
import { apply } from '../../../srv/lib/tag-import/applier.js';

cds.test('serve', '--project', '.', '--in-memory');

describe('apply', () => {
  let db;
  let Tags;

  beforeEach(async () => {
    db = await cds.connect.to('db');
    ({ Tags } = cds.entities('com.sap.developers.ims'));
    await DELETE.from(Tags);
    await INSERT.into(Tags).entries([
      { ID: 'id-abap', name: 'ABAP', titlePath: 'Languages:ABAP', legacyId: 1 }
    ]);
  });

  it('upsert: inserts new + updates conflicts whose titlePath differs', async () => {
    const rows = [
      { status: 'new', name: 'CAP', titlePath: 'Frameworks:CAP' },
      { status: 'conflict', name: 'ABAP', titlePath: 'NewPath', existingId: 'id-abap', existingTitlePath: 'Languages:ABAP' },
      { status: 'invalid', name: '', titlePath: '', reason: 'x' }
    ];
    const result = await apply(rows, 'upsert', db);
    expect(result).toEqual({ inserted: 1, updated: 1, skipped: 1, total: 3 });
    const updated = await SELECT.one.from(Tags).where({ ID: 'id-abap' });
    expect(updated.titlePath).toBe('NewPath');
  });

  it('upsert: does NOT update when titlePath matches', async () => {
    const rows = [
      { status: 'conflict', name: 'ABAP', titlePath: 'Languages:ABAP', existingId: 'id-abap', existingTitlePath: 'Languages:ABAP' }
    ];
    const result = await apply(rows, 'upsert', db);
    expect(result).toEqual({ inserted: 0, updated: 0, skipped: 1, total: 1 });
  });

  it('skip-duplicates: only inserts new rows', async () => {
    const rows = [
      { status: 'new', name: 'CAP', titlePath: 'Frameworks:CAP' },
      { status: 'conflict', name: 'ABAP', titlePath: 'NewPath', existingId: 'id-abap' }
    ];
    const result = await apply(rows, 'skip-duplicates', db);
    expect(result).toEqual({ inserted: 1, updated: 0, skipped: 1, total: 2 });
    const abap = await SELECT.one.from(Tags).where({ ID: 'id-abap' });
    expect(abap.titlePath).toBe('Languages:ABAP');
  });

  it('abort-on-duplicate: throws and does not insert any new rows', async () => {
    const rows = [
      { status: 'new', name: 'CAP', titlePath: 'Frameworks:CAP' },
      { status: 'conflict', name: 'ABAP', titlePath: 'NewPath', existingId: 'id-abap' }
    ];
    await expect(apply(rows, 'abort-on-duplicate', db)).rejects.toThrow(/conflict/i);
    const cap = await SELECT.one.from(Tags).where({ name: 'CAP' });
    expect(cap).toBeUndefined();
  });

  it('rejects unknown strategy', async () => {
    await expect(apply([], 'merge', db)).rejects.toThrow(/strategy/i);
  });
});
