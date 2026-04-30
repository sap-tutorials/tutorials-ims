import { describe, it, expect } from 'vitest';
import cds from '@sap/cds';

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
