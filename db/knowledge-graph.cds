namespace com.sap.developers.ims;

using { managed, cuid } from '@sap/cds/common';
using { com.sap.developers.ims as base } from './schema';

/**
 * Predicate enums — typed at the CDS layer so PR 3/4 catch typos at
 * compile time rather than runtime.
 */
type LinkPredicate : String(20) enum {
  teaches;  // Tutorial → Concept
  extends_ = 'extends';  // Tutorial → Tutorial. CDS reserves `extends`, so we alias the JS enumerator name.
}
type EdgePredicate : String(20) enum {
  requires;
  relatedTo;
}

/**
 * Canonical registry of extracted concepts.
 * AI-extracted, admin-reviewable. Slug is the stable identifier (kebab-case).
 */
entity Concepts : cuid, managed {
  slug            : String(80) @assert.unique;     // 'cap-handlers'
  name            : String(120);                    // 'CAP Service Handlers'
  description     : String(500);                    // LLM-generated, admin-editable
  embedding       : LargeBinary;                    // centroid vector for similarity merge
  status          : String(20) default 'ACTIVE';    // ACTIVE | MERGED | VETOED
  mergedInto      : Association to Concepts;        // if MERGED, points to canonical
  extractionCount : Integer default 0;              // # tutorials that contributed
  firstSeenAt     : Timestamp @cds.on.insert : $now;
  lastSeenAt      : Timestamp;                      // updated by the extractor on each touch

  links           : Composition of many TutorialConceptLinks on links.concept = $self;
  outgoingEdges   : Composition of many ConceptEdges on outgoingEdges.source = $self;
  incomingEdges   : Association to many ConceptEdges on incomingEdges.target = $self;
}

/**
 * Per-tutorial extracted concepts. Caches both content hash and concept list
 * so we skip re-extraction when tutorial content is unchanged.
 *
 * INVARIANT (enforced by PR 3 extractor; not by the schema):
 *   predicate = 'teaches'  ⇒  concept IS NOT NULL,    extendsTutorial IS NULL
 *   predicate = 'extends'  ⇒  extendsTutorial IS NOT NULL, concept IS NULL
 *
 * The @assert.unique.tutorialConcept guard catches duplicate (tutorial,
 * concept, predicate) but does NOT prevent duplicate (tutorial, NULL,
 * 'extends') rows — HANA's UNIQUE on NULL is permissive. PR 3 must enforce
 * the XOR at write time and have a hybrid-test for the negative path.
 */
entity TutorialConceptLinks : cuid, managed {
  tutorial        : Association to base.Tutorials @assert.notNull;
  concept         : Association to Concepts;        // populated when predicate='teaches'
  predicate       : LinkPredicate default 'teaches';
  extendsTutorial : Association to base.Tutorials;  // populated when predicate='extends'
  confidence      : Decimal(3, 2);                  // 0.00–1.00 from LLM self-rating
  extractedAt     : Timestamp;
  contentHash     : String(64);                     // SHA-256 of source markdown
  modelVersion    : String(40);                     // 'gpt-4o-2024-08-06'
}

/**
 * Concept-to-concept edges (requires, relatedTo). AI-extracted with confidence.
 */
entity ConceptEdges : cuid, managed {
  source       : Association to Concepts @assert.notNull;
  target       : Association to Concepts @assert.notNull;
  predicate    : EdgePredicate;
  confidence   : Decimal(3, 2);
  evidence     : String(500);                       // LLM-cited tutorial slugs / quotes
  status       : String(20) default 'ACTIVE';       // ACTIVE | VETOED
  extractedAt  : Timestamp;
  modelVersion : String(40);
}

annotate TutorialConceptLinks with @assert.unique.tutorialConcept : [tutorial, concept, predicate];
annotate ConceptEdges with @assert.unique.conceptEdge : [source, target, predicate];

/**
 * Single-row projection metadata. Updated at the end of every graphRebuild.
 * Read by the query-layer cache to mint a graphVersion cache key.
 */
entity GraphMetadata : cuid, managed {
  graphVersion  : String(40);    // ULID minted on rebuild
  lastRebuiltAt : Timestamp;
  tripleCount   : Integer;
  durationMs    : Integer;
}
