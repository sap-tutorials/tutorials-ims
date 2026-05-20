import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';
import { isSafeForWrites } from './_guard.js';

cds.test('serve', '--project', '.', '--profile', 'hybrid');

describe.runIf(isSafeForWrites())('tag-import (hybrid HANA)', () => {
  let db, Tags;
  const SEED_NAME = '__TEST__seed-tag';
  const NEW_NAME_1 = '__TEST__new-tag-1';
  const NEW_NAME_2 = '__TEST__new-tag-2';

  beforeAll(async () => {
    db = await cds.connect.to('db');
    ({ Tags } = cds.entities('com.sap.developers.ims'));
    // Seed the existing-tag we will collide with in the preview.
    await DELETE.from(Tags).where({ name: { like: '__TEST__%' } });
    const { getNextLegacyId } = await import('../../srv/lib/legacy-id.js');
    await INSERT.into(Tags).entries({
      name: SEED_NAME,
      titlePath: 'Test:OldPath',
      legacyId: await getNextLegacyId('Tags', db)
    });
  });

  afterAll(async () => {
    await DELETE.from(Tags).where({ name: { like: '__TEST__%' } });
  });

  it('previews + commits an upsert end-to-end', async () => {
    const { previewTagImport, commitTagImport } = await import('@sap/cds')
      .then(m => m.default.connect.to('AdminService'))
      .then(s => ({
        previewTagImport: (data) => s.send('previewTagImport', data),
        commitTagImport:  (data) => s.send('commitTagImport',  data)
      }));

    const csv = [
      'name,titlePath',
      `${NEW_NAME_1},Test:Path1`,
      `${NEW_NAME_2},Test:Path2`,
      `${SEED_NAME},Test:NewPath`
    ].join('\n');

    const preview = await previewTagImport({ payload: csv, format: 'csv' });
    expect(preview.summary).toEqual({ total: 3, new_: 2, conflict: 1, invalid: 0 });
    expect(preview.token).toBeTruthy();

    const result = await commitTagImport({ token: preview.token, strategy: 'upsert' });
    expect(result).toEqual({ inserted: 2, updated: 1, skipped: 0, total: 3 });

    const seeded = await SELECT.one.from(Tags).where({ name: SEED_NAME });
    expect(seeded.titlePath).toBe('Test:NewPath');

    const news = await SELECT.from(Tags).where({ name: { in: [NEW_NAME_1, NEW_NAME_2] } });
    expect(news).toHaveLength(2);
  });
});
