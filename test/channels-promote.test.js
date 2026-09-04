// test/channels-promote.test.js
import cds from '@sap/cds';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mapChannelToShelf, promoteFeatured } from '../srv/lib/channels/promote-to-shelves.js';

const project = cds.test('serve', '--project', '.', '--in-memory');
const NS = 'com.sap.developers.ims';
const linked = () => cds.linked(cds.model).entities(NS);

describe('mapChannelToShelf', () => {
  it('maps an SAP learning portal to START_HERE/learn', () => {
    expect(mapChannelToShelf({ isSapOwned: true, category: 'Learning', focusAreas: ['onboarding'] }))
      .toEqual({ verb: 'LEARN', shelf: 'START_HERE' });
  });
  it('never puts a community channel in START_HERE', () => {
    const m = mapChannelToShelf({ isSapOwned: false, category: 'Learning', focusAreas: ['onboarding'] });
    expect(m?.shelf).not.toBe('START_HERE');
  });
  it('maps a GitHub repo to TOOLS', () => {
    expect(mapChannelToShelf({ isSapOwned: true, category: 'GitHub Repository', focusAreas: ['cap'] }).shelf).toBe('TOOLS');
  });
});

describe('promoteFeatured', () => {
  beforeAll(async () => {
    const { Channels } = linked();
    await INSERT.into(Channels).entries([
      { ID: cds.utils.uuid(), sourceId: 'promo-sap', name: 'CAP Docs', url: 'https://promo-cap', isSapOwned: true, isFeatured: true, isPublished: true, category: 'Portal', focusAreas: ['cap'] },
      { ID: cds.utils.uuid(), sourceId: 'promo-comm', name: 'Reddit', url: 'https://promo-reddit', isSapOwned: false, isFeatured: true, isPublished: true, category: 'Community', focusAreas: ['abap'] },
    ]);
  });
  afterAll(async () => {
    await DELETE.from(linked().Channels).where({ sourceId: { in: ['promo-sap', 'promo-comm'] } });
    await DELETE.from(linked().HomepageShelves).where({ url: { in: ['https://promo-cap', 'https://promo-reddit'] } });
  });

  it('upserts featured channels into HomepageShelves and is idempotent', async () => {
    const db = await cds.connect.to('db');
    const first = await promoteFeatured(db);
    expect(first.upserted).toBeGreaterThan(0);
    const second = await promoteFeatured(db);
    expect(second.upserted).toBe(0); // already present → skipped on second run
    const { HomepageShelves } = linked();
    const reddit = await SELECT.one.from(HomepageShelves).where({ url: 'https://promo-reddit' });
    expect(reddit.badge).toBe('THIRD_PARTY');
    expect(reddit.shelf).not.toBe('START_HERE');
  });
});
