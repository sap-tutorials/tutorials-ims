// srv/knowledge-graph-service.cds
// Knowledge-graph query + curation surface — PR 5 of issue #381.
//
// Service-level @requires is `authenticated-user`: the read surface (the
// three @readonly entity projections + the three named functions) is open to
// any signed-in developer because it backs the public neighborhood rail. The
// admin actions below carry an additional @requires : 'KnowledgeGraph.Admin'
// so curation (mergeConcepts, vetoConcept, vetoEdge, runSparql,
// triggerGraphRebuild) requires the dedicated scope from xs-security.json.
//
// Phase 1 ships `neighborhood`; `pathBetween` and `conceptsForUser` declare
// the Phase 2 contract so clients can compile against a stable surface, but
// the runtime returns empty results.

using { com.sap.developers.ims as ims } from '../db/knowledge-graph';

@requires : 'authenticated-user'
service KnowledgeGraphService @(path : '/graph') {

  // ─── Projections (curation introspection + admin tooling) ─────────────
  // `Concepts` is writable so admins can inline-edit `name` + `description`
  // from the Fiori Elements UI (PR 6 of #381). Field-level
  // @Common.FieldControl: #ReadOnly in app/admin-annotations.cds plus the
  // before('UPDATE') guard in srv/knowledge-graph-service.js restrict the
  // write surface to those two fields. ConceptEdges and TutorialConceptLinks
  // remain read-only — status flips on edges happen via the `vetoEdge` action.
  //
  // `embedding` (LargeBinary) is the per-concept centroid vector used for
  // similarity-merge during extraction. It is internal-only — written by
  // srv/jobs/extract-concepts-job.js via cds.entities() (db-level entity)
  // and read by srv/lib/kg-concept-loader.js via raw SQL. Exposing it
  // through OData breaks the FE V4 List Report at /admin-ui/#concepts:
  // V4AnalyticsPropertyHelper throws "Unsupported arguments" during
  // column-prep when it sees Edm.Binary properties on a writable entity,
  // killing the table bind before any GET Concepts?$top=... fires.
  // Excluding it here mirrors the established pattern for TutorialEmbedding
  // (never projected) and the project's "LargeBinary stays off OData unless
  // tagged @Core.MediaType" convention.
  @cds.redirection.target
  entity Concepts                       as projection on ims.Concepts excluding { embedding };
  @readonly entity ConceptEdges         as projection on ims.ConceptEdges;
  @readonly entity TutorialConceptLinks as projection on ims.TutorialConceptLinks;

  /**
   * Publishable subset of Concepts — the projection the Hugo build script
   * (PR 2/3) reads via /build/concepts. Excludes never-published rows,
   * unpublished (publishedAt cleared by admin), VETOED, and MERGED.
   */
  @readonly
  entity PublishedConcepts as projection on ims.Concepts {
    ID, slug, name, description, publishedAt, publishedBy, status
  } where publishedAt is not null and status = 'ACTIVE';

  // ─── Type definitions ──────────────────────────────────────────────────
  type ConceptRef {
    slug        : String;
    name        : String;
    description : String;
    published   : Boolean;  // Phase 3 publication gate; true when /concepts/<slug>/ exists.
  }
  type TutorialRef {
    slug   : String;
    title  : String;
    weight : Decimal(3, 2);
    reason : String;
  }
  type TutorialInfo {
    slug  : String;
    title : String;
  }
  // OtherResource — chassis-level wire shape for the "other resources"
  // sidebar rail (issue #447 Phase 4). PR-1 wires the empty contract; PR-2
  // (learning journeys) populates it; 4.3-4.6 widen `type` to news/videos/
  // samples/discovery/resources. The shape unions the columns each
  // sub-phase needs — fields not relevant to a given type are left null.
  type OtherResource {
    type          : String(20);   // 'learning-journey' | future sub-phase types
    slug          : String;
    title         : String;
    url           : String;
    level         : String;
    durationHours : Decimal(5, 2);
    authorName    : String;             // blog-post only (Phase 4.2)
    postedAt      : Timestamp;          // blog-post only (Phase 4.2)
    overlapCount  : Integer;
  }
  type NeighborhoodResult {
    tutorial        : TutorialInfo;
    graphVersion    : String;
    teaches         : array of ConceptRef;
    prerequisitesOf : array of TutorialRef;
    sharedConcepts  : array of TutorialRef;
    whatToLearnNext : array of TutorialRef;
    otherResources  : array of OtherResource;  // Phase 4 chassis (#447); empty in PR-1, populated in PR-2.
  }
  type ConceptCoverage {
    learned : array of ConceptRef;
    partial : array of ConceptRef;
  }
  type SparqlResult {
    columns : array of String;
    // Each element is a JSON-stringified array of column-value strings,
    // mirroring AnalyticsService.runSelectQuery's wire shape — CDS doesn't
    // support `array of array of String` in type definitions.
    rows    : array of String;
  }
  type RebuildResult {
    graphVersion    : String;
    tripleCount     : Integer;
    durationMs      : Integer;
    predicateCounts : array of {
      predicate : String;
      count     : Integer;
    };
  }
  type MergePreview {
    loserId       : UUID;
    loserSlug     : String;
    loserName     : String;
    canonicalId   : UUID;
    canonicalSlug : String;
    canonicalName : String;
    similarity    : Decimal(4, 3);  // 0.000–1.000
  }

  // ─── Phase 1 + Phase 2 typed query functions (open to authenticated) ──
  function neighborhood(slug : String)                        returns NeighborhoodResult;
  function pathBetween(fromSlug : String, toSlug : String)    returns array of String;     // Phase 2 stub
  function conceptsForUser(userId : String)                   returns ConceptCoverage;     // Phase 2 stub

  // ─── Admin curation actions (require KnowledgeGraph.Admin scope) ──────
  @requires : 'KnowledgeGraph.Admin'
  action runSparql(query : String) returns SparqlResult;

  @requires : 'KnowledgeGraph.Admin'
  action mergeConcepts(loser : UUID, canonical : UUID);

  // previewMerges — dry-run wrapper around the consolidator's findNearDuplicates.
  // No writes; returns the candidate (loser, canonical, similarity) triples that
  // a forced consolidation pass would collapse. Used by the admin "Preview merges"
  // toolbar button before a curator decides whether to invoke mergeConcepts.
  @requires : 'KnowledgeGraph.Admin'
  action previewMerges() returns array of MergePreview;

  @requires : 'KnowledgeGraph.Admin'
  action vetoConcept(conceptId : UUID);

  @requires : 'KnowledgeGraph.Admin'
  action vetoEdge(edgeId : UUID);

  @requires : 'KnowledgeGraph.Admin'
  action triggerGraphRebuild() returns RebuildResult;
}

// publishConcept / unpublishConcept are BOUND actions on Concepts so Fiori
// Elements V4 picks up the row context (clicked-row key) when an admin invokes
// them from the OP toolbar or LR row — no parameter dialog. Pattern mirrors
// AdminService.Tutorials.rebuildContent (srv/admin-service.cds:626-630) and
// AdminService.Users.clearKhorosLink (srv/admin-service.cds:22-25).
extend entity KnowledgeGraphService.Concepts with actions {
  @requires : 'KnowledgeGraph.Admin'
  action publishConcept();

  @requires : 'KnowledgeGraph.Admin'
  action unpublishConcept();
};
