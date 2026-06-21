// test/unit/runtime-config/display-settings.test.js
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';
import {
  resolveDisplaySettings,
  _resetCacheForTests,
} from '../../../srv/lib/runtime-config/display-settings.js';

const HARDCODED_DEFAULT_URL =
  'https://tutorials-approuter.cfapps.eu10-005.hana.ondemand.com/ui/tutorialDashboard';

beforeAll(async () => {
  await cds.deploy(path.join(process.cwd(), 'db', 'schema.cds')).to('sqlite::memory:');
});

beforeEach(async () => {
  const { DisplaySettings } = cds.entities('com.sap.developers.ims');
  await DELETE.from(DisplaySettings);
  delete process.env.DASHBOARD_URL;
  _resetCacheForTests();
});

describe('resolveDisplaySettings (#466)', () => {
  it('returns hardcoded default URL when DB empty + env unset', async () => {
    const s = await resolveDisplaySettings();
    expect(s).toEqual({ dashboardUrl: HARDCODED_DEFAULT_URL });
  });

  it('falls through to env var when DB row absent', async () => {
    process.env.DASHBOARD_URL = 'https://custom-dashboard.example.com/ui/d';
    const s = await resolveDisplaySettings();
    expect(s.dashboardUrl).toBe('https://custom-dashboard.example.com/ui/d');
  });

  it('DB row wins over env var (admin override)', async () => {
    process.env.DASHBOARD_URL = 'https://from-env.example.com';
    const { DisplaySettings } = cds.entities('com.sap.developers.ims');
    await INSERT.into(DisplaySettings).entries({
      ID: 'dd000000-0000-0000-0000-000000000001',
      dashboardUrl: 'https://from-db.example.com/ui',
    });
    _resetCacheForTests();
    const s = await resolveDisplaySettings();
    expect(s.dashboardUrl).toBe('https://from-db.example.com/ui');
  });

  it('caches reads within 5s TTL', async () => {
    const { DisplaySettings } = cds.entities('com.sap.developers.ims');
    await INSERT.into(DisplaySettings).entries({
      ID: 'dd000000-0000-0000-0000-000000000002',
      dashboardUrl: 'https://first.example.com',
    });
    _resetCacheForTests();
    const first = await resolveDisplaySettings();
    expect(first.dashboardUrl).toBe('https://first.example.com');

    await UPDATE(DisplaySettings).with({ dashboardUrl: 'https://second.example.com' });
    const second = await resolveDisplaySettings();
    expect(second.dashboardUrl).toBe('https://first.example.com'); // cached
  });

  it('cache reset returns fresh row', async () => {
    const { DisplaySettings } = cds.entities('com.sap.developers.ims');
    await INSERT.into(DisplaySettings).entries({
      ID: 'dd000000-0000-0000-0000-000000000003',
      dashboardUrl: 'https://first.example.com',
    });
    _resetCacheForTests();
    expect((await resolveDisplaySettings()).dashboardUrl).toBe('https://first.example.com');

    await UPDATE(DisplaySettings).with({ dashboardUrl: 'https://second.example.com' });
    _resetCacheForTests();
    expect((await resolveDisplaySettings()).dashboardUrl).toBe('https://second.example.com');
  });
});
