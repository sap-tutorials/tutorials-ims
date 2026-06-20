// test/unit/runtime-config/ui-events-settings.test.js
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';
import {
  resolveUiEventsSettings,
  _resetCacheForTests,
} from '../../../srv/lib/runtime-config/ui-events-settings.js';

beforeAll(async () => {
  await cds.deploy(path.join(process.cwd(), 'db', 'schema.cds')).to('sqlite::memory:');
});

beforeEach(async () => {
  const { UiEventsSettings } = cds.entities('com.sap.developers.ims');
  await DELETE.from(UiEventsSettings);
  delete process.env.UI_EVENTS_ENABLED;
  _resetCacheForTests();
});

describe('resolveUiEventsSettings (#466)', () => {
  it('returns hardcoded default false when DB empty + env unset', async () => {
    const s = await resolveUiEventsSettings();
    expect(s).toEqual({ enabled: false });
  });

  it('falls through to env var when DB row absent', async () => {
    process.env.UI_EVENTS_ENABLED = 'true';
    const s = await resolveUiEventsSettings();
    expect(s.enabled).toBe(true);
  });

  it('DB row wins over env var (admin override)', async () => {
    process.env.UI_EVENTS_ENABLED = 'true';
    const { UiEventsSettings } = cds.entities('com.sap.developers.ims');
    await INSERT.into(UiEventsSettings).entries({
      ID: 'aa000000-0000-0000-0000-000000000001',
      enabled: false,
    });
    _resetCacheForTests();
    const s = await resolveUiEventsSettings();
    expect(s.enabled).toBe(false);
  });

  it('caches reads within 5s TTL', async () => {
    const { UiEventsSettings } = cds.entities('com.sap.developers.ims');
    await INSERT.into(UiEventsSettings).entries({
      ID: 'aa000000-0000-0000-0000-000000000002',
      enabled: true,
    });
    _resetCacheForTests();
    const first = await resolveUiEventsSettings();
    expect(first.enabled).toBe(true);

    await UPDATE(UiEventsSettings).with({ enabled: false });
    const second = await resolveUiEventsSettings();
    expect(second.enabled).toBe(true); // cached
  });

  it('cache reset returns fresh row', async () => {
    const { UiEventsSettings } = cds.entities('com.sap.developers.ims');
    await INSERT.into(UiEventsSettings).entries({
      ID: 'aa000000-0000-0000-0000-000000000003',
      enabled: true,
    });
    _resetCacheForTests();
    expect((await resolveUiEventsSettings()).enabled).toBe(true);

    await UPDATE(UiEventsSettings).with({ enabled: false });
    _resetCacheForTests();
    expect((await resolveUiEventsSettings()).enabled).toBe(false);
  });
});
