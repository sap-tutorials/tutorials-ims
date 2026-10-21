// test/unit/srv/completion-path-item-unavailable.test.js
// (#2864) Task 2: temporarilyUnavailable + unavailableReason on CompletionPathItems.
//
// TDD guard: boots CAP in-memory, inserts CompletionPathItems rows,
// reads them back via AdminService.CompletionPathItems, and asserts
// both fields round-trip AND that a row inserted without them defaults
// temporarilyUnavailable to false.
//
// AdminService.CompletionPathItems uses SELECT * so the new fields
// auto-expose — no projection change needed.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';

const NS = 'com.sap.developers.ims';
const ADMIN_AUTH = { auth: { username: 'admin', password: 'admin' } };

// Stable UUIDs for the test fixtures (deleted in afterAll)
const PATH_ID = 'TP000001-0000-0000-0000-000000000001';
const ITEM_SET_ID = 'TI000001-0000-0000-0000-000000000001';
const ITEM_DEFAULT_ID = 'TI000002-0000-0000-0000-000000000002';

const project = cds.test('serve', '--project', '.', '--in-memory');

beforeAll(async () => {
  await project;
  const { CompletionPaths, CompletionPathItems } = cds.entities(NS);

  // Seed a parent CompletionPath so the FK resolves
  await cds.tx(async (tx) => {
    await tx.run(INSERT.into(CompletionPaths).entries({
      ID: PATH_ID,
      slug: `test-path-${PATH_ID.slice(0, 8)}`,
      name: 'Test Path for #2864',
      legacyId: 99999801,
    }));
  });

  // Row with both fields explicitly set
  await cds.tx(async (tx) => {
    await tx.run(INSERT.into(CompletionPathItems).entries({
      ID: ITEM_SET_ID,
      path_ID: PATH_ID,
      taskLegacyId: 99999801,
      taskType: 'CHECKPOINT',
      itemOrder: 1,
      temporarilyUnavailable: true,
      unavailableReason: 'Down for maintenance',
    }));
  });

  // Row without the new fields (should default temporarilyUnavailable to false)
  await cds.tx(async (tx) => {
    await tx.run(INSERT.into(CompletionPathItems).entries({
      ID: ITEM_DEFAULT_ID,
      path_ID: PATH_ID,
      taskLegacyId: 99999802,
      taskType: 'CHECKPOINT',
      itemOrder: 2,
    }));
  });
});

afterAll(async () => {
  const { CompletionPaths, CompletionPathItems } = cds.entities(NS);
  await cds.tx(async (tx) => {
    await tx.run(DELETE.from(CompletionPathItems).where({ path_ID: PATH_ID }));
    await tx.run(DELETE.from(CompletionPaths).where({ ID: PATH_ID }));
  });
});

describe('CompletionPathItems.temporarilyUnavailable + unavailableReason (#2864)', () => {
  it('round-trips temporarilyUnavailable:true + unavailableReason via AdminService OData', async () => {
    const res = await project.get(
      `/admin/CompletionPathItems(${ITEM_SET_ID})`,
      ADMIN_AUTH
    );
    expect(res.status).toBeLessThan(300);
    expect(res.data.temporarilyUnavailable).toBe(true);
    expect(res.data.unavailableReason).toBe('Down for maintenance');
  });

  it('defaults temporarilyUnavailable to false when not supplied on insert', async () => {
    const res = await project.get(
      `/admin/CompletionPathItems(${ITEM_DEFAULT_ID})`,
      ADMIN_AUTH
    );
    expect(res.status).toBeLessThan(300);
    expect(res.data.temporarilyUnavailable).toBe(false);
  });
});
