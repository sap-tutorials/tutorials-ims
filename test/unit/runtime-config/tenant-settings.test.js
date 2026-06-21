// test/unit/runtime-config/tenant-settings.test.js
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';
import {
  resolveTenantSettings,
  _resetCacheForTests,
} from '../../../srv/lib/runtime-config/tenant-settings.js';

const DEFAULT_CORS = 'http://localhost:1313,http://localhost:5000,http://localhost:4004';

beforeAll(async () => {
  await cds.deploy(path.join(process.cwd(), 'db', 'schema.cds')).to('sqlite::memory:');
});

beforeEach(async () => {
  const { TenantSettings } = cds.entities('com.sap.developers.ims');
  await DELETE.from(TenantSettings);
  delete process.env.ALLOWED_CORS_ORIGINS;
  delete process.env.REBUILD_TARGET_ENV;
  delete process.env.TECH_USERS;
  delete process.env.TECH_USERS_MAPPING;
  _resetCacheForTests();
});

describe('resolveTenantSettings (#466)', () => {
  it('returns hardcoded defaults when DB empty + env unset', async () => {
    const s = await resolveTenantSettings();
    expect(s).toEqual({
      allowedCorsOrigins: DEFAULT_CORS,
      rebuildTargetEnv: 'dev',
      techUsers: '',
      techUsersMapping: '',
    });
  });

  it('falls through to env vars when DB row absent', async () => {
    process.env.ALLOWED_CORS_ORIGINS = 'https://a.example.com,https://b.example.com';
    process.env.REBUILD_TARGET_ENV = 'prod';
    process.env.TECH_USERS = '{"foo":"bar"}';
    process.env.TECH_USERS_MAPPING = 'k=v';
    const s = await resolveTenantSettings();
    expect(s.allowedCorsOrigins).toBe('https://a.example.com,https://b.example.com');
    expect(s.rebuildTargetEnv).toBe('prod');
    expect(s.techUsers).toBe('{"foo":"bar"}');
    expect(s.techUsersMapping).toBe('k=v');
  });

  it('DB row wins over env var per field', async () => {
    process.env.ALLOWED_CORS_ORIGINS = 'https://from-env.example.com';
    process.env.REBUILD_TARGET_ENV = 'prod';
    const { TenantSettings } = cds.entities('com.sap.developers.ims');
    await INSERT.into(TenantSettings).entries({
      ID: 'ee000000-0000-0000-0000-000000000010',
      allowedCorsOrigins: 'https://from-db.example.com',
      rebuildTargetEnv: 'qa',
      techUsers: '{"db":"yes"}',
      techUsersMapping: 'admin=alice',
    });
    _resetCacheForTests();
    const s = await resolveTenantSettings();
    expect(s.allowedCorsOrigins).toBe('https://from-db.example.com');
    expect(s.rebuildTargetEnv).toBe('qa');
    expect(s.techUsers).toBe('{"db":"yes"}');
    expect(s.techUsersMapping).toBe('admin=alice');
  });

  it('mixed DB null + env present — env fills the gap', async () => {
    process.env.REBUILD_TARGET_ENV = 'prod';
    const { TenantSettings } = cds.entities('com.sap.developers.ims');
    await INSERT.into(TenantSettings).entries({
      ID: 'ee000000-0000-0000-0000-000000000011',
      allowedCorsOrigins: 'https://only-cors-set.example.com',
      // rebuildTargetEnv null → env wins
    });
    _resetCacheForTests();
    const s = await resolveTenantSettings();
    expect(s.allowedCorsOrigins).toBe('https://only-cors-set.example.com');
    expect(s.rebuildTargetEnv).toBe('prod');
  });

  it('caches reads within 5s TTL', async () => {
    const { TenantSettings } = cds.entities('com.sap.developers.ims');
    await INSERT.into(TenantSettings).entries({
      ID: 'ee000000-0000-0000-0000-000000000012',
      rebuildTargetEnv: 'qa',
    });
    _resetCacheForTests();
    const first = await resolveTenantSettings();
    expect(first.rebuildTargetEnv).toBe('qa');

    await UPDATE(TenantSettings).with({ rebuildTargetEnv: 'prod' });
    const second = await resolveTenantSettings();
    expect(second.rebuildTargetEnv).toBe('qa'); // cached
  });

  it('cache reset returns fresh row', async () => {
    const { TenantSettings } = cds.entities('com.sap.developers.ims');
    await INSERT.into(TenantSettings).entries({
      ID: 'ee000000-0000-0000-0000-000000000013',
      rebuildTargetEnv: 'qa',
    });
    _resetCacheForTests();
    expect((await resolveTenantSettings()).rebuildTargetEnv).toBe('qa');

    await UPDATE(TenantSettings).with({ rebuildTargetEnv: 'prod' });
    _resetCacheForTests();
    expect((await resolveTenantSettings()).rebuildTargetEnv).toBe('prod');
  });

  it('LargeString roundtrip — 5000-char value not truncated', async () => {
    const { TenantSettings } = cds.entities('com.sap.developers.ims');
    const longCsv = Array.from({ length: 200 }, (_, i) => `http://origin-${i}.example.com`).join(',');
    await INSERT.into(TenantSettings).entries({
      ID: 'ee000000-0000-0000-0000-000000000001',
      allowedCorsOrigins: longCsv,
    });
    _resetCacheForTests();
    const s = await resolveTenantSettings();
    expect(s.allowedCorsOrigins.length).toBeGreaterThan(5000);
    expect(s.allowedCorsOrigins).toBe(longCsv);
  });
});
