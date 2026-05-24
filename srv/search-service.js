import cds from '@sap/cds';

export default class SearchService extends cds.ApplicationService {
  init() {
    const { SearchableItems } = this.entities;

    // bodyText is projected so $search can match indexed full-text content,
    // but we strip it from responses to keep OData payloads small and avoid
    // exposing the raw indexed text. (Using @cds.api.ignore would also hide
    // it from the runtime $search element list, defeating the purpose.)
    this.after('READ', SearchableItems, (results) => {
      if (!results) return;
      const rows = Array.isArray(results) ? results : [results];
      for (const r of rows) {
        if (r && 'bodyText' in r) delete r.bodyText;
      }
    });

    this.on('getFacets', async (req) => {
      const { search, taskTypes, experience } = req.data;

      // CAP's .search() composed with .groupBy() over a UNION ALL view emits
      // SQL that returns empty groups on HANA (chip counts came back as 0
      // while the same .search() against the entity returned 500+ rows).
      // Fetch the filtered set once and bucket in Node — the result set is
      // already capped by the search predicate and we only need three small
      // dimensions, so this is cheap and avoids the broken composition.
      let q = SELECT.from(SearchableItems).columns('taskType', 'experienceTag', 'primaryTag');
      if (search) q.search(search);
      if (taskTypes?.length) q.where({ taskType: { in: taskTypes } });
      if (experience?.length) q.where({ experienceTag: { in: experience } });
      const rows = await q;

      const bump = (map, key) => {
        if (!key) return;
        map.set(key, (map.get(key) ?? 0) + 1);
      };
      const typeMap = new Map();
      const expMap = new Map();
      const tagMap = new Map();
      for (const r of rows) {
        bump(typeMap, r.taskType);
        bump(expMap, r.experienceTag);
        bump(tagMap, r.primaryTag);
      }

      const toArr = (m) => [...m.entries()].map(([name, count]) => ({ name, count }));
      const tagCounts = toArr(tagMap).sort((a, b) => b.count - a.count).slice(0, 20);

      return {
        totalCount: rows.length,
        typeCounts: toArr(typeMap),
        experienceCounts: toArr(expMap),
        tagCounts,
      };
    });

    return super.init();
  }
}
