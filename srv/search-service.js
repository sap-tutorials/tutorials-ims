import cds from '@sap/cds';

export default class SearchService extends cds.ApplicationService {
  init() {
    const { SearchableItems } = this.entities;

    this.before('READ', SearchableItems, async (req) => {
      const searchTokens = req.query?.SELECT?.search;
      if (!searchTokens?.length) return;
      const search = searchTokens.map(t => t.val ?? t).join(' ');

      const { TutorialTags, Tags } = cds.entities('com.sap.developers.ims');
      const tagMatches = await SELECT.from(TutorialTags)
        .columns('tutorial_ID')
        .where({
          tag_ID: { in: SELECT('ID').from(Tags).where`name like ${'%' + search + '%'}` }
        });

      if (tagMatches.length === 0) return;

      const ids = tagMatches.map(r => r.tutorial_ID);
      const pattern = `%${search}%`;
      req.query.SELECT.search = [];
      req.query.where `(title like ${pattern} or description like ${pattern} or primaryTag like ${pattern} or ID in ${ids})`;
    });

    this.on('getFacets', async (req) => {
      const { search, taskTypes, experience } = req.data;
      const { SearchableItems: View } = cds.entities('com.sap.developers.ims');

      function applyFilters(query, search, taskTypes, experience) {
        if (search) {
          const pattern = `%${search}%`;
          query.where`(title like ${pattern} or description like ${pattern} or primaryTag like ${pattern})`;
        }
        if (taskTypes?.length) {
          query.where({ taskType: { in: taskTypes } });
        }
        if (experience?.length) {
          query.where({ experienceTag: { in: experience } });
        }
        return query;
      }

      const [typeCounts, experienceCounts, tagCounts, totalResult] = await Promise.all([
        applyFilters(
          SELECT.from(View).columns('taskType as name', 'count(*) as count'),
          search, taskTypes, experience
        ).groupBy('taskType'),
        applyFilters(
          SELECT.from(View).columns('experienceTag as name', 'count(*) as count'),
          search, taskTypes, experience
        ).where({ experienceTag: { '!=': null } }).groupBy('experienceTag'),
        applyFilters(
          SELECT.from(View).columns('primaryTag as name', 'count(*) as count'),
          search, taskTypes, experience
        ).where({ primaryTag: { '!=': null } }).groupBy('primaryTag').orderBy('count desc').limit(20),
        applyFilters(
          SELECT.one.from(View).columns('count(*) as count'),
          search, taskTypes, experience
        ),
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
