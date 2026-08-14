// db/homepage-top-tutorials.cds — issue #1782 (time-fenced Top Tutorials ranking).
// Nightly-materialized top-N tutorials by raw completion count, per rolling
// window (90/180/360 days). Mirrors the FeaturedTopicsSnapshot derived-table
// convention (no cuid/managed; computedAt captures batch time; kept off OData).
// Spec: docs/superpowers/specs/2026-08-14-top-tutorials-ranking-design.md

namespace com.sap.developers.ims;

@cds.autoexpose: false
entity TopTutorialsSnapshot {
  key windowDays  : Integer;      // 90 | 180 | 360
  key rank        : Integer;      // 1..8
      slug        : String(255);  // matches Tutorials.slug width
      completions : Integer;      // raw count in window
      computedAt  : Timestamp;
}
