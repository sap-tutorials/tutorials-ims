// test/unit/servable-slugs.test.js
//
// #2631 — unit tests for filterServableSlugs(): the shared content-presence
// gate that both anonymous MCP tutorial-search surfaces (SearchService
// search_tutorials and semantic_search) use to drop slugs that no longer have
// servable content in ContentCurrent (so a soft-deleted / unpublished tutorial
// never surfaces with a /tutorials/<slug> link that 404s).
//
// In-memory SQLite; the helper is dual-dialect + fail-open.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';

import { filterServableSlugs } from '../../srv/lib/servable-slugs.js';

const NS = 'com.sap.developers.ims';

describe('filterServableSlugs', () => {
  beforeAll(async () => {
    await cds.deploy([path.join(process.cwd(), 'db')]).to('sqlite::memory:');
    const { ContentCurrent } = cds.entities(NS);
    await INSERT.into(ContentCurrent).entries([
      { slug: 'live-a' },
      { slug: 'live-b' },
    ]);
  });

  afterAll(async () => {
    await cds.disconnect();
    delete cds.db;
    delete cds.model;
  });

  it('returns a Set of only the slugs present in ContentCurrent', async () => {
    const set = await filterServableSlugs(cds.db, ['live-a', 'gone-x', 'live-b']);
    expect(set instanceof Set).toBe(true);
    expect([...set].sort()).toEqual(['live-a', 'live-b']);
  });

  it('empty input returns an empty Set (no query)', async () => {
    const set = await filterServableSlugs(cds.db, []);
    expect(set instanceof Set).toBe(true);
    expect(set.size).toBe(0);
  });

  it('fails open: on a query error, keeps every input slug', async () => {
    const brokenDb = { run: async () => { throw new Error('boom'); }, kind: 'sqlite' };
    const set = await filterServableSlugs(brokenDb, ['a', 'b']);
    expect([...set].sort()).toEqual(['a', 'b']);
  });
});
