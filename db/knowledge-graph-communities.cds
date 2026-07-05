namespace com.sap.developers.ims;

// Missions is defined in db/schema.cds; needed for the LEFT JOIN in
// KgCommunitySummaryV that materializes alreadyPromoted (#986).
using { com.sap.developers.ims.Missions } from './schema';

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
//
// communityFingerprint (#985): SHA-256 hex over the sorted tutorial-typed
// member slug list for this row's communityId. Denormalized — every row
// for a given communityId carries the same value — because it lets the
// KgCommunitySummaryV LEFT JOIN Missions.sourceKgCommunityFingerprint
// evaluate at the DB layer, which is what makes #986's default filter
// on alreadyPromoted actually work. Computed once per Louvain pass by
// srv/jobs/kg-communities-job.js using the shared helper at
// srv/lib/kg-community-fingerprint.js.
@cds.autoexpose: false
entity KgCommunity {
  key communityId          : Integer;
  key vertexKey            : String(280);      // matches KG_PG_VERTICES_V.VERTEX_KEY
      vertexType           : String(16);       // 'tutorial'|'concept'|'mission'|'group'|'tag'|'product'|'category'
      slug                 : String(255);      // widened to max source-entity slug width
      detectedAt           : Timestamp;
      communityFingerprint : String(64);       // #985 — see block comment above.
}

// KgCommunitySummaryV — LR-facing aggregate. Recomputed on every read;
// KgCommunity holds a few thousand rows at most, so this is free.
//
// alreadyPromoted (#986) is materialized here via LEFT JOIN Missions on
// communityFingerprint. That moves the filter — set by the LR's
// SelectionPresentationVariant to hide already-promoted communities —
// off a Node-populated virtual column (where CAP evaluated it against
// NULL at the DB layer and dropped every row) and onto a real column.
//
// count(distinct kc.vertexKey) instead of count(*) so the LEFT JOIN to
// Missions doesn't inflate member counts on communities that produced
// more than one draft Mission (in practice this is rare, but a curator
// can promote-again with a different slug after tweaking, and we don't
// want that to double the memberCount reading). Same reasoning for the
// count(distinct ... case) on tutorialCount.
@cds.autoexpose: false
view KgCommunitySummaryV as
  select from KgCommunity as kc
  left join Missions as m on m.sourceKgCommunityFingerprint = kc.communityFingerprint
  {
    key kc.communityId,
        count(distinct kc.vertexKey)                                               as memberCount          : Integer,
        count(distinct case when kc.vertexType = 'tutorial' then kc.vertexKey end) as tutorialCount        : Integer,
        max(kc.detectedAt)                                                         as detectedAt           : Timestamp,
        max(kc.communityFingerprint)                                               as communityFingerprint : String(64),
        case when count(m.ID) > 0 then true else false end                         as alreadyPromoted      : Boolean
  } group by kc.communityId;
