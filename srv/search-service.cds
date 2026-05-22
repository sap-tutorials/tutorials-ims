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

  // Fuzziness 0.85 (tightened from 0.7) avoids short-query noise like
  // "CAP" matching "escape"/"capture". bodyText dropped from @cds.search
  // because LOW-ranked body matches were drowning HIGH-ranked title hits
  // (HANA ranking is relative-within-row, not a cross-row multiplier).
  @readonly
  @Search.fuzzinessThreshold: 0.85
  @cds.search: { title, description, primaryTag }
  entity SearchableItems as projection on ims.SearchableItems {
    @Search.ranking: #HIGH
    title,
    @Search.ranking: #MEDIUM
    description,
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
