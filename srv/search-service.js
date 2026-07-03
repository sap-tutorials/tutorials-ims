import cds from '@sap/cds';

// Word-boundary normalizer used by both the search predicate AND the rank
// CASE-WHEN. Returns an SQL fragment string that pads separator characters
// with spaces so " % term % " word-boundary LIKE works on hyphenated tags
// (sap-btp--abap-...), namespaced tags (products>sap-hana), and prose
// punctuation. Single source of truth — keeps rank in lock-step with match.
function _padCol(col) {
  return `(' '||replace(replace(replace(replace(replace(replace(replace(replace(replace(`
    + `lower(coalesce(${col},'')),'-',' '),'.',' '),',',' '),'/',' '),'>',' '),`
    + `'(',' '),')',' '),':',' '),';',' ')||' ')`;
}

// Common English stopwords that show up mid-typing and would otherwise
// AND-away legitimate results ("abap in " produces tokens ['abap','in']; the
// AND-semantics below then requires every corpus row to contain a standalone
// `in` word, which drops the abap catalogue to zero). Applied AFTER the
// length ≥ 2 filter. Deliberately tight — domain terms like `js`, `vr`, `ai`
// are NOT stopwords. If ALL tokens are stopwords the query falls through to
// length-0 (same behaviour as an empty search box).
const STOPWORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'is', 'it',
  'of', 'on', 'or', 'so', 'the', 'to', 'with',
]);

// Word-boundary search across @cds.search columns (title, description, primaryTag, tagBag).
//
// Substring LIKE matches "CAP" inside "Capture/Capability"; HANA fuzzy matches
// "fortran" against 635 unrelated rows. The middle ground: pad each column with
// spaces, replace common separators with spaces too, then LIKE '% term %'.
// "Capture" stays "capture" → no match. "abap-connectivity" becomes
// "abap connectivity" → matches `% abap %`. Tokens AND together (multi-word
// search requires every token to match somewhere across the four columns) —
// but stopwords (`in`, `on`, `to`, …) are filtered first so incomplete typing
// like "abap in " doesn't drop the result set to zero.
function applyWordBoundarySearch(query, term) {
  const tokens = String(term ?? '')
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
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

// Build the per-column "any token matches" OR fragment using the same
// _padCol() normalize as the predicate. Tokens are sanitized to remove %
// and _ wildcards plus quote chars, then inlined as SQL string literals.
// Inlining (not parameter binding) is safe here because:
//   1. Tokens come from a tokenized search string with whitespace as the
//      only separator (post-toLowerCase, post-split, post-length-filter).
//   2. We strip %/_/'/\\ before quoting.
//   3. The values appear inside ' % literal % ' — they cannot break out
//      of the quoted form to inject SQL.
function _safeQuotedLiteral(tok) {
  const safe = String(tok).replace(/[%_'\\]/g, '');
  return `'% ${safe} %'`;
}

function _columnAnyTokenSQL(col, tokens) {
  return tokens
    .map((tok) => `${_padCol(col)} like ${_safeQuotedLiteral(tok)}`)
    .join(' or ');
}

// Append a `_searchRank` SQL column (CASE-WHEN sum) to req.query.SELECT.columns
// and prepend `_searchRank DESC` to req.query.SELECT.orderBy. Rank arithmetic:
//   +3 if any token matches title
//   +2 if any token matches description
//   +1 if any token matches primaryTag OR tagBag (single +1, not +2 if both)
// Tag-only rows still surface (rank ≥ 1); they sort below title hits.
//
// Crucial: this runs INSIDE the SELECT, so the DB orders by rank BEFORE
// applying $top/$skip. Title hits never get stranded on later pages.
function attachSearchRank(query, tokens) {
  if (!Array.isArray(tokens) || tokens.length === 0) return;

  const titleOr = _columnAnyTokenSQL('title', tokens);
  const descOr  = _columnAnyTokenSQL('description', tokens);
  const primOr  = _columnAnyTokenSQL('primaryTag', tokens);
  const tagOr   = _columnAnyTokenSQL('tagBag', tokens);

  const rankSQL =
    `(case when (${titleOr}) then 3 else 0 end ` +
    `+ case when (${descOr}) then 2 else 0 end ` +
    `+ case when (${primOr} or ${tagOr}) then 1 else 0 end)`;

  // cds.parse.expr is the documented public API for parsing an SQL expression
  // string into a CSN xpr node. Replaces an earlier synthetic-template-literal
  // trick (cds.ql.expr with a hand-rolled `raw` array) which depended on an
  // undocumented internal contract.
  const rankExpr = cds.parse.expr(rankSQL);

  const sel = query.SELECT;
  // No explicit projection (e.g. internal srv.run(SELECT.from(...).search(...))
  // hands us a SELECT with no .columns) → CAP will auto-expand to all view
  // elements. Adding our own column entry here breaks that auto-expansion on
  // a UNION-ALL view (cqn4sql can't resolve a literal '*' ref against
  // SearchableItems' element set). Internal callers don't need ranking, so
  // skip — the after('READ') hook's _searchRank-strip becomes a no-op.
  if (!sel.columns) return;
  sel.columns.push({ ...rankExpr, as: '_searchRank' });

  // Prepend rank-DESC so any preexisting orderBy becomes the tiebreaker.
  sel.orderBy = [{ ref: ['_searchRank'], sort: 'desc' }, ...(sel.orderBy ?? [])];
}

export default class SearchService extends cds.ApplicationService {
  init() {
    const { SearchableItems } = this.entities;

    // bodyText is projected so $search can match indexed full-text content,
    // but we strip it from responses to keep OData payloads small and avoid
    // exposing the raw indexed text. (Using @cds.api.ignore would also hide
    // it from the runtime $search element list, defeating the purpose.)
    // _searchRank is the ranking column appended in before('READ'); it must
    // never leak to OData consumers or to internal srv.run callers (Joule).
    this.after('READ', SearchableItems, (results) => {
      // Count round-trips return a Number, not an array — return early.
      if (results == null || typeof results === 'number') return;
      const rows = Array.isArray(results) ? results : [results];
      for (const r of rows) {
        if (!r) continue;
        if ('bodyText' in r) delete r.bodyText;
        if ('_searchRank' in r) delete r._searchRank;
      }
    });

    // Replace CAP's built-in $search emission with the word-boundary clause
    // above. CAP would otherwise emit either FUZZY (cds.hana.fuzzy: number) or
    // LOWER(...) LIKE '%term%' (cds.hana.fuzzy: false) — both produce too much
    // noise on short acronyms (CAP/ABAP/HANA).
    this.before('READ', SearchableItems, (req) => {
      const sel = req.query?.SELECT;
      // MANDATORY count guard — ranking is meaningless on COUNT(*) round-trips,
      // and adding _searchRank to a count projection can change semantics.
      if (!sel || sel.count) return;
      const search = sel.search;
      if (!Array.isArray(search) || !search.length) return;
      const phrase = search.map((e) => e?.val ?? '').join(' ').trim();
      if (!phrase) return;
      delete sel.search;
      const tokens = applyWordBoundarySearch(req.query, phrase);
      attachSearchRank(req.query, tokens);
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
