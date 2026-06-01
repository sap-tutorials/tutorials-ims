import cds from '@sap/cds';

// Word-boundary search across @cds.search columns (title, description, primaryTag, tagBag).
//
// Substring LIKE matches "CAP" inside "Capture/Capability"; HANA fuzzy matches
// "fortran" against 635 unrelated rows. The middle ground: pad each column with
// spaces, replace common separators with spaces too, then LIKE '% term %'.
// "Capture" stays "capture" → no match. "abap-connectivity" becomes
// "abap connectivity" → matches `% abap %`. Tokens AND together (multi-word
// search requires every token to match somewhere across the four columns).
function applyWordBoundarySearch(query, term) {
  const tokens = String(term ?? '')
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .filter((t) => t.length >= 2);
  if (!tokens.length) return tokens;

  for (const tok of tokens) {
    const safe = tok.replace(/[%_]/g, '');
    if (!safe) continue;
    const padded = `% ${safe} %`;
    // The replace chain works on both HANA and SQLite — ANSI replace + lower +
    // coalesce. Separators chosen to cover hyphenated tags (sap-btp--abap-…),
    // namespaced tags (products>sap-hana), and prose punctuation.
    query.where`(
      (' '||replace(replace(replace(replace(replace(replace(replace(replace(replace(lower(coalesce(title,'')),'-',' '),'.',' '),',',' '),'/',' '),'>',' '),'(',' '),')',' '),':',' '),';',' ')||' ') like ${padded}
      or (' '||replace(replace(replace(replace(replace(replace(replace(replace(replace(lower(coalesce(description,'')),'-',' '),'.',' '),',',' '),'/',' '),'>',' '),'(',' '),')',' '),':',' '),';',' ')||' ') like ${padded}
      or (' '||replace(replace(replace(replace(replace(replace(replace(replace(replace(lower(coalesce(primaryTag,'')),'-',' '),'.',' '),',',' '),'/',' '),'>',' '),'(',' '),')',' '),':',' '),';',' ')||' ') like ${padded}
      or (' '||replace(replace(replace(replace(replace(replace(replace(replace(replace(lower(coalesce(tagBag,'')),'-',' '),'.',' '),',',' '),'/',' '),'>',' '),'(',' '),')',' '),':',' '),';',' ')||' ') like ${padded}
    )`;
  }
  return tokens;
}

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

    // Replace CAP's built-in $search emission with the word-boundary clause
    // above. CAP would otherwise emit either FUZZY (cds.hana.fuzzy: number) or
    // LOWER(...) LIKE '%term%' (cds.hana.fuzzy: false) — both produce too much
    // noise on short acronyms (CAP/ABAP/HANA).
    this.before('READ', SearchableItems, (req) => {
      const sel = req.query?.SELECT;
      const search = sel?.search;
      if (!Array.isArray(search) || !search.length) return;
      const phrase = search.map((e) => e?.val ?? '').join(' ').trim();
      if (!phrase) return;
      delete sel.search;
      const tokens = applyWordBoundarySearch(req.query, phrase);
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
      const tokens = search ? applyWordBoundarySearch(q, search) : [];
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
