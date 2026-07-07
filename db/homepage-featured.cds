// db/homepage-featured.cds — issue #1032 (featured missions carousel).
// Editorial rows: HomepageFeaturedTopics. Materialized selection: FeaturedTopicsSnapshot.
// Spec: docs/superpowers/specs/2026-07-06-1032-featured-missions-carousel-design.md §5.

namespace com.sap.developers.ims;

using { managed, cuid } from '@sap/cds/common';
using { com.sap.developers.ims.Concepts } from './knowledge-graph';

@assert.unique.concept: [concept]
entity HomepageFeaturedTopics : cuid, managed {
  concept        : Association to Concepts @mandatory;
  displayTitle   : String(80);
  sortOrder      : Integer default 100;
  validFrom      : Timestamp;
  validUntil     : Timestamp;
  missionSlugs   : array of String(255);
  isActive       : Boolean default true;
  notes          : String(500);
}

@cds.autoexpose: false
entity FeaturedTopicsSnapshot {
  key slotOrder    : Integer;
      source       : String(10);
      conceptSlug  : String(80);
      displayTitle : String(120);
      missionSlugs : array of String(255);
      computedAt   : Timestamp;
}
