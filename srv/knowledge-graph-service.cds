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
  entity Concepts                       as projection on ims.Concepts;
  @readonly entity ConceptEdges         as projection on ims.ConceptEdges;
  @readonly entity TutorialConceptLinks as projection on ims.TutorialConceptLinks;

  // ─── Type definitions ──────────────────────────────────────────────────
  type ConceptRef {
    slug        : String;
    name        : String;
    description : String;
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
  type NeighborhoodResult {
    tutorial        : TutorialInfo;
    graphVersion    : String;
    teaches         : array of ConceptRef;
    prerequisitesOf : array of TutorialRef;
    sharedConcepts  : array of TutorialRef;
    whatToLearnNext : array of TutorialRef;
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
