// test/unit/homepage-events-endpoint.test.js
// #1030 — HomepageService.events() semantics.
//
// Semantics (updated 2026-07-08 after field regression: AMERICAS-TZ users
// saw a naked "See the full events calendar" link because DEV had 0
// AMERICAS codejams):
//
//   - Manual Events entity rows → always included (admin-curated, region-agnostic)
//   - Devtoberfest CommunityEvents → always included (inherently virtual/global)
//   - CodeJam CommunityEvents     → honor region + includeVirtual filter
//   - Merged, sorted by startsAt asc, capped at 6.

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
  const { CommunityEvents } = cds.entities(NS_EXT);
  await INSERT.into(CommunityEvents).entries({
    ID: cds.utils.uuid(),
    slug: `ce-${Math.random().toString(36).slice(2, 10)}`,
    eventType: 'codejam',
    source: 'khoros',
    title: 'Test codejam',
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

async function seedManualEvent(overrides = {}) {
  const { Events } = cds.entities(NS);
  await INSERT.into(Events).entries({
    ID: cds.utils.uuid(),
    name: 'Manual event',
    startDate: '2099-06-01T00:00:00Z',
    timeZone: 'UTC',
    eventType: 'manual',
    ...overrides,
  });
}

async function ensureHomepageConfig(fields = {}) {
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
    const { CommunityEvents } = cds.entities(NS_EXT);
    const { Events } = cds.entities(NS);
    await DELETE.from(CommunityEvents);
    await DELETE.from(Events);
    await ensureHomepageConfig({ eventsBandAutoPullEnabled: true });
  });

  // ── CodeJam region filter (the surface that gets narrowed) ─────────────

  it('region=EMEA returns EMEA + virtual codejams', async () => {
    await seedCommunityEvent({ region: 'EMEA' });
    await seedCommunityEvent({ region: 'AMERICAS' });
    await seedCommunityEvent({ region: 'UNKNOWN', virtualOrInPerson: 'virtual', location: 'virtual' });
    const svc = await cds.connect.to('HomepageService');
    const rows = await svc.send('events', { region: 'EMEA', includeVirtual: true });
    expect(rows).toHaveLength(2);
    expect(rows.every(r => r.region === 'EMEA' || r.isVirtual)).toBe(true);
  });

  it('region=VIRTUAL returns only virtual codejams', async () => {
    await seedCommunityEvent({ region: 'EMEA' });
    await seedCommunityEvent({ region: 'UNKNOWN', virtualOrInPerson: 'virtual', location: 'virtual' });
    const svc = await cds.connect.to('HomepageService');
    const rows = await svc.send('events', { region: 'VIRTUAL' });
    expect(rows).toHaveLength(1);
    expect(rows[0].isVirtual).toBe(true);
  });

  it('region=ALL, includeVirtual=false excludes virtual codejams', async () => {
    await seedCommunityEvent({ region: 'EMEA' });
    await seedCommunityEvent({ region: 'UNKNOWN', virtualOrInPerson: 'virtual', location: 'virtual' });
    const svc = await cds.connect.to('HomepageService');
    const rows = await svc.send('events', { region: 'ALL', includeVirtual: false });
    expect(rows).toHaveLength(1);
    expect(rows[0].isVirtual).toBe(false);
  });

  it('region=EMEA, includeVirtual=false excludes virtual codejams', async () => {
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

  // ── Manual Events + Devtoberfest are region-agnostic (the fix) ─────────

  it('manual Events rows appear regardless of region', async () => {
    await seedManualEvent({ name: 'TechEd Berlin', startDate: '2099-10-01T00:00:00Z' });
    await seedCommunityEvent({ region: 'APJ', title: 'APJ codejam' });
    const svc = await cds.connect.to('HomepageService');

    // AMERICAS filter: manual event still shows even though no AMERICAS codejam exists.
    const rows = await svc.send('events', { region: 'AMERICAS' });
    expect(rows.some(r => r.title === 'TechEd Berlin')).toBe(true);
    // The APJ codejam is filtered out for AMERICAS.
    expect(rows.some(r => r.title === 'APJ codejam')).toBe(false);
  });

  it('Devtoberfest rows appear regardless of region', async () => {
    await seedCommunityEvent({ eventType: 'devtoberfest', region: 'UNKNOWN', virtualOrInPerson: 'virtual', title: 'Devtoberfest 2099' });
    await seedCommunityEvent({ eventType: 'codejam', region: 'APJ', title: 'APJ codejam' });
    const svc = await cds.connect.to('HomepageService');

    // AMERICAS filter: devtoberfest still shows.
    const rows = await svc.send('events', { region: 'AMERICAS' });
    expect(rows.some(r => r.title === 'Devtoberfest 2099')).toBe(true);
    expect(rows.some(r => r.title === 'APJ codejam')).toBe(false);
  });

  it('devtoberfest is not affected by includeVirtual=false', async () => {
    // Devtoberfest is inherently global; the region + virtual filter only
    // narrows codejams. A user turning off virtual should still see it.
    await seedCommunityEvent({ eventType: 'devtoberfest', region: 'UNKNOWN', virtualOrInPerson: 'virtual', title: 'Devtoberfest 2099' });
    const svc = await cds.connect.to('HomepageService');
    const rows = await svc.send('events', { region: 'AMERICAS', includeVirtual: false });
    expect(rows.some(r => r.title === 'Devtoberfest 2099')).toBe(true);
  });

  // ── Merge + ordering ──────────────────────────────────────────────────

  it('merged output caps at 6 items', async () => {
    for (let i = 0; i < 5; i++) await seedManualEvent({ name: `M${i}`, startDate: `2099-0${i + 1}-01T00:00:00Z` });
    for (let i = 0; i < 5; i++) await seedCommunityEvent({ region: 'EMEA', startDate: `2099-0${i + 1}-15` });
    const svc = await cds.connect.to('HomepageService');
    const rows = await svc.send('events', { region: 'EMEA' });
    expect(rows).toHaveLength(6);
  });

  it('orders merged output by startsAt ascending', async () => {
    await seedManualEvent({ name: 'M-mid', startDate: '2099-03-15T00:00:00Z' });
    await seedCommunityEvent({ region: 'EMEA', title: 'CJ-early', startDate: '2099-01-01' });
    await seedCommunityEvent({ region: 'EMEA', title: 'CJ-late',  startDate: '2099-06-01' });
    const svc = await cds.connect.to('HomepageService');
    const rows = await svc.send('events', { region: 'EMEA' });
    expect(rows.map(r => r.title)).toEqual(['CJ-early', 'M-mid', 'CJ-late']);
  });

  it('filters out past codejams', async () => {
    await seedCommunityEvent({ region: 'EMEA', startDate: '1999-01-01' });
    await seedCommunityEvent({ region: 'EMEA', startDate: '2099-01-01' });
    const svc = await cds.connect.to('HomepageService');
    const rows = await svc.send('events', { region: 'EMEA' });
    expect(rows).toHaveLength(1);
  });

  // ── Feature flag + cache ──────────────────────────────────────────────

  it('feature flag OFF falls back to legacy manual-Events-only shape', async () => {
    await ensureHomepageConfig({ eventsBandAutoPullEnabled: false });
    await seedManualEvent({ name: 'Legacy manual event', startDate: '2099-01-01T00:00:00Z' });
    await seedCommunityEvent({ region: 'EMEA', title: 'AutoPull codejam' });
    const svc = await cds.connect.to('HomepageService');
    const rows = await svc.send('events', { region: 'EMEA' });
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('Legacy manual event');
  });

  it('cache keys are isolated per (region, includeVirtual)', async () => {
    await seedCommunityEvent({ region: 'EMEA' });
    const svc = await cds.connect.to('HomepageService');
    const emea = await svc.send('events', { region: 'EMEA' });
    const americas = await svc.send('events', { region: 'AMERICAS' });
    expect(emea).toHaveLength(1);
    // AMERICAS: no manual events seeded, no codejams match → empty.
    expect(americas).toHaveLength(0);
  });
});
