// test/unit/homepage-events-endpoint.test.js
// #1030 — HomepageService.events() region+virtual filter + cache + flag.

import { describe, it, expect, beforeEach } from 'vitest';
import cds from '@sap/cds';
import { _resetForTests } from '../../srv/homepage-service.js';

const NS_EXT = 'com.sap.developers.ims.external';
const NS = 'com.sap.developers.ims';
const HOMEPAGE_CONFIG_SINGLETON_ID = '00000000-0000-0000-0000-00000000c8ae';

const { test } = cds;
test.in(__dirname, '..', '..');
test('serve', 'all', '--in-memory');

async function seedCommunityEvent(overrides = {}) {
  const db = await cds.connect.to('db');
  const { CommunityEvents } = cds.entities(NS_EXT);
  await INSERT.into(CommunityEvents).entries({
    ID: cds.utils.uuid(),
    slug: `ce-${Math.random().toString(36).slice(2, 10)}`,
    eventType: 'codejam',
    source: 'khoros',
    title: 'Test event',
    url: 'https://example.com/e',
    sourceId: `codejam/${Math.random()}`,
    location: 'Berlin, Germany',
    scope: 'local',
    virtualOrInPerson: 'in-person',
    region: 'EMEA',
    startDate: '2099-01-01',
    endDate: '2099-01-01',
    lastSeenAt: new Date(),
    firstSeenAt: new Date(),
    ...overrides,
  });
}

async function ensureHomepageConfig(fields = {}) {
  const db = await cds.connect.to('db');
  const { HomepageConfig } = cds.entities(NS);
  const existing = await SELECT.one.from(HomepageConfig).where({ ID: HOMEPAGE_CONFIG_SINGLETON_ID });
  if (existing) {
    await UPDATE(HomepageConfig).where({ ID: HOMEPAGE_CONFIG_SINGLETON_ID }).set(fields);
  } else {
    await INSERT.into(HomepageConfig).entries({ ID: HOMEPAGE_CONFIG_SINGLETON_ID, ...fields });
  }
}

describe('HomepageService.events()', () => {
  beforeEach(async () => {
    _resetForTests();
    const db = await cds.connect.to('db');
    const { CommunityEvents } = cds.entities(NS_EXT);
    await DELETE.from(CommunityEvents);
    await ensureHomepageConfig({ eventsBandAutoPullEnabled: true });
  });

  it('region=EMEA returns only EMEA + virtual rows', async () => {
    await seedCommunityEvent({ region: 'EMEA' });
    await seedCommunityEvent({ region: 'AMERICAS' });
    await seedCommunityEvent({ region: 'UNKNOWN', virtualOrInPerson: 'virtual', location: 'virtual' });
    const svc = await cds.connect.to('HomepageService');
    const rows = await svc.send('events', { region: 'EMEA', includeVirtual: true });
    expect(rows).toHaveLength(2);
    expect(rows.every(r => r.region === 'EMEA' || r.isVirtual)).toBe(true);
  });

  it('region=VIRTUAL returns only virtual rows', async () => {
    await seedCommunityEvent({ region: 'EMEA' });
    await seedCommunityEvent({ region: 'UNKNOWN', virtualOrInPerson: 'virtual', location: 'virtual' });
    const svc = await cds.connect.to('HomepageService');
    const rows = await svc.send('events', { region: 'VIRTUAL' });
    expect(rows).toHaveLength(1);
    expect(rows[0].isVirtual).toBe(true);
  });

  it('region=ALL, includeVirtual=false excludes virtual rows', async () => {
    await seedCommunityEvent({ region: 'EMEA' });
    await seedCommunityEvent({ region: 'UNKNOWN', virtualOrInPerson: 'virtual', location: 'virtual' });
    const svc = await cds.connect.to('HomepageService');
    const rows = await svc.send('events', { region: 'ALL', includeVirtual: false });
    expect(rows).toHaveLength(1);
    expect(rows[0].isVirtual).toBe(false);
  });

  it('region=EMEA, includeVirtual=false excludes virtual rows', async () => {
    await seedCommunityEvent({ region: 'EMEA' });
    await seedCommunityEvent({ region: 'UNKNOWN', virtualOrInPerson: 'virtual', location: 'virtual' });
    const svc = await cds.connect.to('HomepageService');
    const rows = await svc.send('events', { region: 'EMEA', includeVirtual: false });
    expect(rows).toHaveLength(1);
    expect(rows[0].region).toBe('EMEA');
  });

  it('invalid region coerces to ALL (does not 400)', async () => {
    await seedCommunityEvent({ region: 'EMEA' });
    const svc = await cds.connect.to('HomepageService');
    const rows = await svc.send('events', { region: 'BOGUS' });
    expect(rows).toHaveLength(1);
  });

  it('caps result at 6 items', async () => {
    for (let i = 0; i < 10; i++) await seedCommunityEvent({ region: 'EMEA' });
    const svc = await cds.connect.to('HomepageService');
    const rows = await svc.send('events', { region: 'EMEA' });
    expect(rows).toHaveLength(6);
  });

  it('orders by startDate ascending', async () => {
    await seedCommunityEvent({ region: 'EMEA', startDate: '2099-06-01' });
    await seedCommunityEvent({ region: 'EMEA', startDate: '2099-01-01' });
    await seedCommunityEvent({ region: 'EMEA', startDate: '2099-03-01' });
    const svc = await cds.connect.to('HomepageService');
    const rows = await svc.send('events', { region: 'EMEA' });
    expect(rows.map(r => r.startsAt)).toEqual(['2099-01-01', '2099-03-01', '2099-06-01']);
  });

  it('filters out past events', async () => {
    await seedCommunityEvent({ region: 'EMEA', startDate: '1999-01-01' });
    await seedCommunityEvent({ region: 'EMEA', startDate: '2099-01-01' });
    const svc = await cds.connect.to('HomepageService');
    const rows = await svc.send('events', { region: 'EMEA' });
    expect(rows).toHaveLength(1);
  });

  it('feature flag OFF falls back to legacy Events entity shape', async () => {
    await ensureHomepageConfig({ eventsBandAutoPullEnabled: false });
    const db = await cds.connect.to('db');
    const { Events, CommunityEvents } = cds.entities(NS);
    await INSERT.into(Events).entries({
      ID: cds.utils.uuid(), name: 'Legacy manual event', startDate: '2099-01-01', timeZone: 'UTC', eventType: 'manual',
    });
    await seedCommunityEvent({ region: 'EMEA', title: 'AutoPull event' });
    const svc = await cds.connect.to('HomepageService');
    const rows = await svc.send('events', { region: 'EMEA' });
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('Legacy manual event');   // came from legacy Events, not CommunityEvents
  });

  it('cache keys are isolated per (region, includeVirtual)', async () => {
    await seedCommunityEvent({ region: 'EMEA' });
    const svc = await cds.connect.to('HomepageService');
    const emea = await svc.send('events', { region: 'EMEA' });
    const americas = await svc.send('events', { region: 'AMERICAS' });
    expect(emea).toHaveLength(1);
    expect(americas).toHaveLength(0);
  });
});
