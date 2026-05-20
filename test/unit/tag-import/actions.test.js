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

describe('commitTagImport (action)', () => {
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

  async function preview(csv) {
    const { data } = await project.post(
      '/admin/previewTagImport',
      { payload: csv, format: 'csv' },
      adminAuth
    );
    return data.token;
  }

  it('upsert path returns counts and applies changes', async () => {
    const token = await preview('name,titlePath\nNEW_TAG_Y,P:Y\nABAP,Languages:ABAP-NEW');
    const { status, data } = await project.post(
      '/admin/commitTagImport',
      { token, strategy: 'upsert' },
      adminAuth
    );
    expect(status).toBe(200);
    expect(data.inserted).toBe(1);
    expect(data.updated).toBe(1);
    expect(data.skipped).toBe(0);
    expect(data.total).toBe(2);
  });

  it('returns 410 when token is unknown', async () => {
    const { status } = await project.post(
      '/admin/commitTagImport',
      { token: 'does-not-exist', strategy: 'upsert' },
      { ...adminAuth, validateStatus: () => true }
    );
    expect(status).toBe(410);
  });

  it('returns 409 on abort-on-duplicate with conflicts', async () => {
    const token = await preview('name,titlePath\nABAP,Languages:ABAP-NEW');
    const { status } = await project.post(
      '/admin/commitTagImport',
      { token, strategy: 'abort-on-duplicate' },
      { ...adminAuth, validateStatus: () => true }
    );
    expect(status).toBe(409);
  });
});
