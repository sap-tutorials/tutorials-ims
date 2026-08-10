namespace com.sap.developers.ims;

// Stable-slug <-> current-Louvain-fingerprint mapping for the /topics/ front door.
// Nightly TRUNCATE+INSERT by srv/jobs/kg-topic-clusters-job.js. NOT managed
// (rebuilt-from-scratch aggregate; computedAt captures batch time).
@cds.autoexpose: false
entity TopicClusters {
  key slug                 : String(80);   // stable, derived from label once, never changes
      label                : String(120);  // current LLM label (from KgCommunityLabel)
      curatedLabel         : String(120);  // optional admin override; wins over label at render
      rationale            : String(500);  // LLM rationale (from KgCommunityLabel), carried forward nightly
      fingerprint          : String(64);   // CURRENT Louvain fingerprint this slug points to
      previousFingerprints : String(2000); // newline-joined history of prior fingerprints
      status               : String(20)  default 'ACTIVE';  // ACTIVE | RETIRED
      hidden               : Boolean      default false;     // admin can hide junk clusters from gallery
      memberCount          : Integer;
      tutorialCount        : Integer;
      memberSlugsBlob      : String(5000);   // newline-joined tutorial slugs persisted for next-night Jaccard matching (C1 fix)
      computedAt           : Timestamp;
}
