namespace com.sap.developers.ims;

// KgCommunity — per-vertex membership in a Louvain-detected community.
//
// Not @managed on purpose: TRUNCATE + INSERT is atomic inside one db.tx;
// managed timestamps would only add write noise.
//
// @cds.autoexpose: false keeps this off AdminService automatically.
// Task 6 adds two explicit @readonly projections that expose only what
// the admin tile needs.
//
// Composite PK (communityId, vertexKey): a vertex belongs to exactly one
// community per Louvain pass, so this is a natural unique key without
// carrying a synthetic ID.
@cds.autoexpose: false
entity KgCommunity {
  key communityId : Integer;
  key vertexKey   : String(280);      // matches KG_PG_VERTICES_V.VERTEX_KEY
      vertexType  : String(16);       // 'tutorial'|'concept'|'mission'|'group'|'tag'|'product'|'category'
      slug        : String(255);      // widened to max source-entity slug width
      detectedAt  : Timestamp;
}

// KgCommunitySummaryV — LR-facing aggregate. Recomputed on every read;
// KgCommunity holds a few thousand rows at most, so this is free.
@cds.autoexpose: false
view KgCommunitySummaryV as
  select from KgCommunity {
    key communityId,
        count(*)                                                 as memberCount   : Integer,
        sum(case when vertexType = 'tutorial' then 1 else 0 end) as tutorialCount : Integer,
        max(detectedAt)                                          as detectedAt    : Timestamp,
  } group by communityId;
