// test/unit/runtime-config/navigator-settings.test.js
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';
import {
  resolveNavigatorSettings,
  _resetCacheForTests,
} from '../../../srv/lib/runtime-config/navigator-settings.js';

beforeAll(async () => {
  await cds.deploy(path.join(process.cwd(), 'db', 'schema.cds')).to('sqlite::memory:');
});

beforeEach(async () => {
  const { NavigatorSettings } = cds.entities('com.sap.developers.ims');
  await DELETE.from(NavigatorSettings);
  delete process.env.NAV_INCLUDE_NESTED_GROUPS;
  _resetCacheForTests();
});

describe('resolveNavigatorSettings (#466)', () => {
  it('returns hardcoded default false when DB empty + env unset', async () => {
    const s = await resolveNavigatorSettings();
    expect(s).toEqual({ includeNestedGroups: false });
  });

  it('falls through to env var when DB row absent', async () => {
    process.env.NAV_INCLUDE_NESTED_GROUPS = 'true';
    const s = await resolveNavigatorSettings();
    expect(s.includeNestedGroups).toBe(true);
  });

  it('DB row wins over env var (admin override)', async () => {
    process.env.NAV_INCLUDE_NESTED_GROUPS = 'true';
    const { NavigatorSettings } = cds.entities('com.sap.developers.ims');
    await INSERT.into(NavigatorSettings).entries({
      ID: 'cc000000-0000-0000-0000-000000000001',
      includeNestedGroups: false,
    });
    _resetCacheForTests();
    const s = await resolveNavigatorSettings();
    expect(s.includeNestedGroups).toBe(false);
  });

  it('caches reads within 5s TTL', async () => {
    const { NavigatorSettings } = cds.entities('com.sap.developers.ims');
    await INSERT.into(NavigatorSettings).entries({
      ID: 'cc000000-0000-0000-0000-000000000002',
      includeNestedGroups: true,
    });
    _resetCacheForTests();
    const first = await resolveNavigatorSettings();
    expect(first.includeNestedGroups).toBe(true);

    await UPDATE(NavigatorSettings).with({ includeNestedGroups: false });
    const second = await resolveNavigatorSettings();
    expect(second.includeNestedGroups).toBe(true); // cached
  });

  it('cache reset returns fresh row', async () => {
    const { NavigatorSettings } = cds.entities('com.sap.developers.ims');
    await INSERT.into(NavigatorSettings).entries({
      ID: 'cc000000-0000-0000-0000-000000000003',
      includeNestedGroups: true,
    });
    _resetCacheForTests();
    expect((await resolveNavigatorSettings()).includeNestedGroups).toBe(true);

    await UPDATE(NavigatorSettings).with({ includeNestedGroups: false });
    _resetCacheForTests();
    expect((await resolveNavigatorSettings()).includeNestedGroups).toBe(false);
  });
});
