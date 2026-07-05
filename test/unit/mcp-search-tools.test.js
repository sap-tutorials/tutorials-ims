import { expect, describe, it, beforeAll, afterAll, vi } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';

describe('MCP curated tool: search_tutorials', () => {
  let SearchService;

  beforeAll(async () => {
    await cds.deploy([
      path.join(process.cwd(), 'db'),
      path.join(process.cwd(), 'srv'),
    ]).to('sqlite::memory:');
    SearchService = await cds.serve('SearchService').from('./srv/search-service');
  });

  afterAll(async () => {
    await cds.disconnect();
  });

  it('returns bounded result array with slug + title + snippet + tags', async () => {
    const results = await SearchService.send('search_tutorials', { query: 'test', limit: 5 });
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeLessThanOrEqual(5);
    for (const r of results) {
      expect(r).toHaveProperty('slug');
      expect(r).toHaveProperty('title');
      expect(r).toHaveProperty('snippet');
      expect(Array.isArray(r.tags)).toBe(true);
    }
  });

  it('clamps limit at 100 even when caller passes more', async () => {
    const results = await SearchService.send('search_tutorials', { query: 'a', limit: 999 });
    expect(results.length).toBeLessThanOrEqual(100);
  });

  it('does not read req.user (anonymous tier)', async () => {
    // Call without any auth context — must not throw.
    const results = await SearchService.send('search_tutorials', { query: 'x' });
    expect(Array.isArray(results)).toBe(true);
  });

  it('orders results by relevance score (_searchRank DESC) when query is provided', async () => {
    // Spy on cds.db.run to capture the CQN that reaches the database.
    const runSpy = vi.spyOn(cds.db, 'run').mockResolvedValueOnce([]);

    await SearchService.send('search_tutorials', { query: 'hana cloud', limit: 5 });

    expect(runSpy).toHaveBeenCalledOnce();
    const cqn = runSpy.mock.calls[0][0];

    // attachSearchRank prepends { ref: ['_searchRank'], sort: 'desc' } to orderBy
    const orderBy = cqn?.SELECT?.orderBy;
    expect(Array.isArray(orderBy)).toBe(true);
    expect(orderBy.length).toBeGreaterThan(0);

    const firstOrder = orderBy[0];
    expect(firstOrder).toMatchObject({ ref: ['_searchRank'], sort: 'desc' });

    // Also assert that _searchRank column was appended to SELECT.columns
    const columns = cqn?.SELECT?.columns;
    expect(Array.isArray(columns)).toBe(true);
    const rankCol = columns.find((c) => c.as === '_searchRank');
    expect(rankCol).toBeDefined();

    runSpy.mockRestore();
  });
});

describe('MCP curated tool: list_missions', () => {
  let SearchService;
  beforeAll(async () => {
    await cds.deploy([
      path.join(process.cwd(), 'db'),
      path.join(process.cwd(), 'srv'),
    ]).to('sqlite::memory:');
    SearchService = await cds.serve('SearchService').from('./srv/search-service');
  });

  it('returns bounded mission list with tutorial counts', async () => {
    const results = await SearchService.send('list_missions', { limit: 5 });
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeLessThanOrEqual(5);
    for (const m of results) {
      expect(m).toHaveProperty('slug');
      expect(m).toHaveProperty('title');
      expect(m).toHaveProperty('tutorialCount');
      expect(typeof m.tutorialCount).toBe('number');
    }
  });

  it('clamps limit at 50', async () => {
    const results = await SearchService.send('list_missions', { limit: 999 });
    expect(results.length).toBeLessThanOrEqual(50);
  });
});

describe('MCP curated tool: get_mission', () => {
  let SearchService;

  // Fixed UUIDs so the chain is readable and reproducible.
  const MISSION_ID  = 'aaaaaaaa-7777-0000-0000-000000000001';
  const PATH_ID     = 'bbbbbbbb-7777-0000-0000-000000000001';
  const TUT1_ID     = 'cccccccc-7777-0000-0000-000000000001';
  const TUT2_ID     = 'cccccccc-7777-0000-0000-000000000002';
  const UNPUB_ID    = 'dddddddd-7777-0000-0000-000000000001';
  const PATH2_ID    = 'eeeeeeee-7777-0000-0000-000000000001';

  beforeAll(async () => {
    await cds.deploy([
      path.join(process.cwd(), 'db'),
      path.join(process.cwd(), 'srv'),
    ]).to('sqlite::memory:');
    SearchService = await cds.serve('SearchService').from('./srv/search-service');

    const { Missions, CompletionPaths, CompletionPathItems, Tutorials } =
      cds.entities('com.sap.developers.ims');

    // Seed two tutorials referenced by path items.
    await INSERT.into(Tutorials).entries([
      { ID: TUT1_ID, slug: 'tut-alpha', title: 'Tutorial Alpha', status: 'ACTIVE' },
      { ID: TUT2_ID, slug: 'tut-beta',  title: 'Tutorial Beta',  status: 'ACTIVE' },
    ]);

    // Seed one published mission with slug 'test-mission'.
    await INSERT.into(Missions).entries({
      ID:          MISSION_ID,
      slug:        'test-mission',
      title:       'Test Mission',
      description: 'A test mission',
      published:   true,
    });

    // Seed one unpublished mission to verify the published filter.
    await INSERT.into(Missions).entries({
      ID:          UNPUB_ID,
      slug:        'unpublished-mission',
      title:       'Unpublished Mission',
      description: 'Should never surface',
      published:   false,
    });

    // Seed a CompletionPath linked to the published mission.
    await INSERT.into(CompletionPaths).entries({
      ID:         PATH_ID,
      mission_ID: MISSION_ID,
      slug:       'test-mission-path',
      name:       'Test Path',
    });

    // Seed a CompletionPath linked to the unpublished mission (should be unreachable).
    await INSERT.into(CompletionPaths).entries({
      ID:         PATH2_ID,
      mission_ID: UNPUB_ID,
      slug:       'unpublished-mission-path',
      name:       'Unpublished Path',
    });

    // Seed two TUTORIAL items in ascending itemOrder.
    await INSERT.into(CompletionPathItems).entries([
      {
        ID:          'ffffffff-7777-0000-0000-000000000001',
        path_ID:     PATH_ID,
        taskType:    'TUTORIAL',
        tutorial_ID: TUT1_ID,
        itemOrder:   1,
      },
      {
        ID:          'ffffffff-7777-0000-0000-000000000002',
        path_ID:     PATH_ID,
        taskType:    'TUTORIAL',
        tutorial_ID: TUT2_ID,
        itemOrder:   2,
      },
    ]);
  });

  it('returns null for unknown slug', async () => {
    const result = await SearchService.send('get_mission', { slug: 'does-not-exist' });
    expect(result).toBeNull();
  });

  it('returns null for empty slug', async () => {
    const result = await SearchService.send('get_mission', { slug: '' });
    expect(result).toBeNull();
  });

  it('returns null for unpublished mission', async () => {
    // published: false missions must not surface to the MCP tool.
    const result = await SearchService.send('get_mission', { slug: 'unpublished-mission' });
    expect(result).toBeNull();
  });

  it('lowercases slug before lookup', async () => {
    // Global memory-fact: tutorial slugs are lowercase canonical.
    // A mixed-case query must still resolve against the seeded row.
    const lower = await SearchService.send('get_mission', { slug: 'test-mission' });
    const upper = await SearchService.send('get_mission', { slug: 'TEST-MISSION' });
    // Both must be non-null and deeply equal — not a vacuous null === null.
    expect(lower).not.toBeNull();
    expect(upper).not.toBeNull();
    expect(lower).toEqual(upper);
  });

  it('returns mission with tutorials array when mission exists', async () => {
    const result = await SearchService.send('get_mission', { slug: 'test-mission' });

    // Unconditional: with seeded data the result must be non-null.
    expect(result).not.toBeNull();
    expect(result.slug).toBe('test-mission');
    expect(result.title).toBe('Test Mission');
    expect(result.description).toBe('A test mission');
    expect(Array.isArray(result.tutorials)).toBe(true);

    // Two TUTORIAL items seeded — both must appear.
    expect(result.tutorials.length).toBe(2);

    // Order ascending by itemOrder.
    expect(result.tutorials[0].order).toBeLessThan(result.tutorials[1].order);

    // Each tutorial entry has non-empty slug + title.
    for (const t of result.tutorials) {
      expect(typeof t.slug).toBe('string');
      expect(t.slug.length).toBeGreaterThan(0);
      expect(typeof t.title).toBe('string');
      expect(t.title.length).toBeGreaterThan(0);
      expect(typeof t.order).toBe('number');
    }

    // Spot-check the slugs returned for each tutorial item.
    expect(result.tutorials[0].slug).toBe('tut-alpha');
    expect(result.tutorials[1].slug).toBe('tut-beta');
  });
});
