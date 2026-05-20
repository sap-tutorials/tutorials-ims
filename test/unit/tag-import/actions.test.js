import { describe, it, expect, beforeEach } from 'vitest';
import cds from '@sap/cds';
import { MAX_BYTES } from '../../../srv/lib/tag-import/parser.js';

const project = cds.test('serve', '--project', '.', '--in-memory');
const adminAuth = { auth: { username: 'admin', password: 'admin' } };

describe('previewTagImport (action)', () => {
  beforeEach(async () => {
    const { Tags } = cds.entities('com.sap.developers.ims');
    await DELETE.from(Tags);
    await INSERT.into(Tags).entries({
      ID: 'aaaaaaaa-0000-0000-0000-000000000001',
      name: 'ABAP',
      titlePath: 'Languages:ABAP',
      legacyId: 9001
    });
  });

  it('returns a token and summary for a valid CSV', async () => {
    const csv = 'name,titlePath\nNEW_TAG_X,Path:X\nABAP,Languages:ABAP';
    const { status, data } = await project.post(
      '/admin/previewTagImport',
      { payload: csv, format: 'csv' },
      adminAuth
    );
    expect(status).toBe(200);
    expect(data.token).toMatch(/^[0-9a-f-]{36}$/);
    expect(data.summary).toEqual({ total: 2, new_: 1, conflict: 1, invalid: 0 });
  });

  it('rejects oversized payload with 413', async () => {
    const big = 'x'.repeat(MAX_BYTES + 1);
    const { status } = await project.post(
      '/admin/previewTagImport',
      { payload: big, format: 'csv' },
      { ...adminAuth, validateStatus: () => true }
    );
    expect(status).toBe(413);
  });

  it('rejects malformed CSV with 400', async () => {
    const { status } = await project.post(
      '/admin/previewTagImport',
      { payload: 'wrongheader\nfoo', format: 'csv' },
      { ...adminAuth, validateStatus: () => true }
    );
    expect(status).toBe(400);
  });
});
