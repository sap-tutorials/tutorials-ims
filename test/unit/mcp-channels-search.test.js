// test/unit/mcp-channels-search.test.js
//
// Unit tests for the search_channels MCP tool handler (Tier 2). Deploys the db
// model to in-memory SQLite, seeds Channels, and drives the handler directly
// with a minimal fake req — no MCP adapter, no HTTP.

import { expect, describe, it, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';
import { handleSearchChannels } from '../../srv/lib/mcp-channels-search.js';

let Channels;

beforeAll(async () => {
  await cds.deploy(path.join(process.cwd(), 'db')).to('sqlite::memory:');
  ({ Channels } = cds.entities('com.sap.developers.ims'));

  const uid = () => cds.utils.uuid();
  await INSERT.into(Channels).entries([
    { ID: uid(), sourceId: 'ch-001', slug: 'sap-developers-yt', name: 'SAP Developers',
      url: 'https://youtube.com/@sapdevs', purpose: 'Official SAP developer videos',
      category: 'Video', platform: 'YouTube', isSapOwned: true, ownerType: 'SAP_Official',
      ownerName: 'SAP', status: 'Active', focusAreas: ['CAP', 'BTP'], tags: ['cap', 'video'],
      isPublished: true, linkStatus: 'OK' },
    { ID: uid(), sourceId: 'ch-002', slug: 'community-cap-blog', name: 'Community CAP Blog',
      url: 'https://community.sap.com/cap', purpose: 'Community posts about CAP',
      category: 'Blog', platform: 'Blog', isSapOwned: false, ownerType: 'Community_Member',
      ownerName: 'A Member', status: 'Active', focusAreas: ['CAP'], tags: ['cap', 'blog'],
      isPublished: true, linkStatus: 'OK' },
    { ID: uid(), sourceId: 'ch-003', slug: 'abap-podcast', name: 'ABAP Podcast',
      url: 'https://example.com/abap-podcast', purpose: 'Talking about ABAP Cloud',
      category: 'Podcast', platform: 'Podcast', isSapOwned: false, ownerType: 'Third_party_Media',
      ownerName: 'Podcasters', status: 'Active', focusAreas: ['ABAP'], tags: ['abap', 'audio'],
      isPublished: true, linkStatus: 'OK' },
    // Unpublished — must never surface.
    { ID: uid(), sourceId: 'ch-004', slug: 'draft-channel', name: 'Draft Channel',
      url: 'https://example.com/draft', purpose: 'Not yet published',
      category: 'Blog', platform: 'Blog', isSapOwned: true, status: 'Active',
      focusAreas: [], tags: [], isPublished: false, linkStatus: 'OK' },
    // Published but BROKEN link — must be filtered out.
    { ID: uid(), sourceId: 'ch-005', slug: 'dead-blog', name: 'Dead Blog',
      url: 'https://example.com/dead', purpose: 'Link rotted',
      category: 'Blog', platform: 'Blog', isSapOwned: false, status: 'Active',
      focusAreas: [], tags: ['blog'], isPublished: true, linkStatus: 'BROKEN' },
    // Published, healthy override wins over a BROKEN base linkStatus.
    { ID: uid(), sourceId: 'ch-006', slug: 'revived-blog', name: 'Revived Blog',
      url: 'https://example.com/revived', purpose: 'Marked healthy by an editor',
      category: 'Blog', platform: 'Blog', isSapOwned: false, status: 'Active',
      focusAreas: [], tags: ['blog'], isPublished: true, linkStatus: 'BROKEN',
      linkStatusOverride: 'OK' },
  ]);
});

afterAll(async () => {
  await cds.disconnect();
  delete cds.db;
  delete cds.model;
});

const call = (data) => handleSearchChannels({ data });
const slugs = (rows) => rows.map((r) => r.slug).sort();

describe('search_channels', () => {
  it('returns only published, non-broken channels by default', async () => {
    const rows = await call({});
    // Excludes draft-channel (unpublished) and dead-blog (BROKEN); revived-blog
    // is kept because linkStatusOverride='OK' wins.
    expect(slugs(rows)).toEqual([
      'abap-podcast', 'community-cap-blog', 'revived-blog', 'sap-developers-yt',
    ]);
  });

  it('filters by category (exact match)', async () => {
    expect(slugs(await call({ category: 'Video' }))).toEqual(['sap-developers-yt']);
    expect(slugs(await call({ category: 'Podcast' }))).toEqual(['abap-podcast']);
  });

  it('filters by platform (exact match)', async () => {
    expect(slugs(await call({ platform: 'Blog' }))).toEqual(['community-cap-blog', 'revived-blog']);
  });

  it('ownerScope=sap returns only SAP-owned channels', async () => {
    const rows = await call({ ownerScope: 'sap' });
    expect(slugs(rows)).toEqual(['sap-developers-yt']);
    expect(rows.every((r) => r.isSapOwned)).toBe(true);
  });

  it('ownerScope=community returns only non-SAP channels', async () => {
    const rows = await call({ ownerScope: 'community' });
    expect(slugs(rows)).toEqual(['abap-podcast', 'community-cap-blog', 'revived-blog']);
    expect(rows.every((r) => !r.isSapOwned)).toBe(true);
  });

  it('ignores an unknown ownerScope (treated as all)', async () => {
    expect((await call({ ownerScope: 'bogus' })).length).toBe(4);
  });

  it('does a case-insensitive match on name, purpose, and tags', async () => {
    // 'abap' matches the ABAP Podcast name/purpose/tags.
    expect(slugs(await call({ query: 'abap' }))).toEqual(['abap-podcast']);
    // 'cap' matches the SAP Developers focus? No — query matches name/purpose/tags:
    // sap-developers-yt (tag 'cap'), community-cap-blog (name/purpose/tag).
    expect(slugs(await call({ query: 'CAP' }))).toEqual(['community-cap-blog', 'sap-developers-yt']);
    expect(await call({ query: 'zzzz-no-match' })).toEqual([]);
  });

  it('clamps limit to [1,50]', async () => {
    expect(await call({ limit: 1 })).toHaveLength(1);
    // clampLimit: an explicit 0 clamps to the floor of 1 (only undefined/null
    // fall back to the default). Canonical shared validator, PR3 #2270.
    expect((await call({ limit: 0 })).length).toBe(1);
    // omitted → default 20; all 4 rows fit.
    expect((await call({})).length).toBe(4);
  });

  it('returns the documented wire shape', async () => {
    const [row] = await call({ category: 'Video' });
    expect(row).toMatchObject({
      name: 'SAP Developers',
      url: 'https://youtube.com/@sapdevs',
      category: 'Video',
      platform: 'YouTube',
      isSapOwned: true,
      slug: 'sap-developers-yt',
    });
    expect(row.focusAreas).toEqual(['CAP', 'BTP']);
    expect(row.tags).toEqual(['cap', 'video']);
    expect(row).toHaveProperty('purpose');
    expect(row).toHaveProperty('ownerType');
    expect(row).toHaveProperty('ownerName');
    expect(row).toHaveProperty('status');
    // Internal/curation columns must never leak into the wire shape.
    expect(row).not.toHaveProperty('sourceId');
    expect(row).not.toHaveProperty('linkStatus');
    expect(row).not.toHaveProperty('isPublished');
  });
});
