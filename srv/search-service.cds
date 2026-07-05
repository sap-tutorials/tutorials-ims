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
@graphql
@mcp
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
}
