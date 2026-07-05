// srv/knowledge-graph-service.cds
// Knowledge-graph query + curation surface — PR 5 of issue #381.
//
// Auth posture (revised 2026-06-28, corrected 2026-07-01 in #853): the read
// surface is PUBLIC. Anonymous readers must reach `neighborhood` (powers the
// tutorial sidebar at /tutorials/*/) and the three projections
// (PublishedConcepts powers the /explore page's node list). Admin actions
// carry their own @requires : 'KnowledgeGraph.Admin'.
//
// IMPORTANT: `@requires : 'any'` is the CDS pseudo-role for "no auth needed"
// (see cap.cloud.sap/docs/guides/security/authorization#pseudo-roles).
// Without it, CAP's default posture with `auth.kind: xsuaa` is "authenticated
// required" — dropping a service-level annotation silently reverts to that
// default and yields 401 for anonymous callers. #726 removed the old
// `@requires : 'authenticated-user'` but didn't replace it with `'any'`,
// which is why the widget was requiring login (issue #853).
//
// What protects the writable `Concepts` projection now that the service is
// anonymous-readable:
//   1. CREATE/DELETE are blocked at the OData layer by
//      Capabilities.InsertRestrictions/DeleteRestrictions in
//      app/admin-annotations.cds (search for `KnowledgeGraphService.Concepts`).
//      CAP returns 405 on POST/DELETE attempts.
//   2. UPDATE is policed imperatively by the before('UPDATE', 'Concepts')
//      handler in srv/knowledge-graph-service.js, which asserts
//      req.user.is('KnowledgeGraph.Admin') BEFORE the field allowlist check
//      runs — so anonymous PATCH returns 403 without touching the DB.
//
// Phase 1 ships `neighborhood`; `pathBetween` and `conceptsForUser` declare
// the Phase 2 contract so clients can compile against a stable surface, but
// the runtime returns empty results.

using { com.sap.developers.ims as ims } from '../db/knowledge-graph';

@requires : 'any'
@graphql
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
    effortLevel   : Integer;            // discovery-mission only (Phase 4.3)
    categoryLabel : String;             // discovery-mission only (Phase 4.3)
    channelTitle  : String;             // video only (Phase 4.4)
    publishedAt   : Timestamp;          // video only (Phase 4.4) — DIFFERENT FROM blog's postedAt
    thumbnailUrl  : String;             // video only (Phase 4.4)
    // Phase 4.5 (#746): api-doc rows on the sidebar carry category + apiType
    // instead of channel/published/thumbnail (videos).
    category      : String;             // api-doc only (Phase 4.5)
    apiType       : String;             // api-doc only (Phase 4.5)
    // Phase 4.6 (#747): sample rows carry language + stars + lastCommitAt
    // instead of channel/published/thumbnail (videos) or category/apiType (api-docs).
    language      : String;             // sample only (Phase 4.6)
    stars         : Integer;            // sample only (Phase 4.6)
    lastCommitAt  : Timestamp;          // sample only (Phase 4.6)
    // Phase 4.7 (#748) + #860: help-doc rows carry source + product + anchor + snippet
    // + sourceLabel derived at payload time. anchor is optional (may be null).
    source        : String;             // help-doc only: 'help-sap-com' | 'cap-cloud-sap' | 'ui5-sap-com' | 'architecture-sap-com'
    sourceLabel   : String;             // help-doc only: 'SAP Help' | 'CAP' | 'UI5' | 'Architecture Center'
    product       : String;             // help-doc only (Phase 4.7)
    anchor        : String;             // help-doc only (Phase 4.7) — optional
    anchorLabel   : String;             // help-doc only (Phase 4.7) — derived (title-case of anchor)
    snippet       : String;             // help-doc only (Phase 4.7) — first ~120 chars of description
    // Phase 4.8 (#765): community-event rows carry eventType + location + scope +
    // virtualOrInPerson + startDate + endDate.
    eventType         : String(20);   // 'codejam' | 'teched' | 'devtoberfest' | 'usergroup'
    location          : String(500);
    scope             : String(20);
    virtualOrInPerson : String(20);
    startDate         : Date;
    endDate           : Date;
    overlapCount  : Integer;
    // Task 4 of #850 (KG-widget redesign): server-composed meta-text string
    // for the sidebar. Stamped by the neighborhood handler via
    // RESOURCE_TYPE_CONFIG's per-type `renderMeta`. Client renders as-is,
    // keeping the per-row template a pure function (no v-if r.type chain).
    metaText      : String(160);
  }
  // TypeConfigEntry — server-owned resource-type registry entry (Task 4 of
  // #850). Mirrors `RESOURCE_TYPE_CONFIG` in srv/lib/kg-resource-type-config.js
  // MINUS `renderMeta` (the meta-text function isn't wire-serialisable; the
  // server evaluates it per row and ships `metaText` instead).
  type TypeConfigEntry {
    type          : String(30);
    icon          : String(8);
    singular      : String(40);
    plural        : String(40);
    priority      : Integer;
    metaTemplate  : String(120);
  }
  type NeighborhoodResult {
    tutorial        : TutorialInfo;
    graphVersion    : String;
    teaches         : array of ConceptRef;
    prerequisitesOf : array of TutorialRef;
    sharedConcepts  : array of TutorialRef;
    whatToLearnNext : array of TutorialRef;
    otherResources  : array of OtherResource;  // Phase 4 chassis (#447); empty in PR-1, populated in PR-2.
    // Task 4 of #850: server-owned resource-type registry copy so the client
    // renderer stays type-agnostic. Sorted by `priority` ascending; excludes
    // the `renderMeta` function (see TypeConfigEntry).
    typeConfig      : array of TypeConfigEntry;
  }
  // Task 5 of #850 (KG-widget redesign): per-type bucket for the
  // ExpandedPanel dialog. Instead of the sidebar's merged flat top-5, the
  // full-panel handler returns each of the 6 external-resource corpora as
  // its own bucket with a larger per-type cap
  // (KG_NEIGHBORHOOD_FULL_PER_TYPE_LIMIT, default 15). Empty corpora are
  // omitted from the array — the client renders only sections with rows.
  type OtherResourcesByTypeEntry {
    type   : String(30);
    config : TypeConfigEntry;
    items  : array of OtherResource;
  }
  // Task 5 of #850: response envelope for /graph/neighborhoodFull. Same
  // gating and shared ranker as /graph/neighborhood; larger per-section
  // caps (up to 30 tutorial refs vs the sidebar's 10) and per-type
  // buckets for external resources rather than a merged top-5. Notably
  // does NOT carry `teaches` — the redesign moves the concept list into
  // the sidebar only; the expanded panel focuses on tutorial + external
  // resource neighbourhoods.
  type NeighborhoodFullResult {
    tutorial              : TutorialInfo;
    graphVersion          : String;
    prerequisitesOf       : array of TutorialRef;
    sharedConcepts        : array of TutorialRef;
    whatToLearnNext       : array of TutorialRef;
    otherResourcesByType  : array of OtherResourcesByTypeEntry;
    typeConfig            : array of TypeConfigEntry;
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
  // Task 5 of #850: expanded-panel data source. Per-type buckets with
  // larger caps for the /tutorials/*/ ExpandedPanel dialog.
  function neighborhoodFull(slug : String)                    returns NeighborhoodFullResult;
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

// #918 — virtual `isolated` flag populated by the after('READ', 'Concepts')
// decorator in srv/knowledge-graph-service.js. True iff a KgIsolation row
// exists for this concept slug (WCC size <= KG_WCC_ISOLATION_THRESHOLD).
// Fail-quiet at read time: if the SELECT throws or the sidecar is missing,
// stays null (Fiori renders `null` boolean as no badge). Added via
// `extend ... with columns` so the base projection line stays a
// legal-syntax `projection on ... excluding { embedding }`.
extend KnowledgeGraphService.Concepts with columns {
  virtual isolated : Boolean
};
