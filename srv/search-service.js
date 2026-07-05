import cds from '@sap/cds';
import { computeKgSignal, buildKgRankFragment } from './lib/search-kg-signal.js';
import { resolveEmbeddingSettings } from './lib/chat-settings-resolver.js';

const LOG = cds.log('search-service');

// #945: Cache ChatSettings for 30s to avoid a DB round-trip per search request.
// The flag rarely changes and 30s propagation is acceptable — same as other
// singleton-flag caches in the tree (see runtime-config/*-settings.js).
let _chatSettingsCache = null;
let _chatSettingsExpiresAt = 0;
const CHAT_SETTINGS_TTL_MS = 30_000;

async function readChatSettings() {
  const now = Date.now();
  if (_chatSettingsCache && now < _chatSettingsExpiresAt) return _chatSettingsCache;
  try {
    const { ChatSettings } = cds.entities('com.sap.developers.ims');
    const row = await SELECT.one.from(ChatSettings);
    _chatSettingsCache = row || {};
    _chatSettingsExpiresAt = now + CHAT_SETTINGS_TTL_MS;
    return _chatSettingsCache;
  } catch (err) {
    LOG.warn('readChatSettings failed', err.message);
    // Cache the empty result briefly so a failing DB doesn't flood retries.
    _chatSettingsCache = {};
    _chatSettingsExpiresAt = now + 5_000;
    return _chatSettingsCache;
  }
}

/** Reset internal caches — test-only. */
export function _resetForTest() {
  _chatSettingsCache = null;
  _chatSettingsExpiresAt = 0;
}

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
function attachSearchRank(query, tokens, kgFragment = '') {
  if (!Array.isArray(tokens) || tokens.length === 0) return;

  const titleOr = _columnAnyTokenSQL('title', tokens);
  const descOr  = _columnAnyTokenSQL('description', tokens);
  const primOr  = _columnAnyTokenSQL('primaryTag', tokens);
  const tagOr   = _columnAnyTokenSQL('tagBag', tokens);

  // #945: kgFragment is the ` + 2.00 * (case slug when 'x' then 0.8100 ... end)`
  // string produced by buildKgRankFragment(). Empty string when the KG signal
  // is disabled / empty / timed-out — in that case the rank SQL is byte-identical
  // to the pre-#945 formula. Slugs in the fragment are pre-validated against
  // /^[a-z0-9-]+$/ so no quoting drama on the string-concat boundary.
  const rankSQL =
    `(case when (${titleOr}) then 3 else 0 end ` +
    `+ case when (${descOr}) then 2 else 0 end ` +
    `+ case when (${primOr} or ${tagOr}) then 1 else 0 end` +
    (kgFragment ? ` ${kgFragment}` : '') +
    `)`;

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
    // _searchRank is the ranking column appended in before('READ'); it is
    // internal, never exposed to OData consumers. The client-visible field
    // is `searchScore` (virtual on the projection), populated here from
    // _searchRank before the internal name is stripped (#945).
    this.after('READ', SearchableItems, (results) => {
      // Count round-trips return a Number, not an array — return early.
      if (results == null || typeof results === 'number') return;
      const rows = Array.isArray(results) ? results : [results];
      for (const r of rows) {
        if (!r) continue;
        if ('bodyText' in r) delete r.bodyText;
        if ('_searchRank' in r) {
          // Copy the composite rank into the virtual `searchScore` field so
          // OData clients can $select it. Non-search reads never set
          // _searchRank, so searchScore stays null / unset.
          if (r._searchRank !== null && r._searchRank !== undefined) {
            r.searchScore = Number(Number(r._searchRank).toFixed(4));
          }
          delete r._searchRank;
        }
      }
    });

    // Replace CAP's built-in $search emission with the word-boundary clause
    // above. CAP would otherwise emit either FUZZY (cds.hana.fuzzy: number) or
    // LOWER(...) LIKE '%term%' (cds.hana.fuzzy: false) — both produce too much
    // noise on short acronyms (CAP/ABAP/HANA).
    //
    // #945: The rank formula extends to `fuzzy + KG_WEIGHT * kg_score` via
    // the KG signal helper. Signal is cached (in-process, 5-min TTL) so
    // repeated searches for the same phrase (paging, Joule follow-up in the
    // same turn) pay the embed cost once.
    this.before('READ', SearchableItems, async (req) => {
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

      // Fetch flag once per request. Failure to read ChatSettings → skip KG
      // silently and use fuzzy-only rank (same behaviour as flag=false).
      let kgFragment = '';
      try {
        const settings = await readChatSettings();
        if (settings?.searchKgRerankEnabled) {
          const { model: embeddingModel } = await resolveEmbeddingSettings();
          const signal = await computeKgSignal({
            phrase,
            db: cds.db,
            embeddingModel,
            enabled: true,
          });
          kgFragment = buildKgRankFragment(signal);
        }
      } catch (err) {
        LOG.warn('KG signal computation failed; falling back to fuzzy-only rank', err.message);
      }

      attachSearchRank(req.query, tokens, kgFragment);
    });

    /**
     * MCP curated tool: fuzzy full-text search across published tutorials.
     *
     * @param query      Search terms (word-boundary matching, stopword-filtered).
     * @param tags       Optional exact-match filter on tutorial primary tag.
     * @param experience Optional experience-level filter.
     * @param limit      Max results (default 10, hard max 100).
     * @returns          Array of { slug, title, snippet, tags } ordered by relevance.
     */
    this.on('search_tutorials', async (req) => {
      const { query, tags, experience } = req.data;
      const limit = Math.min(Math.max(req.data.limit ?? 10, 1), 100);

      const { SearchableItems } = this.entities;
      const q = SELECT.from(SearchableItems)
        .columns('slug', 'title', 'description', 'primaryTag', 'experienceTag')
        .limit(limit)
        .where({ taskType: 'TUTORIAL' });

      // Apply word-boundary search across title/description/primaryTag/tagBag.
      // Reuses the same predicate builder as the OData $search handler so the
      // match semantics are identical (stopword-filtered, separator-normalised).
      // attachSearchRank appends _searchRank to SELECT.columns and prepends
      // _searchRank DESC to ORDER BY so results are ranked by relevance before
      // the DB applies the LIMIT — consistent with the OData $search path.
      if (query) {
        const tokens = applyWordBoundarySearch(q, query);
        attachSearchRank(q, tokens);
      }

      if (tags?.length) q.where({ primaryTag: { in: tags } });
      if (experience)   q.where({ experienceTag: experience });

      const rows = await cds.db.run(q);
      return rows.map(r => ({
        slug:    (r.slug ?? '').toLowerCase(),
        title:   r.title ?? '',
        snippet: (r.description ?? '').slice(0, 240),
        tags:    r.primaryTag ? [r.primaryTag] : [],
      }));
    });

    /**
     * MCP curated tool: list published missions with tutorial counts.
     *
     * @param tags  Optional primaryTag filter (any-match).
     * @param limit Max results (default 20, hard max 50).
     * @returns     Array of { slug, title, description, tutorialCount } ordered by title.
     */
    this.on('list_missions', async (req) => {
      const { tags } = req.data;
      const limit = Math.min(Math.max(req.data.limit ?? 20, 1), 50);
      const { Missions, CompletionPaths, CompletionPathItems } = cds.entities('com.sap.developers.ims');

      const mq = SELECT.from(Missions)
        .columns('ID', 'slug', 'title', 'description')
        .where({ published: true })
        .orderBy('title asc')
        .limit(limit);

      if (tags?.length) mq.where({ primaryTag: { in: tags } });

      const missions = await cds.db.run(mq);
      if (!missions.length) return [];

      // Two-query approach: avoid fragile CQL aggregate JOIN on SQLite.
      // Fetch CompletionPathItems counts grouped by mission_ID via
      // CompletionPaths (which carries the mission_ID foreign key).
      const missionIds = missions.map(m => m.ID);
      const paths = await cds.db.run(
        SELECT.from(CompletionPaths)
          .columns('ID', 'mission_ID')
          .where({ mission_ID: { in: missionIds } })
      );
      const pathIds = paths.map(p => p.ID);
      const countByMission = new Map(missionIds.map(id => [id, 0]));
      if (pathIds.length) {
        const items = await cds.db.run(
          SELECT.from(CompletionPathItems)
            .columns('path_ID')
            .where({ path_ID: { in: pathIds }, taskType: 'TUTORIAL' })
        );
        for (const path of paths) {
          const n = items.filter(i => i.path_ID === path.ID).length;
          countByMission.set(path.mission_ID, (countByMission.get(path.mission_ID) ?? 0) + n);
        }
      }

      return missions.map(m => ({
        slug:          (m.slug ?? '').toLowerCase(),
        title:         m.title ?? '',
        description:   m.description ?? '',
        tutorialCount: countByMission.get(m.ID) ?? 0,
      }));
    });

    /**
     * MCP curated tool: fetch a published mission by slug with ordered tutorial list.
     *
     * @param slug Mission slug (lowercased server-side; case-insensitive).
     * @returns    { slug, title, description, tutorials: [{ slug, title, order }] }
     *             or null when no published mission matches.
     */
    this.on('get_mission', async (req) => {
      const slug = (req.data.slug ?? '').toLowerCase();
      if (!slug) return null;

      const { Missions, CompletionPaths, CompletionPathItems } = cds.entities('com.sap.developers.ims');

      const mission = await SELECT.one.from(Missions)
        .columns('ID', 'slug', 'title', 'description')
        .where({ slug, published: true });
      if (!mission) return null;

      // Two-query pattern (mirrors list_missions): fetch paths for this mission,
      // then items in those paths filtered to TUTORIAL taskType only.
      const paths = await cds.db.run(
        SELECT.from(CompletionPaths)
          .columns('ID')
          .where({ mission_ID: mission.ID })
      );
      const pathIds = paths.map(p => p.ID);

      let tutorials = [];
      if (pathIds.length) {
        const items = await cds.db.run(
          SELECT.from(CompletionPathItems)
            .columns('tutorial_ID', 'itemOrder')
            .where({ path_ID: { in: pathIds }, taskType: 'TUTORIAL' })
            .orderBy('itemOrder asc')
        );
        if (items.length) {
          const tutorialIds = items.map(i => i.tutorial_ID).filter(Boolean);
          if (tutorialIds.length) {
            const { Tutorials } = cds.entities('com.sap.developers.ims');
            const tutRows = await cds.db.run(
              SELECT.from(Tutorials)
                .columns('ID', 'slug', 'title')
                .where({ ID: { in: tutorialIds } })
            );
            const tutMap = new Map(tutRows.map(t => [t.ID, t]));
            tutorials = items
              .map(i => {
                const tut = tutMap.get(i.tutorial_ID);
                if (!tut) return null;
                return {
                  slug:  (tut.slug ?? '').toLowerCase(),
                  title: tut.title ?? '',
                  order: i.itemOrder ?? 0,
                };
              })
              .filter(Boolean);
          }
        }
      }

      return {
        slug:        (mission.slug ?? '').toLowerCase(),
        title:       mission.title ?? '',
        description: mission.description ?? '',
        tutorials,
      };
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
