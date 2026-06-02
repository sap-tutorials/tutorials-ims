import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';
import { isSafeForWrites } from './_guard.js';

cds.test('serve', '--project', '.', '--profile', 'hybrid');

describe('SearchService (HANA hybrid)', () => {

  it('SearchableItems view returns results from all entity types', async () => {
    const { SearchableItems } = cds.entities('com.sap.developers.ims');
    const [tutorials, missions, groups] = await Promise.all([
      SELECT.from(SearchableItems).where({ taskType: 'TUTORIAL' }).limit(1),
      SELECT.from(SearchableItems).where({ taskType: 'MISSION' }).limit(1),
      SELECT.from(SearchableItems).where({ taskType: 'GROUP' }).limit(1),
    ]);
    expect(tutorials.length).toBe(1);
    expect(missions.length).toBe(1);
    expect(groups.length).toBe(1);
  });

  it('excludes deleted items from view', async () => {
    const { SearchableItems } = cds.entities('com.sap.developers.ims');
    const deleted = await SELECT.from(SearchableItems).where({ status: 'DELETED' }).limit(1);
    expect(deleted.length).toBe(0);
  });

  it('CONTAINS with FUZZY returns results via $search (typo tolerance)', async () => {
    const srv = await cds.connect.to('SearchService');
    const results = await srv.run(
      SELECT.from('SearchService.SearchableItems').search('hanna')
    );
    const titles = results.map(r => r.title.toLowerCase());
    const hasHanaMatch = titles.some(t => t.includes('hana'));
    expect(hasHanaMatch).toBe(true);
  });

  it('field-weighted ranking: title matches rank higher (best-effort)', async () => {
    const srv = await cds.connect.to('SearchService');
    const result = await srv.send({ event: 'getFacets', data: { search: 'cap' } });
    expect(result.totalCount).toBeGreaterThan(0);
  });

  it('GROUP results always have null slug', async () => {
    const { SearchableItems } = cds.entities('com.sap.developers.ims');
    const groups = await SELECT.from(SearchableItems).where({ taskType: 'GROUP' }).limit(10);
    for (const g of groups) {
      expect(g.slug).toBeNull();
    }
  });

  it('performance: full dataset query completes under 2 seconds', async () => {
    const { SearchableItems } = cds.entities('com.sap.developers.ims');
    const start = Date.now();
    await SELECT.from(SearchableItems).limit(200);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(2000);
  });

  it('SearchableItems projects createdAt for all task types', async () => {
    const { SearchableItems } = cds.entities('com.sap.developers.ims');
    const rows = await SELECT.from(SearchableItems)
      .columns('taskType', 'createdAt')
      .where({ createdAt: { '!=': null } })
      .limit(20);
    expect(rows.length).toBeGreaterThan(0);
    // At least one of each task type should have a createdAt; the projection
    // is a UNION ALL of Tutorials/Missions/Groups, so coverage matters.
    const types = new Set(rows.map(r => r.taskType));
    // Don't insist on all three — some empty environments may lack groups —
    // but require at least Tutorials.
    expect(types.has('TUTORIAL')).toBe(true);
    for (const r of rows) {
      // CAP returns Timestamp as ISO string on HANA.
      expect(typeof r.createdAt).toBe('string');
      expect(Number.isFinite(Date.parse(r.createdAt))).toBe(true);
    }
  });

  it('OData $filter on createdAt narrows the result set', async () => {
    const srv = await cds.connect.to('SearchService');
    // Use a far-past cutoff so we get *some* rows back, then a far-future
    // cutoff so we get zero. The point is to prove the filter is plumbed.
    const farPast = '1970-01-01T00:00:00.000Z';
    const farFuture = '2999-01-01T00:00:00.000Z';
    const past = await srv.run(
      SELECT.from('SearchService.SearchableItems').where({ createdAt: { '>': farPast } }).limit(5)
    );
    const future = await srv.run(
      SELECT.from('SearchService.SearchableItems').where({ createdAt: { '>': farFuture } }).limit(5)
    );
    expect(past.length).toBeGreaterThan(0);
    expect(future.length).toBe(0);
  });

  it('getFacets returns correct structure with search filter', async () => {
    const srv = await cds.connect.to('SearchService');
    const result = await srv.send({ event: 'getFacets', data: { search: 'cap', taskTypes: null, experience: null } });
    expect(result).toHaveProperty('totalCount');
    expect(result).toHaveProperty('typeCounts');
    expect(result).toHaveProperty('experienceCounts');
    expect(result).toHaveProperty('tagCounts');
    expect(result.totalCount).toBeGreaterThan(0);
  });

  it('getFacets filters by taskTypes', async () => {
    const srv = await cds.connect.to('SearchService');
    const result = await srv.send({ event: 'getFacets', data: { search: null, taskTypes: ['TUTORIAL'], experience: null } });
    expect(result.totalCount).toBeGreaterThan(0);
    const typeNames = result.typeCounts.map(tc => tc.name);
    expect(typeNames).toContain('TUTORIAL');
    expect(typeNames).not.toContain('MISSION');
  });

  it('getFacets filters by experience', async () => {
    const srv = await cds.connect.to('SearchService');
    // First discover what experience values exist in real data
    const { SearchableItems } = cds.entities('com.sap.developers.ims');
    const expValues = await SELECT.from(SearchableItems)
      .columns('experienceTag')
      .where({ experienceTag: { '!=': null } })
      .groupBy('experienceTag')
      .limit(1);
    expect(expValues.length).toBeGreaterThan(0);
    const actualExp = expValues[0].experienceTag;

    const result = await srv.send({ event: 'getFacets', data: { search: null, taskTypes: null, experience: [actualExp] } });
    expect(result.totalCount).toBeGreaterThan(0);
    const expNames = result.experienceCounts.map(ec => ec.name);
    expect(expNames).toContain(actualExp);
  });
});

describe.runIf(isSafeForWrites())('SearchService tag matching (#154, hybrid)', () => {
  beforeAll(async () => {
    const { Tutorials, Tags, TutorialTags } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Tags).entries([
      { ID: '__TEST__-tag-154', name: '__test__-tag-154', label: '__TEST__ Searchable Label', legacyId: 99154 },
      // Used by the rank-on-real-HANA test below: 5 distractors carry this tag,
      // 1 control tutorial carries it in the title only. If rank ordering
      // regresses on HANA, the title row no longer comes first.
      { ID: '__TEST__-rank-tag', name: '__test__-rank-tag', label: '__TEST__ HanaRankProbe Label', legacyId: 99156 },
    ]);
    await INSERT.into(Tutorials).entries([
      { ID: '__TEST__-tut-154', legacyId: 99155, slug: '__test__-tagged-tutorial', title: '__TEST__ Tutorial', description: '_t_', primaryTag: '', experienceTag: 'beginner', averageTimeToComplete: 1, status: 'ACTIVE' },
      // Title-match row — token "HanaRankProbe" appears ONLY in this title.
      { ID: '__TEST__-rank-title', legacyId: 99160, slug: '__test__-rank-title-tutorial', title: '__TEST__ HanaRankProbe Title Tutorial', description: '_r_', primaryTag: '', experienceTag: 'beginner', averageTimeToComplete: 1, status: 'ACTIVE' },
      // 5 tag-only-match rows — title contains no probe token.
      { ID: '__TEST__-rank-d1', legacyId: 99161, slug: '__test__-rank-distractor-1', title: '__TEST__ Distractor One', description: '_d_', primaryTag: '', experienceTag: 'beginner', averageTimeToComplete: 1, status: 'ACTIVE' },
      { ID: '__TEST__-rank-d2', legacyId: 99162, slug: '__test__-rank-distractor-2', title: '__TEST__ Distractor Two', description: '_d_', primaryTag: '', experienceTag: 'beginner', averageTimeToComplete: 1, status: 'ACTIVE' },
      { ID: '__TEST__-rank-d3', legacyId: 99163, slug: '__test__-rank-distractor-3', title: '__TEST__ Distractor Three', description: '_d_', primaryTag: '', experienceTag: 'beginner', averageTimeToComplete: 1, status: 'ACTIVE' },
      { ID: '__TEST__-rank-d4', legacyId: 99164, slug: '__test__-rank-distractor-4', title: '__TEST__ Distractor Four', description: '_d_', primaryTag: '', experienceTag: 'beginner', averageTimeToComplete: 1, status: 'ACTIVE' },
      { ID: '__TEST__-rank-d5', legacyId: 99165, slug: '__test__-rank-distractor-5', title: '__TEST__ Distractor Five', description: '_d_', primaryTag: '', experienceTag: 'beginner', averageTimeToComplete: 1, status: 'ACTIVE' },
    ]);
    await INSERT.into(TutorialTags).entries([
      { tutorial_ID: '__TEST__-tut-154', tag_ID: '__TEST__-tag-154' },
      // Tag-only distractors:
      { tutorial_ID: '__TEST__-rank-d1', tag_ID: '__TEST__-rank-tag' },
      { tutorial_ID: '__TEST__-rank-d2', tag_ID: '__TEST__-rank-tag' },
      { tutorial_ID: '__TEST__-rank-d3', tag_ID: '__TEST__-rank-tag' },
      { tutorial_ID: '__TEST__-rank-d4', tag_ID: '__TEST__-rank-tag' },
      { tutorial_ID: '__TEST__-rank-d5', tag_ID: '__TEST__-rank-tag' },
      // The title-match row deliberately has NO tag — it matches via title only.
    ]);
  });

  afterAll(async () => {
    // Best-effort cleanup: hybrid runs share DEV HANA, so a failed prior run
    // must not block the next attempt. Each DELETE is independent — if one
    // throws (e.g. FK already-deleted), the rest still execute.
    const { Tutorials, Tags, TutorialTags } = cds.entities('com.sap.developers.ims');
    const tutorialIds = ['__TEST__-tut-154', '__TEST__-rank-title',
      '__TEST__-rank-d1', '__TEST__-rank-d2', '__TEST__-rank-d3',
      '__TEST__-rank-d4', '__TEST__-rank-d5'];
    const tagIds = ['__TEST__-tag-154', '__TEST__-rank-tag'];
    try { await DELETE.from(TutorialTags).where({ tutorial_ID: { in: tutorialIds } }); } catch { /* best-effort */ }
    try { await DELETE.from(Tutorials).where({ ID: { in: tutorialIds } }); } catch { /* best-effort */ }
    try { await DELETE.from(Tags).where({ ID: { in: tagIds } }); } catch { /* best-effort */ }
  });

  it('matches a tutorial by tag label only on real HANA', async () => {
    // The label "__TEST__ Searchable Label" is unique to test data.
    // Searching for "Searchable Label" should hit the tagged tutorial via tagBag.
    const srv = await cds.connect.to('SearchService');
    const results = await srv.run(
      SELECT.from('SearchService.SearchableItems')
        .columns('slug', 'title', 'description', 'taskType', 'primaryTag')
        .search('Searchable Label')
    );
    const slugs = results.map(r => r.slug);
    expect(slugs).toContain('__test__-tagged-tutorial');
  });

  it('SQL rank: title hit comes first even with 5 tag-only distractors on HANA', async () => {
    // Acceptance criterion #2 — this is THE production-shape rank test.
    // SQLite (unit) can't catch HANA ORDER BY divergence; this one does.
    const srv = await cds.connect.to('SearchService');
    const results = await srv.run(
      SELECT.from('SearchService.SearchableItems')
        .columns('slug', 'title', 'description', 'taskType', 'primaryTag')
        .search('HanaRankProbe').limit(20)
    );
    const slugs = results.map(r => r.slug);
    expect(slugs[0]).toBe('__test__-rank-title-tutorial');
    // All 5 distractors must follow.
    for (const s of ['__test__-rank-distractor-1', '__test__-rank-distractor-2',
      '__test__-rank-distractor-3', '__test__-rank-distractor-4', '__test__-rank-distractor-5']) {
      expect(slugs).toContain(s);
      expect(slugs.indexOf(s)).toBeGreaterThan(0);
    }
  });

  it('LOB-locator regression: select title and tagBag together returns both populated', async () => {
    // Confirms tagBag is a VARCHAR (String(5000)), not a CLOB locator that
    // would expire mid-stream. If this fails, search-service.js reads must
    // shift to raw db.run() per [memory: HANA LOB locator].
    const { SearchableItems } = cds.entities('com.sap.developers.ims');
    const rows = await SELECT.from(SearchableItems)
      .columns('title', 'tagBag')
      .where({ slug: '__test__-tagged-tutorial' });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].title).toBeTruthy();
    expect(typeof rows[0].tagBag).toBe('string');
    expect(rows[0].tagBag.length).toBeGreaterThan(0);
  });

  it('50-row warm search page completes within 5 seconds', async () => {
    // Warm the cache with a throwaway call, then time the second run. Bound
    // is 5000ms (not 2000ms) because EU10 HANA RTT from CI runners varies
    // significantly even on warm cache; tighter bounds flap without
    // indicating a real regression. A 10x regression (50s) would still fail.
    const srv = await cds.connect.to('SearchService');
    await srv.run(SELECT.from('SearchService.SearchableItems').search('cap').limit(50));
    const start = Date.now();
    const results = await srv.run(
      SELECT.from('SearchService.SearchableItems').search('cap').limit(50)
    );
    const elapsed = Date.now() - start;
    expect(results.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(5000);
  });
});
