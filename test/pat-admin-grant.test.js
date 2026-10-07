import { describe, it, expect } from 'vitest';
import cds from '@sap/cds';

const { SELECT, INSERT } = cds.ql;

describe('AdminGrants entity', () => {
  const project = cds.test('serve', '--project', '.', '--in-memory');

  it('persists a grant row keyed by user with expiry', async () => {
    const db = await cds.connect.to('db');
    const { AdminGrants, Users } = cds.entities('com.sap.developers.ims');

    // Create a test user
    const userId = cds.utils.uuid();
    await db.run(INSERT.into(Users).entries({
      ID: userId, email: 'test@example.com', name: 'Test User'
    }));

    const exp = new Date(Date.now() + 30 * 864e5).toISOString();
    await db.run(INSERT.into(AdminGrants).entries({
      ID: cds.utils.uuid(), user_ID: userId, grantedBy: 'tom@sap.com', expiresAt: exp,
    }));
    const [row] = await db.run(SELECT.from(AdminGrants).where({ user_ID: userId }));
    expect(row).toBeDefined();
    expect(row.grantedBy).toBe('tom@sap.com');
  });
});
