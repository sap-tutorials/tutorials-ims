using { com.sap.developers.ims as ims } from '../db/schema';
using from '../db/views';

type FacetCount {
  name  : String;
  count : Integer;
};

type FacetResult {
  totalCount       : Integer;
  typeCounts       : many FacetCount;
  experienceCounts : many FacetCount;
  tagCounts        : many FacetCount;
};

@path: '/search'
@requires: 'any'
// NB: MUST be `@protocol: ['odata', 'graphql', 'mcp']`, not the `@graphql` /
// `@mcp` single-protocol shortcuts. Either shortcut alone REPLACES the default
// OData mount, leaving `/search/SearchableItems` 404 while the other protocol
// still resolves. `@graphql` regression cost 218 unit tests on 2026-07-05
// (misattributed to HCQL, reverted in #1004). `@mcp` added by #912.
@protocol: ['odata', 'graphql', 'mcp']
service SearchService {

  // Per-element fuzziness threshold: entity-level @Search.fuzzinessThreshold
  // is silently ignored — HANA falls back to global cds.hana.fuzzy (0.7),
  // which let "CAP" match 1042 unrelated rows and "fortran" match 635.
  // Description gets a tighter 0.9 because long-text fuzzy matches generate
  // disproportionate noise; title/primaryTag/tagBag use 0.85.
  // bodyText stays out of @cds.search because LOW-ranked body matches
  // were drowning HIGH-ranked title hits (HANA ranking is relative-within-row,
  // not a cross-row multiplier).
  // bodyText AND tagBag are excluded from the projection so they don't bloat
  // OData payloads — both are ~LargeString-shaped, scanned by predicate only.
  // @cds.search references both because the runtime hook builds the predicate
  // against the underlying view, not the projection element list.
  @readonly
  @cds.search: { title, description, primaryTag, tagBag }
  @cds.query.limit: 200
  entity SearchableItems as projection on ims.SearchableItems {
    @Search.fuzzinessThreshold: 0.85
    @Search.ranking: #HIGH
    title,
    @Search.fuzzinessThreshold: 0.9
    @Search.ranking: #MEDIUM
    description,
    @Search.fuzzinessThreshold: 0.85
    @Search.ranking: #LOW
    primaryTag,
    @Search.fuzzinessThreshold: 0.85
    @Search.ranking: #LOW
    tagBag,
    // #945: composite rank exposed to callers that $select it. Populated in
    // SearchService.after('READ') from the internal _searchRank column when
    // it is present (which is when the request came in with a $search phrase).
    // Virtual → no DB column, no impact on non-search reads.
    virtual null as searchScore : Decimal(8,4),
    *
  } excluding { bodyText, tagBag };

  @readonly
  @cds.query.limit: 200
  entity Tags as projection on ims.Tags;

  function getFacets(
    search     : String,
    taskTypes  : array of String,
    experience : array of String
  ) returns FacetResult;

  /**
   * Fuzzy full-text search across published tutorials. Returns slug + title +
   * short snippet + tag list. Use this to discover tutorials by topic.
   *
   * @param query      Search terms (natural language accepted; word-boundary
   *                   matching handles hyphenated tags and prose punctuation).
   * @param tags       Optional exact-match filter on tutorial primary tag.
   * @param experience Optional experience-level filter: 'beginner',
   *                   'intermediate', 'advanced'.
   * @param limit      Max results (default 10, hard max 100).
   * @returns          Array of tutorial matches ordered by relevance score.
   */
  function search_tutorials(
    query      : String,
    tags       : many String,
    experience : String,
    limit      : Integer
  ) returns array of {
    slug    : String;
    title   : String;
    snippet : String;
    tags    : many String;
  };

  /**
   * List published missions with the number of tutorials in each. Anonymous
   * — the same missions the /missions/ page shows.
   *
   * @param tags  Optional tag filter (returns only missions whose primaryTag
   *              matches any of the supplied values).
   * @param limit Max results (default 20, hard max 50).
   * @returns     Missions ordered by title.
   */
  function list_missions(
    tags  : many String,
    limit : Integer
  ) returns array of {
    slug          : String;
    title         : String;
    description   : String;
    tutorialCount : Integer;
  };

  /**
   * Fetch a mission by slug, with its ordered tutorial list. Returns null if
   * no published mission matches. Slug is case-insensitive.
   *
   * @param slug Mission slug (lowercased server-side).
   * @returns    Mission with ordered tutorial list, or null if not found.
   */
  function get_mission(slug : String) returns {
    slug        : String;
    title       : String;
    description : String;
    tutorials   : array of {
      slug  : String;
      title : String;
      order : Integer;
    };
  };

  /**
   * Fetch tutorial metadata and ordered step list by slug.
   * Returns null for unknown slugs, empty slugs, or INACTIVE tutorials.
   *
   * @param slug  Tutorial slug (case-insensitive).
   * @returns     Tutorial metadata with step list, or null if not found.
   */
  function get_tutorial(slug : String) returns {
    slug        : String;
    title       : String;
    description : String;
    tags        : many String;
    steps       : array of { number : Integer; title : String; };
  };
}
