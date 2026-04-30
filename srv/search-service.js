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
      if (!req.query.SELECT.where) {
        req.query.SELECT.where = [{ ref: ['ID'] }, 'in', { val: ids }];
      } else {
        req.query.SELECT.where = [
          '(', ...req.query.SELECT.where, ')',
          'or',
          '(', { ref: ['ID'] }, 'in', { val: ids }, ')'
        ];
      }
    });

    this.on('getFacets', async (req) => {
      const { search, taskTypes, experience } = req.data;
      const { SearchableItems: View } = cds.entities('com.sap.developers.ims');

      // Build WHERE conditions using safe CQL parameter binding
      function buildWhere(search, taskTypes, experience) {
        const conditions = [];
        if (search) {
          const pattern = `%${search}%`;
          conditions.push({ or: [
            { title: { like: pattern } },
            { description: { like: pattern } },
            { primaryTag: { like: pattern } },
          ]});
        }
        if (taskTypes?.length) {
          conditions.push({ taskType: { in: taskTypes } });
        }
        if (experience?.length) {
          conditions.push({ experienceTag: { in: experience } });
        }
        return conditions.length ? { and: conditions } : {};
      }

      const where = buildWhere(search, taskTypes, experience);

      const [typeCounts, experienceCounts, tagCounts, totalResult] = await Promise.all([
        SELECT.from(View)
          .columns('taskType as name', 'count(*) as count')
          .where(where)
          .groupBy('taskType'),
        SELECT.from(View)
          .columns('experienceTag as name', 'count(*) as count')
          .where({ ...where, experienceTag: { '!=': null } })
          .groupBy('experienceTag'),
        SELECT.from(View)
          .columns('primaryTag as name', 'count(*) as count')
          .where({ ...where, primaryTag: { '!=': null } })
          .groupBy('primaryTag')
          .orderBy('count desc')
          .limit(20),
        SELECT.one.from(View)
          .columns('count(*) as count')
          .where(where),
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
