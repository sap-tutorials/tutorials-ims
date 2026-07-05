// db/knowledge-graph-isolation.cds
//
// KgIsolation — sidecar flag for concepts/tutorials in small
// weakly-connected components.
//
// Populated nightly by srv/jobs/kg-wcc-job.js at 04:07 UTC. One row
// per flagged vertex; (vertexType, slug) is the composite PK.
// componentId is the union-find root vertex-key (opaque; not stable
// across runs — the union-find picks whatever root emerges from the
// merge order). componentSize is the count of vertices in that
// component. Rows only exist when componentSize is <=
// KG_WCC_ISOLATION_THRESHOLD (default 1).
//
// NOT `managed` — nightly TRUNCATE+INSERT overwrite semantics; the
// `managed` timestamps/user columns would be trigger noise on a
// rebuilt-from-scratch aggregate. `computedAt` captures the batch
// time.
//
// @cds.autoexpose: false — never a top-level OData collection;
// reached only through the `isolated` virtual on Concepts / Tutorials
// projections (see srv/knowledge-graph-service.cds and
// srv/admin-service.cds).
//
// Slug widths chosen so a single String(255) column covers both
// vertex-types:
//   Concepts.slug  = String(80)
//   Tutorials.slug = String(255)
// componentId is a KG_PG_VERTICES_V.VERTEX_KEY (NVARCHAR(280)) —
// see db/src/views/KG_PG_VERTICES_V.hdbview line 6-9 for the sizing
// derivation.
//
// Spec:  docs/superpowers/specs/2026-07-04-918-kg-wcc-isolation-design.md
// Issue: #918

namespace com.sap.developers.ims;

@cds.autoexpose: false
entity KgIsolation {
  key vertexType    : String(16);   // 'concept' | 'tutorial'
  key slug          : String(255);
      componentId   : String(280);
      componentSize : Integer;
      computedAt    : Timestamp;
}
