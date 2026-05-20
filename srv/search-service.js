import cds from '@sap/cds';

export default class SearchService extends cds.ApplicationService {
  init() {
    const { SearchableItems } = this.entities;

    this.on('getFacets', async (req) => {
      const { search, taskTypes, experience } = req.data;

      function applyFilters(query) {
        if (search) query.search(search);
        if (taskTypes?.length) query.where({ taskType: { in: taskTypes } });
        if (experience?.length) query.where({ experienceTag: { in: experience } });
        return query;
      }

      const [typeCounts, experienceCounts, tagCounts, totalResult] = await Promise.all([
        applyFilters(SELECT.from(SearchableItems).columns('taskType as name', 'count(*) as count'))
          .groupBy('taskType'),
        applyFilters(SELECT.from(SearchableItems).columns('experienceTag as name', 'count(*) as count'))
          .where({ experienceTag: { '!=': null } })
          .groupBy('experienceTag'),
        applyFilters(SELECT.from(SearchableItems).columns('primaryTag as name', 'count(*) as count'))
          .where({ primaryTag: { '!=': null } })
          .groupBy('primaryTag')
          .orderBy('count desc')
          .limit(20),
        applyFilters(SELECT.one.from(SearchableItems).columns('count(*) as count')),
      ]);

      return {
        totalCount: totalResult?.count ?? 0,
        typeCounts: typeCounts ?? [],
        experienceCounts: experienceCounts ?? [],
        tagCounts: tagCounts ?? [],
      };
    });

    return super.init();
  }
}
