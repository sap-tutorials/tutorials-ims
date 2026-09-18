// test/unit/homepage-events-teched.test.js
// #2312 (Unit 10) — TechEd sessions on the homepage events band.
//
// Contract:
//   - Gated behind the TECHED_HOMEPAGE_ENABLED DB feature flag (default OFF).
//   - Flag OFF (or unset)  → no TechEd cards, band unchanged.
//   - Flag ON + sessions   → upcoming TechEd sessions appear as EventCards,
//                            region-agnostic (like Devtoberfest), url → /teched/
//                            when the session has no own url.
//   - Flag ON + no sessions → no TechEd cards (fail-open / empty).
//   - Past sessions are dropped.

import { describe, it, expect, beforeEach } from 'vitest';
import cds from '@sap/cds';
import { _resetForTests } from '../../srv/homepage-service.js';
import {
  refreshFeatureFlags,
  bustFeatureFlagsCache,
} from '../../srv/lib/feature-flags/db-flags.js';

const NS_EXT = 'com.sap.developers.ims.external';
const NS = 'com.sap.developers.ims';
const HOMEPAGE_CONFIG_SINGLETON_ID = '00000000-0000-0000-0000-00000000c8ae';
const TECHED_IMS_KEY = 'flag.homepage.teched';

const { test } = cds;
test.in(__dirname, '..', '..');
test('serve', 'all', '--in-memory');

async function seedTechEd(overrides = {}) {
  const { TechEdSessions } = cds.entities(NS_EXT);
  const rand = Math.random().toString(36).slice(2, 10);
  await INSERT.into(TechEdSessions).entries({
    ID: cds.utils.uuid(),
    sourceId: `te/${rand}`,
    slug: `teched-${rand}`,
    venue: 'BERLIN',
    title: 'TechEd session',
    scheduledStart: '2099-11-11T09:00:00Z',
    scheduledEnd: '2099-11-11T10:00:00Z',
    room: 'Hall A',
    url: 'https://example.com/teched/session',
    ...overrides,
  });
}

// Set the ImsConfig-backed flag and warm the synchronous flag cache so
// isFlagEnabled() reflects it immediately in this process.
async function setTechedFlag(enabled) {
  const { ImsConfig } = cds.entities(NS);
  const existing = await SELECT.one.from(ImsConfig).where({ key: TECHED_IMS_KEY });
  if (existing) {
    await UPDATE(ImsConfig).where({ key: TECHED_IMS_KEY }).set({ value: String(enabled) });
  } else {
    await INSERT.into(ImsConfig).entries({ ID: cds.utils.uuid(), key: TECHED_IMS_KEY, value: String(enabled) });
  }
  bustFeatureFlagsCache();
  await refreshFeatureFlags();
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

describe('HomepageService.events() — TechEd band (#2312)', () => {
  beforeEach(async () => {
    _resetForTests();
    const { TechEdSessions } = cds.entities(NS_EXT);
    const { CommunityEvents } = cds.entities(NS_EXT);
    const { Events } = cds.entities(NS);
    await DELETE.from(TechEdSessions);
    await DELETE.from(CommunityEvents);
    await DELETE.from(Events);
    await ensureHomepageConfig({ eventsBandAutoPullEnabled: true });
  });

  it('flag OFF → no TechEd cards even when sessions exist', async () => {
    await setTechedFlag(false);
    await seedTechEd({ title: 'TechEd Berlin Keynote' });
    const svc = await cds.connect.to('HomepageService');
    const rows = await svc.send('events', { region: 'ALL' });
    expect(rows.some(r => r.eventType === 'teched')).toBe(false);
    expect(rows).toHaveLength(0);
  });

  it('flag ON → upcoming TechEd session appears as an EventCard, always virtual (#2417)', async () => {
    await setTechedFlag(true);
    await seedTechEd({ title: 'TechEd Berlin Keynote' });
    const svc = await cds.connect.to('HomepageService');
    // Even under an AMERICAS filter (no matching codejam), TechEd shows.
    const rows = await svc.send('events', { region: 'AMERICAS' });
    const card = rows.find(r => r.title === 'TechEd Berlin Keynote');
    expect(card).toBeTruthy();
    expect(card.eventType).toBe('teched');
    expect(card.url).toBe('https://example.com/teched/session');
    // #2417 — a BERLIN (in-person) session is still surfaced as VIRTUAL on the
    // band so it stays out of the EMEA/in-person region lanes.
    expect(card.isVirtual).toBe(true);
    expect(card.region).toBe('VIRTUAL');
    expect(card.location).toBe('Virtual');
  });

  it('flag ON → BERLIN session is presented as virtual, never as an in-person card (#2417)', async () => {
    await setTechedFlag(true);
    await seedTechEd({ title: 'TechEd Berlin Keynote', venue: 'BERLIN', room: 'Hall A' });
    const svc = await cds.connect.to('HomepageService');
    // Under any filter the TechEd card is region-agnostic (always merged), but it
    // must present as virtual — never carrying an in-person region/location that
    // would slot it into the EMEA/in-person lane (#2417).
    for (const region of ['ALL', 'EMEA', 'AMERICAS', 'APJ', 'VIRTUAL']) {
      const rows = await svc.send('events', { region });
      const card = rows.find(r => r.title === 'TechEd Berlin Keynote');
      expect(card, `card present under ${region}`).toBeTruthy();
      expect(card.isVirtual, `isVirtual under ${region}`).toBe(true);
      expect(card.region, `region under ${region}`).toBe('VIRTUAL');
      expect(card.location, `location under ${region}`).toBe('Virtual');
    }
  });

  it('flag ON → url falls back to /teched/ when the session has none', async () => {
    await setTechedFlag(true);
    await seedTechEd({ title: 'TechEd No URL', url: null });
    const svc = await cds.connect.to('HomepageService');
    const rows = await svc.send('events', { region: 'ALL' });
    const card = rows.find(r => r.title === 'TechEd No URL');
    expect(card).toBeTruthy();
    expect(card.url).toBe('/teched/');
  });

  it('flag ON → VIRTUAL venue maps to isVirtual + VIRTUAL region', async () => {
    await setTechedFlag(true);
    await seedTechEd({ title: 'TechEd Virtual', venue: 'VIRTUAL', room: null });
    const svc = await cds.connect.to('HomepageService');
    const rows = await svc.send('events', { region: 'ALL' });
    const card = rows.find(r => r.title === 'TechEd Virtual');
    expect(card).toBeTruthy();
    expect(card.isVirtual).toBe(true);
    expect(card.region).toBe('VIRTUAL');
    expect(card.location).toBe('Virtual');
  });

  it('flag ON + no sessions → no TechEd cards (empty band, fail-open)', async () => {
    await setTechedFlag(true);
    const svc = await cds.connect.to('HomepageService');
    const rows = await svc.send('events', { region: 'ALL' });
    expect(rows).toHaveLength(0);
  });

  it('flag ON → past TechEd sessions are dropped', async () => {
    await setTechedFlag(true);
    await seedTechEd({ title: 'TechEd Past', scheduledStart: '1999-11-11T09:00:00Z' });
    await seedTechEd({ title: 'TechEd Future', scheduledStart: '2099-11-11T09:00:00Z' });
    const svc = await cds.connect.to('HomepageService');
    const rows = await svc.send('events', { region: 'ALL' });
    expect(rows.some(r => r.title === 'TechEd Past')).toBe(false);
    expect(rows.some(r => r.title === 'TechEd Future')).toBe(true);
  });
});
