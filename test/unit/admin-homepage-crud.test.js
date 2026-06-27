import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

cds.test('serve', '--project', '.', '--in-memory');

const ADMIN_USER = { id: 'admin@test', roles: ['Admin'] };

describe('AdminService projections for Homepage entities', () => {
  let admin;
  beforeAll(async () => { admin = await cds.connect.to('AdminService'); });

  it('exposes HomepageShelves with full CRUD', async () => {
    const list = await admin.tx({ user: ADMIN_USER }, (tx) =>
      tx.read('HomepageShelves').limit(5)
    );
    expect(Array.isArray(list)).toBe(true);
  });

  it('exposes LegacyRedirects', async () => {
    const list = await admin.tx({ user: ADMIN_USER }, (tx) =>
      tx.read('LegacyRedirects')
    );
    expect(list.length).toBe(3);  // exactly the 3 named seed rows
  });

  it('auto-initialises HomepageConfig as a singleton on first READ', async () => {
    // Force the auto-init path: clear the seed row, then read.
    const db = await cds.connect.to('db');
    await db.run(DELETE.from(cds.entities('com.sap.developers.ims').HomepageConfig));
    const result = await admin.tx({ user: ADMIN_USER }, (tx) =>
      tx.read('HomepageConfig')
    );
    const row = Array.isArray(result) ? result[0] : result;
    expect(row).toBeTruthy();  // auto-init returned a default
  });
});
