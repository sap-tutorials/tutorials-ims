import { describe, it, expect, beforeEach } from 'vitest';
import cds from '@sap/cds';
import { getDevtoberfestInfo } from '../srv/lib/devtoberfest-joule-tool.js';

cds.test('serve', '--project', '.', '--in-memory');

const CONFIG_ID = '00000000-0000-0000-0000-000000000d10'; // Devtoberfest singleton
const EVENT_ID  = '00000000-0000-0000-0000-000000000e10';

async function seedEvent({ startOffsetDays, endOffsetDays }) {
  const { Events, DevtoberfestConfig } = cds.entities('com.sap.developers.ims');
  const now = Date.now();
  const start = startOffsetDays === null ? null : new Date(now + startOffsetDays * 86_400_000).toISOString();
  const end   = endOffsetDays   === null ? null : new Date(now + endOffsetDays   * 86_400_000).toISOString();

  await UPSERT.into(Events).entries({
    ID: EVENT_ID,
    name: 'Devtoberfest 2026',
    startDate: start,
    endDate: end,
    timeZone: 'Europe/Berlin'
  });
  await UPSERT.into(DevtoberfestConfig).entries({
    ID: CONFIG_ID,
    currentEvent_ID: EVENT_ID,
    termsText: '## Rules\n\nBe excellent to each other.',
    termsVersion: 3,
    contentRulesUrl: 'https://example.test/rules',
    faqUrl: 'https://example.test/faq',
    gameboardUrl: 'https://example.test/gameboard',
    activitiesUrl: 'https://example.test/activities'
  });
}

async function clear() {
  const { Events, DevtoberfestConfig } = cds.entities('com.sap.developers.ims');
  await DELETE.from(DevtoberfestConfig).where({ ID: CONFIG_ID });
  await DELETE.from(Events).where({ ID: EVENT_ID });
}

describe('getDevtoberfestInfo', () => {
  beforeEach(async () => { await clear(); });

  it('returns status=upcoming with positive daysUntilStart before the event', async () => {
    await seedEvent({ startOffsetDays: 7, endOffsetDays: 14 });
    const out = await getDevtoberfestInfo({});
    expect(out.event.status).toBe('upcoming');
    expect(out.event.daysUntilStart).toBeGreaterThan(0);
    expect(out.event.daysUntilStart).toBeLessThanOrEqual(7);
    expect(out.event.name).toBe('Devtoberfest 2026');
    expect(out.event.timeZone).toBe('Europe/Berlin');
  });

  it('returns status=active when now is between start and end', async () => {
    await seedEvent({ startOffsetDays: -2, endOffsetDays: 5 });
    const out = await getDevtoberfestInfo({ section: 'event' });
    expect(out.event.status).toBe('active');
    expect(out.event.daysUntilEnd).toBeGreaterThan(0);
  });

  it('returns status=ended after endDate', async () => {
    await seedEvent({ startOffsetDays: -30, endOffsetDays: -5 });
    const out = await getDevtoberfestInfo({});
    expect(out.event.status).toBe('ended');
    expect(out.event.daysUntilStart).toBeLessThanOrEqual(-30);
  });

  it('returns status=unconfigured when DevtoberfestConfig has no currentEvent', async () => {
    const { DevtoberfestConfig } = cds.entities('com.sap.developers.ims');
    await UPSERT.into(DevtoberfestConfig).entries({ ID: CONFIG_ID, currentEvent_ID: null });
    const out = await getDevtoberfestInfo({});
    expect(out.event.status).toBe('unconfigured');
    expect(out.event.name).toBeNull();
    expect(out.event.startDate).toBeNull();
  });

  it('returns status=unconfigured when the DevtoberfestConfig row itself is missing', async () => {
    // No seed — table is empty.
    const out = await getDevtoberfestInfo({});
    expect(out.event.status).toBe('unconfigured');
  });

  it("section='terms' returns terms body and version, omits links/placeholders", async () => {
    await seedEvent({ startOffsetDays: 7, endOffsetDays: 14 });
    const out = await getDevtoberfestInfo({ section: 'terms' });
    expect(out.terms).toEqual({ available: true, version: 3, body: '## Rules\n\nBe excellent to each other.' });
    expect(out.links).toBeUndefined();
    expect(out.points).toBeUndefined();
  });

  it("section='terms' returns available:false when termsText is empty", async () => {
    await seedEvent({ startOffsetDays: 7, endOffsetDays: 14 });
    const { DevtoberfestConfig } = cds.entities('com.sap.developers.ims');
    await UPDATE(DevtoberfestConfig).set({ termsText: '' }).where({ ID: CONFIG_ID });
    const out = await getDevtoberfestInfo({ section: 'terms' });
    expect(out.terms.available).toBe(false);
  });

  it("section='links' returns the four URL fields", async () => {
    await seedEvent({ startOffsetDays: 7, endOffsetDays: 14 });
    const out = await getDevtoberfestInfo({ section: 'links' });
    expect(out.links.contentRulesUrl).toBe('https://example.test/rules');
    expect(out.links.gameboardUrl).toBe('https://example.test/gameboard');
  });

  it("placeholder sections return { available: false, comingSoon: true }", async () => {
    await seedEvent({ startOffsetDays: 7, endOffsetDays: 14 });
    for (const sec of ['points', 'gameboard', 'activities', 'videos']) {
      const out = await getDevtoberfestInfo({ section: sec });
      expect(out[sec]).toEqual({ available: false, comingSoon: true });
    }
  });

  it("section='all' (default) returns event + terms + links + four placeholders", async () => {
    await seedEvent({ startOffsetDays: 7, endOffsetDays: 14 });
    const out = await getDevtoberfestInfo({});
    expect(out.event).toBeDefined();
    expect(out.terms.available).toBe(true);
    expect(out.links).toBeDefined();
    for (const sec of ['points', 'gameboard', 'activities', 'videos']) {
      expect(out[sec]).toEqual({ available: false, comingSoon: true });
    }
    expect(typeof out.generatedAt).toBe('string');
    expect(() => new Date(out.generatedAt).toISOString()).not.toThrow();
  });

  it('ignores invalid section args and falls back to all', async () => {
    await seedEvent({ startOffsetDays: 7, endOffsetDays: 14 });
    const out = await getDevtoberfestInfo({ section: 'nonsense' });
    expect(out.event).toBeDefined();
    expect(out.links).toBeDefined();
  });
});
