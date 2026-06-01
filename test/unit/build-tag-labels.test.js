// test/unit/build-tag-labels.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

describe('GET /build/tag-labels', () => {
  beforeEach(async () => {
    const { Tags } = cds.entities('com.sap.developers.ims');
    await DELETE.from(Tags);
    await INSERT.into(Tags).entries([
      { ID: '00000000-0000-0000-0000-000000000a01', legacyId: 100, name: 'sap s 4hana', label: 'SAP S/4HANA',  titlePath: 'software-product>sap-s-4hana' },
      { ID: '00000000-0000-0000-0000-000000000a02', legacyId: 101, name: 'license',     label: 'License',     titlePath: 'tutorial>license' },
      { ID: '00000000-0000-0000-0000-000000000a03', legacyId: 102, name: 'orphan',      label: null,          titlePath: 'orphan>nolabel' },
    ]);
  });

  it('returns a flat slug-to-label map for tags with non-null labels', async () => {
    const { data, headers, status } = await project.axios.get('/build/tag-labels');
    expect(status).toBe(200);
    expect(data).toEqual({
      'software-product>sap-s-4hana': 'SAP S/4HANA',
      'tutorial>license': 'License',
    });
    expect(data['orphan>nolabel']).toBeUndefined();
    expect(headers['cache-control']).toMatch(/public/);
    expect(headers['cache-control']).toMatch(/max-age=\d+/);
  });

  it('returns an empty object when no tags have labels', async () => {
    const { Tags } = cds.entities('com.sap.developers.ims');
    await UPDATE(Tags).set({ label: null });
    const { data, status } = await project.axios.get('/build/tag-labels');
    expect(status).toBe(200);
    expect(data).toEqual({});
  });
});
