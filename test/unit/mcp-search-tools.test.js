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

  it('clamps caller-controlled tags at 50 before CQN build (#1111)', async () => {
    // Anonymous MCP callers control `tags`; an unbounded {in: tags} blows
    // the HANA packet size. The handler must slice(0, 50) before the where().
    const runSpy = vi.spyOn(cds.db, 'run').mockResolvedValueOnce([]);
    const tags = Array.from({ length: 500 }, (_, i) => `tag-${i}`);

    await SearchService.send('search_tutorials', { tags });

    expect(runSpy).toHaveBeenCalledOnce();
    const cqn = runSpy.mock.calls[0][0];
    // Walk the where tree for the primaryTag {in: [...]} predicate.
    const flat = JSON.stringify(cqn?.SELECT?.where ?? []);
    const inList = cqn.SELECT.where
      .map(t => t?.list)
      .find(Array.isArray);
    expect(inList, `where did not contain an in-list: ${flat}`).toBeDefined();
    expect(inList.length).toBe(50);

    runSpy.mockRestore();
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

  it('clamps caller-controlled tags at 50 before CQN build (#1111)', async () => {
    const runSpy = vi.spyOn(cds.db, 'run').mockResolvedValueOnce([]);
    const tags = Array.from({ length: 500 }, (_, i) => `tag-${i}`);

    await SearchService.send('list_missions', { tags });

    expect(runSpy).toHaveBeenCalledOnce();
    const cqn = runSpy.mock.calls[0][0];
    const inList = cqn.SELECT.where
      .map(t => t?.list)
      .find(Array.isArray);
    expect(inList).toBeDefined();
    expect(inList.length).toBe(50);

    runSpy.mockRestore();
  });
});

describe('MCP curated tool: get_mission', () => {
  let SearchService;

  // Fixed UUIDs so the chain is readable and reproducible.
  const MISSION_ID  = 'aaaaaaaa-7777-0000-0000-000000000001';
  const PATH_ID     = 'bbbbbbbb-7777-0000-0000-000000000001';
  const TUT1_ID     = 'cccccccc-7777-0000-0000-000000000001';
  const TUT2_ID     = 'cccccccc-7777-0000-0000-000000000002';
  const TUT_INACTIVE_ID = 'cccccccc-7777-0000-0000-000000000099';
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
      // Soft-deleted tutorial wired into the same mission path — must NOT
      // surface via the anonymous MCP tool (#1111 finding #3, tombstone leak).
      { ID: TUT_INACTIVE_ID, slug: 'tut-gamma', title: 'Tutorial Gamma', status: 'INACTIVE' },
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
      // Path item pointing at the INACTIVE tutorial — item is a valid
      // TUTORIAL row, but the target tutorial is soft-deleted.
      {
        ID:          'ffffffff-7777-0000-0000-000000000099',
        path_ID:     PATH_ID,
        taskType:    'TUTORIAL',
        tutorial_ID: TUT_INACTIVE_ID,
        itemOrder:   3,
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

  it('excludes INACTIVE (soft-deleted) tutorials from the returned list (#1111)', async () => {
    const result = await SearchService.send('get_mission', { slug: 'test-mission' });
    expect(result).not.toBeNull();
    // Three path items are seeded (alpha, beta, gamma) but gamma's tutorial
    // is INACTIVE — a tombstone. Anonymous MCP callers must never see it.
    const slugs = result.tutorials.map(t => t.slug);
    expect(slugs).not.toContain('tut-gamma');
    expect(slugs).toEqual(['tut-alpha', 'tut-beta']);
  });
});

describe('MCP curated tool: get_tutorial', () => {
  let SearchService;

  const TUT_ID      = 'aaaaaaaa-8888-0000-0000-000000000001';
  const INACTIVE_ID = 'aaaaaaaa-8888-0000-0000-000000000002';
  const STEP1_ID    = 'bbbbbbbb-8888-0000-0000-000000000001';
  const STEP2_ID    = 'bbbbbbbb-8888-0000-0000-000000000002';
  const STEP3_ID    = 'bbbbbbbb-8888-0000-0000-000000000003';
  const STEP_INACTIVE_ID = 'bbbbbbbb-8888-0000-0000-000000000099';

  beforeAll(async () => {
    await cds.deploy([
      path.join(process.cwd(), 'db'),
      path.join(process.cwd(), 'srv'),
    ]).to('sqlite::memory:');
    SearchService = await cds.serve('SearchService').from('./srv/search-service');

    const { Tutorials, Steps } = cds.entities('com.sap.developers.ims');

    // Seed one ACTIVE tutorial with primaryTag.
    await INSERT.into(Tutorials).entries({
      ID:          TUT_ID,
      slug:        'test-tutorial',
      title:       'Test Tutorial',
      description: 'A test description',
      primaryTag:  'technology',
      status:      'ACTIVE',
    });

    // Seed one INACTIVE tutorial.
    await INSERT.into(Tutorials).entries({
      ID:     INACTIVE_ID,
      slug:   'inactive-tutorial',
      title:  'Inactive Tutorial',
      status: 'INACTIVE',
    });

    // Seed 3 ACTIVE steps for the ACTIVE tutorial.
    await INSERT.into(Steps).entries([
      { ID: STEP1_ID, tutorial_ID: TUT_ID, stepOrder: 1, title: 'Step One',   status: 'ACTIVE' },
      { ID: STEP2_ID, tutorial_ID: TUT_ID, stepOrder: 2, title: 'Step Two',   status: 'ACTIVE' },
      { ID: STEP3_ID, tutorial_ID: TUT_ID, stepOrder: 3, title: 'Step Three', status: 'ACTIVE' },
      { ID: STEP_INACTIVE_ID, tutorial_ID: TUT_ID, stepOrder: 4, title: 'Inactive Step', status: 'INACTIVE' },
    ]);
  });

  it('returns null for unknown slug', async () => {
    const result = await SearchService.send('get_tutorial', { slug: 'does-not-exist' });
    expect(result).toBeNull();
  });

  it('returns null for empty slug', async () => {
    const result = await SearchService.send('get_tutorial', { slug: '' });
    expect(result).toBeNull();
  });

  it('returns non-null for known ACTIVE tutorial with correct fields', async () => {
    const result = await SearchService.send('get_tutorial', { slug: 'test-tutorial' });
    expect(result).not.toBeNull();
    expect(result.slug).toBe('test-tutorial');
    expect(result.title).toBe('Test Tutorial');
    expect(result.description).toBe('A test description');
  });

  it('steps is array of length 3 ordered by number ASC with number + title', async () => {
    const result = await SearchService.send('get_tutorial', { slug: 'test-tutorial' });
    expect(result).not.toBeNull();
    expect(Array.isArray(result.steps)).toBe(true);
    expect(result.steps.length).toBe(3);
    // Ordered ascending.
    expect(result.steps[0].number).toBeLessThan(result.steps[1].number);
    expect(result.steps[1].number).toBeLessThan(result.steps[2].number);
    // Each has number and title.
    for (const s of result.steps) {
      expect(typeof s.number).toBe('number');
      expect(typeof s.title).toBe('string');
      expect(s.title.length).toBeGreaterThan(0);
    }
    // Spot-check titles.
    expect(result.steps[0].title).toBe('Step One');
    expect(result.steps[2].title).toBe('Step Three');
  });

  it('case-insensitive: TEST-TUTORIAL deep-equals test-tutorial (both non-null)', async () => {
    const lower = await SearchService.send('get_tutorial', { slug: 'test-tutorial' });
    const upper = await SearchService.send('get_tutorial', { slug: 'TEST-TUTORIAL' });
    expect(lower).not.toBeNull();
    expect(upper).not.toBeNull();
    expect(lower).toEqual(upper);
  });

  it('returns null for INACTIVE tutorial', async () => {
    const result = await SearchService.send('get_tutorial', { slug: 'inactive-tutorial' });
    expect(result).toBeNull();
  });
});
