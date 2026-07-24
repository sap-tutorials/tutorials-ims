import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

cds.test('serve', '--project', '.', '--in-memory');
const ADMIN_USER = { id: 'admin@test', roles: ['Admin'] };

describe('LegacyRedirects save-time validation (#752)', () => {
  let admin;
  beforeAll(async () => { admin = await cds.connect.to('AdminService'); });

  it('accepts a same-origin toPath', async () => {
    await expect(
      admin.tx({ user: ADMIN_USER }, (tx) =>
        tx.create('LegacyRedirects').entries({ fromPath: '/same-origin-ok', toPath: '/tutorials/', statusCode: 301, isPattern: false, isActive: true })
      )
    ).resolves.toBeTruthy();
  });

  it('accepts an allowlisted external toPath', async () => {
    await expect(
      admin.tx({ user: ADMIN_USER }, (tx) =>
        tx.create('LegacyRedirects').entries({ fromPath: '/ext-ok', toPath: 'https://community.sap.com/topics/leonardo', statusCode: 301, isPattern: false, isActive: true })
      )
    ).resolves.toBeTruthy();
  });

  it('rejects a non-allowlisted external toPath', async () => {
    await expect(
      admin.tx({ user: ADMIN_USER }, (tx) =>
        tx.create('LegacyRedirects').entries({ fromPath: '/ext-bad', toPath: 'https://attacker.example/x', statusCode: 301, isPattern: false, isActive: true })
      )
    ).rejects.toThrow(/allowlisted SAP host|same-origin/i);
  });

  it('rejects an http (non-https) external toPath', async () => {
    await expect(
      admin.tx({ user: ADMIN_USER }, (tx) =>
        tx.create('LegacyRedirects').entries({ fromPath: '/ext-http', toPath: 'http://community.sap.com/x', statusCode: 301, isPattern: false, isActive: true })
      )
    ).rejects.toThrow();
  });
});
