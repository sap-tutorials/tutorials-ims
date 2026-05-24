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
service SearchService {

  // Per-element fuzziness threshold: entity-level @Search.fuzzinessThreshold
  // is silently ignored — HANA falls back to global cds.hana.fuzzy (0.7),
  // which let "CAP" match 1042 unrelated rows and "fortran" match 635.
  // Description gets a tighter 0.9 because long-text fuzzy matches generate
  // disproportionate noise; title/primaryTag use 0.85.
  // bodyText stays out of @cds.search because LOW-ranked body matches
  // were drowning HIGH-ranked title hits (HANA ranking is relative-within-row,
  // not a cross-row multiplier).
  @readonly
  @cds.search: { title, description, primaryTag }
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
    *
  } excluding { bodyText };

  @readonly
  entity Tags as projection on ims.Tags;

  function getFacets(
    search     : String,
    taskTypes  : array of String,
    experience : array of String
  ) returns FacetResult;
}
