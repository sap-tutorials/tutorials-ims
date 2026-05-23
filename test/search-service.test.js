import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

describe('SearchService', () => {

  beforeAll(async () => {
    const { Tutorials, Missions, Groups, Tags, TutorialTags, TutorialBodyText } = cds.entities('com.sap.developers.ims');

    await INSERT.into(Tutorials).entries([
      { ID: 'search-t1', legacyId: 90001, slug: 'hana-cloud-setup', title: 'SAP HANA Cloud Setup', description: 'Learn to configure HANA Cloud', primaryTag: 'SAP HANA Cloud', experienceTag: 'beginner', averageTimeToComplete: 30, status: 'ACTIVE' },
      { ID: 'search-t2', legacyId: 90002, slug: 'cap-getting-started', title: 'Getting Started with CAP', description: 'Build your first CAP app', primaryTag: 'SAP Cloud Application Programming Model', experienceTag: 'beginner', averageTimeToComplete: 45, status: 'ACTIVE' },
      { ID: 'search-t3', legacyId: 90003, slug: 'fiori-elements', title: 'SAP Fiori Elements', description: 'Create Fiori apps', primaryTag: 'SAP Fiori', experienceTag: 'intermediate', averageTimeToComplete: 60, status: 'ACTIVE' },
      { ID: 'search-t4', legacyId: 90004, slug: 'inactive-tutorial', title: 'Old Tutorial', description: 'Should not appear', primaryTag: 'Legacy', experienceTag: 'beginner', averageTimeToComplete: 10, status: 'INACTIVE' },
    ]);

    await INSERT.into(Missions).entries([
      { ID: 'search-m1', legacyId: 90101, slug: 'full-stack-mission', title: 'Full-Stack CAP Application', description: 'Build end-to-end', primaryTag: 'SAP Cloud Application Programming Model', experienceTag: 'intermediate', averageTimeToComplete: 180, status: 'ACTIVE' },
    ]);

    await INSERT.into(Groups).entries([
      { ID: 'search-g1', legacyId: 90201, title: 'HANA Basics Group', description: 'HANA fundamentals', primaryTag: 'SAP HANA Cloud', experienceTag: 'beginner', averageTimeToComplete: 90, status: 'ACTIVE' },
    ]);

    await INSERT.into(Tags).entries([
      { ID: 'search-tag1', name: 'HANA Cloud', legacyId: 80001 },
      { ID: 'search-tag2', name: 'CAP Node.js', legacyId: 80002 },
    ]);

    await INSERT.into(TutorialTags).entries([
      { tutorial_ID: 'search-t1', tag_ID: 'search-tag1' },
      { tutorial_ID: 'search-t2', tag_ID: 'search-tag2' },
    ]);

    await INSERT.into(TutorialBodyText).entries([
      { slug: 'hana-cloud-setup', bodyText: 'Open the BTP cockpit and provision a HANA Cloud instance. Configure the firewall ipallowlist before connecting.' },
      { slug: 'cap-getting-started', bodyText: 'Run cds init to scaffold a project. Add an entity to db schema and a service projection.' },
    ]);
  });

  describe('SearchableItems', () => {
    it('returns results from all three entity types', async () => {
      const { data } = await project.get('/search/SearchableItems');
      const types = [...new Set(data.value.map(i => i.taskType))];
      expect(types).toContain('TUTORIAL');
      expect(types).toContain('MISSION');
      expect(types).toContain('GROUP');
    });

    it('excludes inactive items', async () => {
      const { data } = await project.get('/search/SearchableItems');
      const titles = data.value.map(i => i.title);
      expect(titles).not.toContain('Old Tutorial');
    });

    it('GROUP results have null slug', async () => {
      const { data } = await project.get('/search/SearchableItems?$filter=taskType eq \'GROUP\'');
      expect(data.value.length).toBeGreaterThan(0);
      for (const item of data.value) {
        expect(item.slug).toBeNull();
      }
    });

    it('filters by taskType', async () => {
      const { data } = await project.get('/search/SearchableItems?$filter=taskType eq \'TUTORIAL\'');
      for (const item of data.value) {
        expect(item.taskType).toBe('TUTORIAL');
      }
    });

    it('filters by experienceTag', async () => {
      const { data } = await project.get('/search/SearchableItems?$filter=experienceTag eq \'beginner\'');
      for (const item of data.value) {
        expect(item.experienceTag).toBe('beginner');
      }
    });

    it('supports $top/$skip pagination', async () => {
      const { data } = await project.get('/search/SearchableItems?$top=2&$skip=0&$count=true');
      expect(data.value.length).toBeLessThanOrEqual(2);
      expect(data['@odata.count']).toBeGreaterThan(0);
    });

    it('returns all items when no $search is provided', async () => {
      const { data } = await project.get('/search/SearchableItems?$count=true');
      expect(data['@odata.count']).toBeGreaterThanOrEqual(5);
    });

    it('$search filters by title substring', async () => {
      const { data } = await project.get('/search/SearchableItems?$search=Fiori');
      const slugs = data.value.map(i => i.slug);
      expect(slugs).toContain('fiori-elements');
    });

    it('$search does NOT match body text (bodyText excluded from @cds.search)', async () => {
      // 'ipallowlist' appears only in the hana-cloud-setup body text, not in any title or description.
      // bodyText is deliberately excluded from @cds.search in srv/search-service.cds:21
      // (comment there: '"CAP" matching "escape"/"capture". bodyText dropped from @cds.search')
      // to prevent false positives from substring matches in long body text.
      const { data } = await project.get('/search/SearchableItems?$search=ipallowlist');
      const slugs = data.value.map(i => i.slug);
      expect(slugs).not.toContain('hana-cloud-setup');
    });

    it('does not expose bodyText in the OData response', async () => {
      const { data } = await project.get('/search/SearchableItems?$filter=slug eq \'hana-cloud-setup\'');
      expect(data.value.length).toBeGreaterThan(0);
      for (const item of data.value) {
        expect(item.bodyText).toBeUndefined();
      }
    });
  });

  describe('Tags', () => {
    it('returns available tags', async () => {
      const { data } = await project.get('/search/Tags');
      expect(data.value.length).toBeGreaterThan(0);
      expect(data.value[0]).toHaveProperty('name');
    });
  });

  describe('getFacets', () => {
    it('returns aggregation structure without filters', async () => {
      const srv = await cds.connect.to('SearchService');
      const result = await srv.send({ event: 'getFacets', data: {} });
      expect(result).toHaveProperty('totalCount');
      expect(result).toHaveProperty('typeCounts');
      expect(result).toHaveProperty('experienceCounts');
      expect(result).toHaveProperty('tagCounts');
      expect(result.totalCount).toBeGreaterThanOrEqual(5);
    });

    it('returns correct type counts including TUTORIAL, MISSION, GROUP', async () => {
      const srv = await cds.connect.to('SearchService');
      const result = await srv.send({ event: 'getFacets', data: {} });
      expect(Array.isArray(result.typeCounts)).toBe(true);
      const typeNames = result.typeCounts.map(tc => tc.name);
      expect(typeNames).toContain('TUTORIAL');
      expect(typeNames).toContain('MISSION');
      expect(typeNames).toContain('GROUP');
    });

    it('narrows results with taskTypes filter', async () => {
      const srv = await cds.connect.to('SearchService');
      const result = await srv.send({ event: 'getFacets', data: { taskTypes: ['TUTORIAL'] } });
      expect(result.totalCount).toBeGreaterThan(0);
      expect(result.typeCounts.every(t => t.name === 'TUTORIAL')).toBe(true);
    });

    it('returns zero totalCount for no-match search', async () => {
      const srv = await cds.connect.to('SearchService');
      const result = await srv.send({ event: 'getFacets', data: { search: 'xyznonexistent999' } });
      expect(result.totalCount).toBe(0);
    });
  });

  describe('Security', () => {
    it('does not require authentication', async () => {
      const { status } = await project.get('/search/SearchableItems',
        { validateStatus: () => true });
      expect(status).toBe(200);
    });
  });
});
