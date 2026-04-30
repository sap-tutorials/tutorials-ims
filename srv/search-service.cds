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

  @readonly
  @Search.fuzzinessThreshold: 0.7
  entity SearchableItems as projection on ims.SearchableItems {
    @Search.ranking: #HIGH
    title,
    @Search.ranking: #MEDIUM
    description,
    @Search.ranking: #LOW
    primaryTag,
    *
  };

  @readonly
  entity Tags as projection on ims.Tags;

  function getFacets(
    search     : String,
    taskTypes  : array of String,
    experience : array of String
  ) returns FacetResult;
}
