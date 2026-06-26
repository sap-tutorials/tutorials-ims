// test/unit/runtime-config/tenant-settings.test.js
//
// CHAIN AFTER credstore-runtime-config follow-up:
//   DB row -> hardcoded DEFAULTS. NO env-var fallback.
//
// The pre-PR chain was DB -> env -> DEFAULTS. The env layer was removed
// because the admin UI at /admin-ui/#tenantsettings-display is now the
// sole source of truth for these values; an env-var fallback would
// silently mask admin-UI writes until the next app restart.
//
// These tests SPECIFICALLY assert that env vars no longer influence
// the resolver — so a future revert / accidental re-introduction of
// env-fallback would fail loudly.

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

describe('resolveTenantSettings (#466 + credstore-runtime-config follow-up)', () => {
  it('returns hardcoded DEFAULTS when DB empty', async () => {
    const s = await resolveTenantSettings();
    expect(s).toEqual({
      allowedCorsOrigins: DEFAULT_CORS,
      rebuildTargetEnv: 'dev',
      techUsers: '',
      techUsersMapping: '',
    });
  });

  it('IGNORES env vars when DB row absent — returns DEFAULTS', async () => {
    // Pre-PR behavior: env wins. Post-PR: env is invisible to the resolver,
    // because the admin UI is the sole source of truth.
    process.env.ALLOWED_CORS_ORIGINS = 'https://a.example.com,https://b.example.com';
    process.env.REBUILD_TARGET_ENV = 'prod';
    process.env.TECH_USERS = '{"foo":"bar"}';
    process.env.TECH_USERS_MAPPING = 'k=v';
    const s = await resolveTenantSettings();
    expect(s.allowedCorsOrigins).toBe(DEFAULT_CORS);
    expect(s.rebuildTargetEnv).toBe('dev');
    expect(s.techUsers).toBe('');
    expect(s.techUsersMapping).toBe('');
  });

  it('DB row wins over hardcoded DEFAULTS per field', async () => {
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

  it('mixed DB null + env present — env STILL ignored, DEFAULTS fills the gap', async () => {
    // Regression guard: if anyone re-introduces env-fallback, this test
    // would flip from 'dev' to 'prod' and fail loudly.
    process.env.REBUILD_TARGET_ENV = 'prod';
    const { TenantSettings } = cds.entities('com.sap.developers.ims');
    await INSERT.into(TenantSettings).entries({
      ID: 'ee000000-0000-0000-0000-000000000011',
      allowedCorsOrigins: 'https://only-cors-set.example.com',
      // rebuildTargetEnv null → DEFAULTS (NOT env) wins
    });
    _resetCacheForTests();
    const s = await resolveTenantSettings();
    expect(s.allowedCorsOrigins).toBe('https://only-cors-set.example.com');
    expect(s.rebuildTargetEnv).toBe('dev'); // DEFAULTS.rebuildTargetEnv, NOT env's 'prod'
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
