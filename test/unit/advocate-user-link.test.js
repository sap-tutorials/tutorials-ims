// Schema-level tests for Advocates.user 1:1 optional association.
// Spec: docs/superpowers/specs/2026-06-25-advocate-user-link-design.md
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';
import path from 'node:path';

const schemaPath = path.join(process.cwd(), 'db', 'schema.cds');

describe('Advocates.user 1:1 association — schema', () => {
  let db;
  beforeAll(async () => {
    cds.env.requires.db = { kind: 'sqlite', credentials: { database: ':memory:' } };
    db = await cds.deploy(schemaPath).to('sqlite::memory:');
  });
  afterAll(async () => { await db?.disconnect?.(); });

  it('allows null user_ID (advocate without link)', async () => {
    const { Advocates } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Advocates).entries({ slug: 'no-link-1', firstName: 'A', lastName: 'B' });
    const row = await SELECT.one.from(Advocates).where({ slug: 'no-link-1' });
    expect(row.user_ID).toBeNull();
  });

  it('allows linking an advocate to a user', async () => {
    const { Advocates, Users } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Users).entries({ uuid: 'u-1', email: 'u1@example.com' });
    const userRow = await SELECT.one.from(Users).where({ uuid: 'u-1' });
    await INSERT.into(Advocates).entries({ slug: 'linked-1', firstName: 'L', lastName: 'M', user_ID: userRow.ID });
    const adv = await SELECT.one.from(Advocates).where({ slug: 'linked-1' });
    expect(adv.user_ID).toBe(userRow.ID);
  });

  it('rejects linking two advocates to the same user (@assert.unique.user)', async () => {
    const { Advocates, Users } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Users).entries({ uuid: 'u-2', email: 'u2@example.com' });
    const userRow = await SELECT.one.from(Users).where({ uuid: 'u-2' });
    await INSERT.into(Advocates).entries({ slug: 'dup-1', firstName: 'D', lastName: 'X', user_ID: userRow.ID });
    await expect(
      INSERT.into(Advocates).entries({ slug: 'dup-2', firstName: 'D', lastName: 'Y', user_ID: userRow.ID })
    ).rejects.toThrow(/UNIQUE|constraint|ASSERT_UNIQUE/i);
  });

  it('allows multiple advocates with null user (NULL ≠ NULL)', async () => {
    const { Advocates } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Advocates).entries({ slug: 'no-link-2', firstName: 'A', lastName: 'C' });
    await INSERT.into(Advocates).entries({ slug: 'no-link-3', firstName: 'A', lastName: 'D' });
    const rows = await SELECT.from(Advocates).where({ user_ID: null });
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });
});
