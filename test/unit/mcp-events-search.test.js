// test/unit/mcp-events-search.test.js
//
// Unit tests for the search_events MCP tool handler (Tier 2). Deploys the db
// model to in-memory SQLite, seeds CommunityEvents, and drives the handler
// directly with a minimal fake req — no MCP adapter, no HTTP.

import { expect, describe, it, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';
import { handleSearchEvents } from '../../srv/lib/mcp-events-search.js';

const PAST_START = '2000-01-01';
const PAST_END   = '2000-01-02';
const FUTURE     = '2999-12-31';

let CommunityEvents;

beforeAll(async () => {
  await cds.deploy(path.join(process.cwd(), 'db')).to('sqlite::memory:');
  ({ CommunityEvents } = cds.entities('com.sap.developers.ims.external'));

  const uid = () => cds.utils.uuid();
  await INSERT.into(CommunityEvents).entries([
    { ID: uid(), slug: 'ce-cap-codejam-boston', eventType: 'codejam', title: 'CAP CodeJam Boston',
      description: 'Learn CAP hands-on', region: 'AMERICAS', virtualOrInPerson: 'in-person',
      startDate: FUTURE, endDate: null, url: 'https://community.sap.com/a' },
    { ID: uid(), slug: 'ce-devtoberfest-2026', eventType: 'devtoberfest', title: 'Devtoberfest 2026',
      description: 'Community month', region: 'EMEA', virtualOrInPerson: 'virtual',
      startDate: FUTURE, endDate: null, url: 'https://community.sap.com/b' },
    { ID: uid(), slug: 'ce-teched-old', eventType: 'teched', title: 'TechEd Old',
      description: 'Past event', region: 'APJ', virtualOrInPerson: 'in-person',
      startDate: PAST_START, endDate: PAST_END, url: 'https://community.sap.com/c' },
    { ID: uid(), slug: 'ce-ongoing-group', eventType: 'usergroup', title: 'Ongoing Group',
      description: 'In progress now', region: 'EMEA', virtualOrInPerson: 'in-person',
      startDate: PAST_START, endDate: FUTURE, url: 'https://community.sap.com/d' },
    { ID: uid(), slug: 'ce-abap-codejam', eventType: 'codejam', title: 'ABAP CodeJam',
      description: 'ABAP fun', region: 'EMEA', virtualOrInPerson: 'virtual',
      startDate: FUTURE, endDate: null, url: 'https://community.sap.com/e' },
  ]);
});

afterAll(async () => {
  await cds.disconnect();
  delete cds.db;
  delete cds.model;
});

const call = (data) => handleSearchEvents({ data });
const slugs = (rows) => rows.map((r) => r.slug).sort();

describe('search_events', () => {
  it('upcomingOnly (default) excludes past events but keeps in-progress ones', async () => {
    const rows = await call({});
    // Excludes ce-teched-old (ended in 2000); includes the in-progress ce-ongoing-group.
    expect(slugs(rows)).toEqual([
      'ce-abap-codejam', 'ce-cap-codejam-boston', 'ce-devtoberfest-2026', 'ce-ongoing-group',
    ]);
  });

  it('upcomingOnly=false includes past events', async () => {
    const rows = await call({ upcomingOnly: false });
    expect(rows).toHaveLength(5);
    expect(slugs(rows)).toContain('ce-teched-old');
  });

  it('filters by eventType', async () => {
    const rows = await call({ eventType: 'codejam' });
    expect(slugs(rows)).toEqual(['ce-abap-codejam', 'ce-cap-codejam-boston']);
  });

  it('ignores an unknown eventType (no filter applied)', async () => {
    const rows = await call({ eventType: 'bogus' });
    expect(rows.length).toBe(4);
  });

  it('filters by region', async () => {
    const rows = await call({ region: 'AMERICAS' });
    expect(slugs(rows)).toEqual(['ce-cap-codejam-boston']);
  });

  it('region=VIRTUAL matches virtualOrInPerson only', async () => {
    const rows = await call({ region: 'VIRTUAL' });
    expect(slugs(rows)).toEqual(['ce-abap-codejam', 'ce-devtoberfest-2026']);
    expect(rows.every((r) => r.isVirtual)).toBe(true);
  });

  it('does a case-insensitive match on title and description', async () => {
    expect(slugs(await call({ query: 'abap' }))).toEqual(['ce-abap-codejam']);
    // 'cap' matches the CAP CodeJam title/description only.
    expect(slugs(await call({ query: 'CAP' }))).toEqual(['ce-cap-codejam-boston']);
    expect(await call({ query: 'zzzz-no-match' })).toEqual([]);
  });

  it('clamps limit to [1,50]', async () => {
    expect(await call({ limit: 1 })).toHaveLength(1);
    // limit=0 coerces to the default 20 (Number(0)||20); all upcoming still fit.
    expect((await call({ limit: 0 })).length).toBe(4);
  });

  it('returns the documented wire shape', async () => {
    const [row] = await call({ region: 'AMERICAS' });
    expect(row).toMatchObject({
      slug: 'ce-cap-codejam-boston',
      title: 'CAP CodeJam Boston',
      eventType: 'codejam',
      region: 'AMERICAS',
      isVirtual: false,
      url: 'https://community.sap.com/a',
    });
    expect(row).toHaveProperty('description');
    expect(row).toHaveProperty('startDate');
    expect(row).toHaveProperty('endDate');
  });
});
