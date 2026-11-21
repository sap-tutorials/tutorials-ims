// srv/__tests__/visibility-model.test.js
// Task 1: Tutorials.visibility enum field (issue #3099)
// Tests that:
//   1. inserting a Tutorials row without visibility gives default 'LISTED'
//   2. inserting a row with visibility 'ROLE_GATED' round-trips correctly
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';

cds.test('serve', '--project', '.', '--in-memory');

describe('Tutorials.visibility', () => {
  let Tutorials;
  const ids = [];

  beforeAll(async () => {
    ({ Tutorials } = cds.entities('com.sap.developers.ims'));
  });

  afterAll(async () => {
    if (ids.length) {
      await DELETE.from(Tutorials).where({ ID: { in: ids } });
    }
  });

  it('defaults to LISTED when visibility is not supplied', async () => {
    const id = cds.utils.uuid();
    ids.push(id);
    await INSERT.into(Tutorials).entries([{ ID: id, slug: `vis-default-${id}` }]);
    const row = await SELECT.one.from(Tutorials).where({ ID: id });
    expect(row.visibility).toBe('LISTED');
  });

  it('round-trips ROLE_GATED correctly', async () => {
    const id = cds.utils.uuid();
    ids.push(id);
    await INSERT.into(Tutorials).entries([{ ID: id, slug: `vis-role-${id}`, visibility: 'ROLE_GATED' }]);
    const row = await SELECT.one.from(Tutorials).where({ ID: id });
    expect(row.visibility).toBe('ROLE_GATED');
  });
});
