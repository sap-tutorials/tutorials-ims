import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

const TAGS_ENTITY = 'com.sap.developers.ims.Tags';

describe('/build/tags tag-taxonomy feed', () => {
  let db;
  beforeAll(async () => {
    db = await cds.connect.to('db');
  });

  it('returns 200 with a tags array', async () => {
    const res = await project.get('/build/tags');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data.tags)).toBe(true);
  });

  it('sets 60s Cache-Control header', async () => {
    const res = await project.get('/build/tags');
    expect(res.headers['cache-control']).toBe('public, max-age=60');
  });

  it('returns buildAt ISO timestamp', async () => {
    const res = await project.get('/build/tags');
    expect(res.data.buildAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('returns the name string of each seeded Tags row, ordered by name', async () => {
    await db.run(DELETE.from(TAGS_ENTITY));
    await db.run(INSERT.into(TAGS_ENTITY).entries(
      { ID: cds.utils.uuid(), name: 'products>sap-hana-cloud', label: 'SAP HANA Cloud', isActualTag: true },
      { ID: cds.utils.uuid(), name: 'products>sap-btp', label: 'SAP BTP', isActualTag: true },
      { ID: cds.utils.uuid(), name: 'topic>cloud', label: 'Cloud', isActualTag: true },
    ));
    const res = await project.get('/build/tags');
    expect(res.status).toBe(200);
    expect(res.data.tags).toEqual([
      'products>sap-btp',
      'products>sap-hana-cloud',
      'topic>cloud',
    ]);
    // Payload is the array of name strings only, not row objects.
    expect(res.data.tags.every((t) => typeof t === 'string')).toBe(true);
  });
});
